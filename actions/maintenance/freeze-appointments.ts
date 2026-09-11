"use server";

/**
 * Appointment Freeze — called when entering OFFLINE maintenance phase.
 *
 * Finds upcoming appointments within the maintenance window,
 * cancels them with a system-initiated reason, and notifies affected users.
 */

import * as Sentry from "@sentry/nextjs";

import { notifyAppointmentCancelled } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import {
  refundBookingPayment,
} from "@/lib/payments/operations/booking-refund";
import { RefundValidationError } from "@/lib/payments/operations/refund";
import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
  transitionClassEvent,
  RESCHEDULE_OPEN_STATUSES,
  SLOT_RESCHEDULABLE_FROM,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { softCancelTrialAppointment } from "@/lib/trials/cancellation";
import prisma, { type Tx } from "@/lib/prisma";

type NotificationPayload = {
  userIds: string[];
  data: Parameters<typeof notifyAppointmentCancelled>[1];
};

function buildCancellationNotification(params: {
  appointmentId: string;
  appointmentType: string;
  /** ADR 23 — routes the notification to the dashboard owning the session. */
  organizationId: string | null;
  consultantUser: { id: string; name: string | null } | null | undefined;
  participantIds: string[];
  planTitle: string;
  dateTime: string;
  consulteeName?: string;
}): NotificationPayload | null {
  const userIds = [...params.participantIds];
  if (
    params.consultantUser?.id &&
    !userIds.includes(params.consultantUser.id)
  ) {
    userIds.push(params.consultantUser.id);
  }
  if (userIds.length === 0) return null;
  return {
    userIds,
    data: {
      appointmentId: params.appointmentId,
      appointmentType: params.appointmentType,
      consultantName: params.consultantUser?.name || "Consultant",
      consulteeName: params.consulteeName || "Participants",
      planTitle: params.planTitle,
      dateTime: params.dateTime,
      ...notificationScope(params.organizationId),
      dashboardUrl: notificationHref(params.organizationId, "appointments"),
      reason: "Scheduled platform maintenance",
      cancelledBy: "system",
    },
  };
}

/** The slot graph the freeze works from — one query, typed once for the helpers. */
async function findAffectedSlots(maintenanceStart: Date, windowEnd: Date) {
  // Find all slots that overlap with the maintenance window
  return prisma.slotOfAppointment.findMany({
    where: {
      startsAt: { lte: windowEnd },
      endsAt: { gte: maintenanceStart },
      isTentative: false,
    },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
              requestedBy: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                select: {
                  title: true,
                  consultantProfile: {
                    select: { user: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
          trialSession: {
            include: {
              subscriptionPlan: {
                select: {
                  title: true,
                },
              },
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
              consulteeProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
          // #1162 — UNFILTERED by status: the old SUCCEEDED-only include made
          // an appointment whose only payment was PENDING look payment-free,
          // and the old delete guard then cascade-destroyed the Payment row.
          // Nothing is deleted any more; SUCCEEDED payments refund post-tx,
          // PENDING ones settle via the capture-after-terminal webhook path.
          // `deletedAt` rides along so the refund collector can skip retired
          // rows (#781 §B) without a second query.
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentIntent: true,
              paymentGateway: true,
              paymentStatus: true,
              deletedAt: true,
            },
          },
        },
      },
      user: { select: { id: true } },
    },
  });
}

type AffectedSlot = Awaited<ReturnType<typeof findAffectedSlots>>[number];
type FreezeAppointment = AffectedSlot["appointment"];
type PendingRefundPayment = FreezeAppointment["payment"][number];

/** Everything one appointment's freeze step needs, resolved once per appointment. */
type FreezeContext = {
  appointment: FreezeAppointment;
  slots: AffectedSlot[];
  earliestSlot: AffectedSlot;
};

/**
 * Post-commit work a freeze transaction produced. It accumulates LOCALLY
 * inside the transaction callback and is merged into the run totals only after
 * the commit — a rollback after a push must not leave a refund queued for a
 * booking that is still active.
 */
type FreezeEffects = {
  notifications: NotificationPayload[];
  refunds: PendingRefundPayment[];
  trialsToTombstone: string[];
  subscriptionIds: string[];
};

/** `null` means the row was already terminal — the whole appointment skips. */
type FreezeStepResult = FreezeEffects | null;

function noEffects(): FreezeEffects {
  return {
    notifications: [],
    refunds: [],
    trialsToTombstone: [],
    subscriptionIds: [],
  };
}

function withNotification(notif: NotificationPayload | null): FreezeEffects {
  const effects = noEffects();
  if (notif) effects.notifications.push(notif);
  return effects;
}

function mergeEffects(into: FreezeEffects, from: FreezeEffects): void {
  into.notifications.push(...from.notifications);
  into.refunds.push(...from.refunds);
  into.trialsToTombstone.push(...from.trialsToTombstone);
  into.subscriptionIds.push(...from.subscriptionIds);
}

/** A CAS transition that lost its race is a skip, never an error. */
function skipOnIllegalTransition(err: unknown): FreezeStepResult {
  if (err instanceof IllegalTransitionError) return null;
  throw err;
}

// Cancel consultation if applicable — CAS-guarded (#1162): a COMPLETED or
// already-CANCELLED booking must not resurrect.
async function freezeConsultation(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const consultation = ctx.appointment.consultation;
  if (!consultation) return noEffects();

  try {
    await transitionConsultationRequest(tx, {
      where: { id: consultation.id },
      to: "CANCELLED",
      data: {
        cancellationReason: "TECHNICAL_ISSUE",
        cancellationNotes: "Cancelled due to scheduled platform maintenance",
        cancelledAt: new Date(),
      },
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  return withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "CONSULTATION",
      consultantUser: consultation.consultationPlan?.consultantProfile?.user,
      participantIds: consultation.requestedBy?.user?.id
        ? [consultation.requestedBy.user.id]
        : [],
      planTitle: consultation.consultationPlan?.title || "Consultation",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
      consulteeName: consultation.requestedBy?.user?.name || "User",
    }),
  );
}

// Cancel subscription appointment if applicable — CAS-guarded.
async function freezeSubscription(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const subscription = ctx.appointment.subscription;
  if (!subscription) return noEffects();

  try {
    await transitionSubscriptionRequest(tx, {
      where: { id: subscription.id },
      to: "CANCELLED",
      data: {
        cancellationReason: "TECHNICAL_ISSUE",
        cancellationNotes: "Cancelled due to scheduled platform maintenance",
        cancelledAt: new Date(),
      },
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  const effects = withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "SUBSCRIPTION",
      consultantUser: subscription.subscriptionPlan?.consultantProfile?.user,
      participantIds: subscription.requestedBy?.user?.id
        ? [subscription.requestedBy.user.id]
        : [],
      planTitle: subscription.subscriptionPlan?.title || "Subscription",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
      consulteeName: subscription.requestedBy?.user?.name || "User",
    }),
  );
  effects.subscriptionIds.push(subscription.id);
  return effects;
}

/** Every seat holder on the frozen slots — group events notify all attendees. */
function attendeeIds(slots: AffectedSlot[]): string[] {
  return Array.from(new Set(slots.flatMap((s) => s.user.map((u) => u.id))));
}

// Cancel webinar if applicable
async function freezeWebinar(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const webinar = ctx.appointment.webinar;
  if (!webinar) return noEffects();

  try {
    await transitionWebinarEvent(tx, {
      where: { id: webinar.id },
      to: "CANCELLED",
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  return withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "WEBINAR",
      consultantUser: webinar.webinarPlan?.consultantProfile?.user,
      participantIds: attendeeIds(ctx.slots),
      planTitle: webinar.webinarPlan?.title || "Webinar",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
    }),
  );
}

// Cancel class if applicable
async function freezeClass(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const classEvent = ctx.appointment.class;
  if (!classEvent) return noEffects();

  try {
    await transitionClassEvent(tx, {
      where: { id: classEvent.id },
      to: "CANCELLED",
    });
  } catch (err) {
    return skipOnIllegalTransition(err);
  }

  return withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "CLASS",
      consultantUser: classEvent.classPlan?.consultantProfile?.user,
      participantIds: attendeeIds(ctx.slots),
      planTitle: classEvent.classPlan?.title || "Class",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
    }),
  );
}

// Cancel trial session if applicable
async function freezeTrial(
  tx: Tx,
  ctx: FreezeContext,
): Promise<FreezeStepResult> {
  const trial = ctx.appointment.trialSession;
  if (!trial) return noEffects();

  // Status-guarded (the trial state table is local to the trials route);
  // zero rows means already terminal — skip, never resurrect.
  const moved = await tx.trialSession.updateMany({
    where: {
      id: trial.id,
      status: { in: ["PENDING", "AWAITING_PAYMENT", "SCHEDULED"] },
    },
    data: { status: "CANCELLED", pendingPaymentUrl: null },
  });
  if (moved.count === 0) return null;

  const effects = withNotification(
    buildCancellationNotification({
      appointmentId: ctx.appointment.id,
      organizationId: ctx.appointment.organizationId,
      appointmentType: "TRIAL",
      consultantUser: trial.consultantProfile?.user,
      participantIds: trial.consulteeProfile?.user?.id
        ? [trial.consulteeProfile.user.id]
        : [],
      planTitle: trial.subscriptionPlan?.title || "Trial Session",
      dateTime: ctx.earliestSlot.startsAt.toISOString(),
      consulteeName: trial.consulteeProfile?.user?.name || "User",
    }),
  );
  // #1074 — tombstone via the trials-domain helper AFTER the tx; it owns the
  // appointment/slot shape for trials.
  effects.trialsToTombstone.push(ctx.appointment.id);
  return effects;
}

/**
 * Each appointment type gets its turn inside the transaction. A type that does
 * not apply contributes nothing; a row that is already terminal aborts the
 * whole appointment.
 */
const FREEZE_STEPS = [
  freezeConsultation,
  freezeSubscription,
  freezeWebinar,
  freezeClass,
  freezeTrial,
];

/**
 * SUCCEEDED payments still worth sending to the refund front door.
 *
 * #781 §B — retired (soft-deleted) rows are left behind: refundBookingPayment
 * refuses them, so queueing one only mints a false refund failure and a
 * Sentry event.
 */
function refundablePayments(
  payments: PendingRefundPayment[],
): PendingRefundPayment[] {
  return payments.filter(
    (p) => p.paymentStatus === "SUCCEEDED" && p.deletedAt === null,
  );
}

/**
 * #1162 — "Nothing is deleted" (docs/booking/08). Slots soft-cancel exactly
 * like the interactive cancel route; trials are tombstoned by their own helper
 * post-tx instead.
 */
async function closeFrozenSlots(tx: Tx, ctx: FreezeContext): Promise<void> {
  if (ctx.appointment.trialSession) return;
  await tx.slotOfAppointment.updateMany({
    where: {
      id: { in: ctx.slots.map((s) => s.id) },
      completionStatus: { in: SLOT_RESCHEDULABLE_FROM },
    },
    data: { completionStatus: "CANCELLED" },
  });
}

/**
 * Close any live reschedule proposal — leaving one open reserves
 * openForAppointmentId forever and lets the expiry cron act on a cancelled
 * booking (mirrors cancel/route.ts).
 */
async function declineOpenReschedules(
  tx: Tx,
  appointmentId: string,
): Promise<void> {
  await tx.rescheduleRequest.updateMany({
    where: {
      appointmentId,
      status: { in: RESCHEDULE_OPEN_STATUSES },
    },
    data: {
      status: "DECLINED",
      openForAppointmentId: null,
      resolvedAt: new Date(),
    },
  });
}

/**
 * #1162 — one SHORT transaction per appointment instead of one 60-second
 * giant: every write below is CAS-guarded and re-runnable, so a partial freeze
 * is safe (re-invoking continues where it stopped) and no single slow
 * appointment can blow a shared transaction budget.
 */
async function freezeOneAppointment(ctx: FreezeContext) {
  return prisma.$transaction(async (tx) => {
    const effects = noEffects();

    for (const step of FREEZE_STEPS) {
      const result = await step(tx, ctx);
      if (!result) return { skipped: true } as const;
      mergeEffects(effects, result);
    }

    // Collect SUCCEEDED payments for refund processing after the tx.
    effects.refunds.push(...refundablePayments(ctx.appointment.payment));

    await closeFrozenSlots(tx, ctx);
    await declineOpenReschedules(tx, ctx.appointment.id);

    return { skipped: false, ...effects } as const;
  });
}

/** Callers group by appointment, so the list always holds at least one slot. */
function earliestSlotOf(slots: AffectedSlot[]): AffectedSlot {
  let earliest = slots[0];
  for (const slot of slots) {
    if (slot.startsAt < earliest.startsAt) earliest = slot;
  }
  return earliest;
}

export async function freezeAppointments(
  maintenanceStart: Date,
  maintenanceEnd: Date | null,
) {
  // Default to 4 hours if no end time provided
  const windowEnd =
    maintenanceEnd ?? new Date(maintenanceStart.getTime() + 4 * 60 * 60 * 1000);

  const affectedSlots = await findAffectedSlots(maintenanceStart, windowEnd);

  if (affectedSlots.length === 0) {
    return {
      cancelled: 0,
      skippedAlreadyTerminal: 0,
      freezeErrors: 0,
      notified: 0,
      refundsIssued: 0,
      refundsSkippedAlreadyRefunded: 0,
      refundErrors: 0,
      subscriptionsExtended: 0,
    };
  }

  // Group slots by appointment to avoid duplicate cancellations and N+1 queries
  const slotsByAppointment: Record<string, AffectedSlot[]> = {};
  for (const slot of affectedSlots) {
    const id = slot.appointment.id;
    if (slotsByAppointment[id]) {
      slotsByAppointment[id].push(slot);
    } else {
      slotsByAppointment[id] = [slot];
    }
  }

  let cancelled = 0;
  let notified = 0;
  let refundsIssued = 0;
  let refundsSkippedAlreadyRefunded = 0;
  let refundErrors = 0;
  let subscriptionsExtended = 0;
  // Appointments whose transaction failed outright (not a terminal skip) —
  // the loop continues so one bad appointment can't abort the freeze.
  let freezeErrors = 0;

  // Track subscription IDs affected by cancellation for scheduling period extension
  const affectedSubscriptionIds = new Set<string>();

  // Refunds run AFTER the transactions commit — they do gateway I/O, which
  // never belongs inside a transaction. Only SUCCEEDED payments refund;
  // refundBookingPayment routes every rail (gateway, org_*, free_) and clamps
  // to the refundable balance (#1162).
  const pendingRefunds: PendingRefundPayment[] = [];
  // Trials tombstone through their own domain helper post-tx (#1074 rule).
  const trialAppointmentsToTombstone: string[] = [];
  let skippedAlreadyTerminal = 0;

  // Collect notification payloads to send AFTER the transaction commits.
  // External API calls (Novu) cannot be rolled back, so they must run
  // outside the transaction to avoid notifying users about cancellations
  // that were later rolled back.
  const pendingNotifications: NotificationPayload[] = [];

  for (const appointmentId of Object.keys(slotsByAppointment)) {
    try {
      const slots = slotsByAppointment[appointmentId];
      const outcome = await freezeOneAppointment({
        appointment: slots[0].appointment,
        slots,
        earliestSlot: earliestSlotOf(slots),
      });

      if (outcome.skipped) {
        skippedAlreadyTerminal++;
        continue;
      }
      pendingNotifications.push(...outcome.notifications);
      pendingRefunds.push(...outcome.refunds);
      trialAppointmentsToTombstone.push(...outcome.trialsToTombstone);
      for (const id of outcome.subscriptionIds) affectedSubscriptionIds.add(id);
      cancelled++;
    } catch (err) {
      freezeErrors++;
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "maintenance" } },
      );
      console.error(
        JSON.stringify({
          event: "maintenance_freeze_appointment_failed",
          appointmentId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  // Issue refunds AFTER the transaction commits.
  // The Payment records still exist (appointments with payments were not deleted).
  // On gateway failure a PENDING placeholder is created for the
  // reconcile-pending-refunds cron, which RECONCILES (matches an existing
  // gateway refund by amount + time window) or marks the row FAILED after
  // 24h and notifies the payer (#779) — it does NOT re-initiate the gateway
  // call, so a throw here means no money moved until an operator retries.
  // #1074 — trials tombstone through their domain helper (never deleted).
  for (const trialAppointmentId of trialAppointmentsToTombstone) {
    try {
      await softCancelTrialAppointment(trialAppointmentId);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" } });
    }
  }

  for (const payment of pendingRefunds) {
    try {
      // #1162 — the front door: refundable-balance clamp, org_*/free_ rails,
      // and its own PENDING reservation for the reconcile cron on gateway
      // failure. The old raw createRefund refunded payment.amount GROSS
      // (over-refunding partially-refunded payments) and threw
      // UNKNOWN_GATEWAY on every org-funded booking.
      await refundBookingPayment({
        paymentId: payment.id,
        reason: "Scheduled platform maintenance",
      });
      refundsIssued++;
    } catch (err) {
      if (
        err instanceof RefundValidationError &&
        err.code === "ALREADY_FULLY_REFUNDED"
      ) {
        // Re-run over an already-settled payment — the clamp held.
        refundsSkippedAlreadyRefunded++;
        continue;
      }
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" } });
      console.error(
        JSON.stringify({
          event: "maintenance_refund_failed",
          paymentId: payment.id,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
      // No manual placeholder here any more: refundBookingPayment's gateway
      // rail reserves its own PENDING row before the gateway call, so a
      // second one would double-reserve the refundable balance. The
      // reconcile-pending-refunds cron owns recovery from that reservation.
      refundErrors++;
    }
  }

  // Extend scheduling period for affected subscriptions.
  // Only extend subscriptions that still have future slots (partial cancellation).
  const subscriptionIdList = Array.from(affectedSubscriptionIds);
  if (subscriptionIdList.length > 0) {
    const maintenanceDurationMs =
      windowEnd.getTime() - maintenanceStart.getTime();
    for (const subId of subscriptionIdList) {
      try {
        const sub = await prisma.subscription.findUnique({
          where: { id: subId },
          select: { schedulingPeriodEndsAt: true },
        });
        if (sub?.schedulingPeriodEndsAt) {
          await prisma.subscription.update({
            where: { id: subId },
            data: {
              schedulingPeriodEndsAt: new Date(
                sub.schedulingPeriodEndsAt.getTime() + maintenanceDurationMs,
              ),
            },
          });
          subscriptionsExtended++;
        }
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" } });
        console.error(
          JSON.stringify({
            event: "maintenance_subscription_extend_failed",
            subscriptionId: subId,
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  // Send all notifications AFTER the transaction commits.
  // Fire-and-forget: notification failures don't affect the freeze result.
  for (const { userIds, data } of pendingNotifications) {
    try {
      await notifyAppointmentCancelled(userIds, data);
      notified += userIds.length;
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "maintenance" }, level: "warning" });
      console.error(
        JSON.stringify({
          event: "maintenance_freeze_notification_failed",
          appointmentId: data.appointmentId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "maintenance_appointments_frozen",
      cancelled,
      skippedAlreadyTerminal,
      freezeErrors,
      notified,
      refundsIssued,
      refundsSkippedAlreadyRefunded,
      refundErrors,
      subscriptionsExtended,
      windowStart: maintenanceStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      timestamp: new Date().toISOString(),
    }),
  );

  return {
    cancelled,
    skippedAlreadyTerminal,
    freezeErrors,
    notified,
    refundsIssued,
    refundsSkippedAlreadyRefunded,
    refundErrors,
    subscriptionsExtended,
  };
}
