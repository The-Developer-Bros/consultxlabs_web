/**
 * Moderation bulk-cancel (#693): cancel every future engagement a suspended
 * or banned user is part of, with 100% refunds to the innocent counterparty —
 * moderation is platform-initiated, so booking-time policy tiers do not apply.
 *
 * Mirrors the CAS doctrine of app/api/appointments/[appointmentId]/cancel:
 * status moves ride a guarded updateMany (double-cancel loses the CAS and is
 * skipped), refunds run AFTER each cancel commits because refundPayment owns
 * its own Serializable tx. Every step is idempotent, so a re-run after a
 * partial failure (or budget exhaustion) is safe.
 */
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { collaboratorUserIdsForEvent } from "@/lib/collaborators/recipients";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { refundWholeEventPayments } from "@/lib/payments/operations/event-refunds";
import {
  CANCELLABLE_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
} from "@/lib/booking/transitions";

export interface BulkCancelSummary {
  engagementsCancelled: number;
  attendeeRemovals: number;
  refundsIssued: number;
  refundedPaise: number;
  failures: Array<{ kind: string; id: string; error: string }>;
  /** Work items not reached inside the time budget — safe to re-run. */
  remaining: Array<{ kind: string; id: string }>;
}

interface BulkCancelOptions {
  initiatedByUserId: string;
  notes?: string;
  /** Netlify functions are wall-clock capped; leave headroom for the rest
   *  of the best-effort phase. */
  budgetMs?: number;
}

type WorkItem =
  | { kind: "consultation" | "subscription"; id: string }
  | { kind: "webinar-event" | "class-event"; id: string }
  | { kind: "webinar-attendance" | "class-attendance"; id: string };

type FutureSlotFilter = {
  completionStatus: "SCHEDULED";
  startsAt: { gt: Date };
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const captureModerationError = (error: unknown) =>
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "moderation" } },
  );

export async function cancelFutureEngagementsForUser(
  targetUserId: string,
  { initiatedByUserId, notes, budgetMs = 15_000 }: BulkCancelOptions,
): Promise<BulkCancelSummary> {
  const deadline = Date.now() + budgetMs;
  const summary: BulkCancelSummary = {
    engagementsCancelled: 0,
    attendeeRemovals: 0,
    refundsIssued: 0,
    refundedPaise: 0,
    failures: [],
    remaining: [],
  };

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { consulteeProfileId: true, consultantProfileId: true },
  });
  if (!target) return summary;

  const futureSlot: FutureSlotFilter = {
    completionStatus: "SCHEDULED",
    startsAt: { gt: new Date() },
  };

  const work: WorkItem[] = [];
  if (target.consulteeProfileId) {
    work.push(
      ...(await collectConsulteeWork(
        target.consulteeProfileId,
        targetUserId,
        futureSlot,
      )),
    );
  }
  if (target.consultantProfileId) {
    work.push(
      ...(await collectConsultantWork(target.consultantProfileId, futureSlot)),
    );
  }

  for (let i = 0; i < work.length; i++) {
    if (Date.now() > deadline) {
      summary.remaining = work.slice(i);
      Sentry.captureMessage(
        `[moderation] bulk-cancel budget exhausted for user ${targetUserId}; ${summary.remaining.length} engagement(s) left — re-run the action to finish`,
        { tags: { subsystem: "moderation" } },
      );
      break;
    }
    await runWorkItem(work[i], targetUserId, {
      initiatedByUserId,
      notes,
      summary,
    });
  }

  return summary;
}

// Engagements where the target is the buyer (consultee): exclusive
// consultations/subscriptions they own, plus group events they merely attend.
async function collectConsulteeWork(
  consulteeProfileId: string,
  targetUserId: string,
  futureSlot: FutureSlotFilter,
): Promise<WorkItem[]> {
  const [consultations, subscriptions, attendedSlots] = await Promise.all([
    prisma.consultation.findMany({
      where: {
        requestedById: consulteeProfileId,
        status: { in: [...CANCELLABLE_FROM] },
        appointment: { slotsOfAppointment: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.subscription.findMany({
      where: {
        requestedById: consulteeProfileId,
        status: { in: [...CANCELLABLE_FROM] },
        appointments: { some: { slotsOfAppointment: { some: futureSlot } } },
      },
      select: { id: true },
    }),
    // Group events the target merely attends — remove + refund just them.
    prisma.slotOfAppointment.findMany({
      where: {
        ...futureSlot,
        user: { some: { id: targetUserId } },
        appointment: {
          OR: [{ webinarId: { not: null } }, { classId: { not: null } }],
        },
      },
      select: {
        appointment: { select: { webinarId: true, classId: true } },
      },
    }),
  ]);

  const work: WorkItem[] = [
    ...consultations.map((c) => ({ kind: "consultation" as const, id: c.id })),
    ...subscriptions.map((s) => ({ kind: "subscription" as const, id: s.id })),
  ];
  const webinarIds = new Set<string>();
  const classIds = new Set<string>();
  for (const slot of attendedSlots) {
    if (slot.appointment?.webinarId) webinarIds.add(slot.appointment.webinarId);
    if (slot.appointment?.classId) classIds.add(slot.appointment.classId);
  }
  work.push(
    ...Array.from(webinarIds, (id) => ({
      kind: "webinar-attendance" as const,
      id,
    })),
    ...Array.from(classIds, (id) => ({
      kind: "class-attendance" as const,
      id,
    })),
  );
  return work;
}

// Engagements the target hosts (consultant): exclusive engagements plus whole
// group events they run — every attendee is refunded when these cancel.
async function collectConsultantWork(
  consultantProfileId: string,
  futureSlot: FutureSlotFilter,
): Promise<WorkItem[]> {
  const [consultations, subscriptions, webinars, classes] = await Promise.all([
    prisma.consultation.findMany({
      where: {
        consultationPlan: { consultantProfileId },
        status: { in: [...CANCELLABLE_FROM] },
        appointment: { slotsOfAppointment: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.subscription.findMany({
      where: {
        subscriptionPlan: { consultantProfileId },
        status: { in: [...CANCELLABLE_FROM] },
        appointments: { some: { slotsOfAppointment: { some: futureSlot } } },
      },
      select: { id: true },
    }),
    prisma.webinar.findMany({
      where: {
        webinarPlan: { consultantProfileId },
        status: { in: EVENT_ALLOWED_FROM.CANCELLED },
        appointment: { slotsOfAppointment: { some: futureSlot } },
      },
      select: { id: true },
    }),
    prisma.class.findMany({
      where: {
        classPlan: { consultantProfileId },
        status: { in: CLASS_EVENT_ALLOWED_FROM.CANCELLED },
        appointments: { some: { slotsOfAppointment: { some: futureSlot } } },
      },
      select: { id: true },
    }),
  ]);
  return [
    ...consultations.map((c) => ({ kind: "consultation" as const, id: c.id })),
    ...subscriptions.map((s) => ({ kind: "subscription" as const, id: s.id })),
    ...webinars.map((w) => ({ kind: "webinar-event" as const, id: w.id })),
    ...classes.map((c) => ({ kind: "class-event" as const, id: c.id })),
  ];
}

// Dispatch a single work item; every failure is recorded and swallowed so the
// budgeted loop continues to the next engagement.
async function runWorkItem(
  item: WorkItem,
  targetUserId: string,
  ctx: {
    initiatedByUserId: string;
    notes?: string;
    summary: BulkCancelSummary;
  },
): Promise<void> {
  const { initiatedByUserId, notes, summary } = ctx;
  try {
    switch (item.kind) {
      case "consultation":
      case "subscription":
        await cancelExclusiveEngagement(item.kind, item.id, {
          initiatedByUserId,
          notes,
          summary,
        });
        break;
      case "webinar-event":
      case "class-event":
        await cancelGroupEvent(item.kind, item.id, {
          initiatedByUserId,
          summary,
        });
        break;
      case "webinar-attendance":
      case "class-attendance":
        await removeAttendee(item.kind, item.id, targetUserId, {
          initiatedByUserId,
          summary,
        });
        break;
    }
  } catch (error) {
    summary.failures.push({
      kind: item.kind,
      id: item.id,
      error: errMsg(error),
    });
    captureModerationError(error);
  }
}

interface NormalizedEngagement {
  planTitle?: string;
  consultantUser?: { id: string; name: string | null } | null;
  consulteeUser?: { id: string; name: string | null } | null;
  appointments: Array<{
    id: string;
    appointmentType: string;
    organizationId: string | null;
    // amount is number at runtime — the extended client converts BigInt on read
    payment: Array<{
      id: string;
      amount: number;
      paymentStatus: string;
      deletedAt: Date | null;
    }>;
  }>;
}

async function loadExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
): Promise<NormalizedEngagement | null> {
  const planSelect = {
    select: {
      title: true,
      consultantProfile: {
        select: { user: { select: { id: true, name: true } } },
      },
    },
  } as const;
  const requestedBySelect = {
    select: { user: { select: { id: true, name: true } } },
  } as const;
  const appointmentSelect = {
    select: {
      id: true,
      appointmentType: true,
      // ADR 23 — attribute the cancellation notification to the dashboard that
      // owns the session rather than defaulting everyone to their personal one.
      organizationId: true,
      payment: {
        select: {
          id: true,
          amount: true,
          paymentStatus: true,
          // #781 §B — the refund front door refuses retired rows; carry the
          // tombstone so the caller can skip them instead of failing on them.
          deletedAt: true,
        },
      },
    },
  } as const;

  if (kind === "consultation") {
    const row = await prisma.consultation.findUnique({
      where: { id: engagementId },
      select: {
        consultationPlan: planSelect,
        requestedBy: requestedBySelect,
        appointment: appointmentSelect,
      },
    });
    if (!row) return null;
    return {
      planTitle: row.consultationPlan?.title,
      consultantUser: row.consultationPlan?.consultantProfile?.user,
      consulteeUser: row.requestedBy?.user,
      appointments: row.appointment ? [row.appointment] : [],
    };
  }

  const row = await prisma.subscription.findUnique({
    where: { id: engagementId },
    select: {
      subscriptionPlan: planSelect,
      requestedBy: requestedBySelect,
      appointments: appointmentSelect,
    },
  });
  if (!row) return null;
  return {
    planTitle: row.subscriptionPlan?.title,
    consultantUser: row.subscriptionPlan?.consultantProfile?.user,
    consulteeUser: row.requestedBy?.user,
    appointments: row.appointments,
  };
}

/**
 * Guarded status move plus the slot soft-cancel that rides with it. Returns 0
 * when the CAS found nothing to move — the engagement was already terminal.
 */
async function casCancelExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
  ctx: { initiatedByUserId: string; notes?: string },
): Promise<number> {
  const cancellationData = {
    status: "CANCELLED" as const,
    cancellationReason: "MODERATION" as const,
    cancellationNotes: ctx.notes ?? null,
    cancelledAt: new Date(),
    cancelledBy: ctx.initiatedByUserId,
  };

  return prisma.$transaction(async (tx) => {
    const res =
      kind === "consultation"
        ? await tx.consultation.updateMany({
            where: { id: engagementId, status: { in: [...CANCELLABLE_FROM] } },
            data: cancellationData,
          })
        : await tx.subscription.updateMany({
            where: { id: engagementId, status: { in: [...CANCELLABLE_FROM] } },
            data: cancellationData,
          });
    if (res.count === 0) return 0;
    await tx.slotOfAppointment.updateMany({
      where:
        kind === "consultation"
          ? {
              appointment: { consultationId: engagementId },
              completionStatus: "SCHEDULED",
            }
          : {
              appointment: { subscriptionId: engagementId },
              completionStatus: "SCHEDULED",
            },
      data: { completionStatus: "CANCELLED" },
    });
    return res.count;
  });
}

/**
 * Payments this cancellation owes money back on.
 *
 * #1161 — free_ (credit-funded) payments are refundable now: their "refund" is
 * the credit restoration the front door performs, so a zero-amount row can no
 * longer shadow a refundable gateway payment.
 * #781 §B — retired (soft-deleted) rows are NOT: refundBookingPayment refuses
 * them, so queueing one only mints a false failure and a Sentry event.
 */
function refundableEngagementPayments(engagement: NormalizedEngagement) {
  return engagement.appointments.flatMap((appt) =>
    appt.payment.filter(
      (p) => p.paymentStatus === "SUCCEEDED" && p.deletedAt === null,
    ),
  );
}

function notifyExclusiveCancellation(
  kind: "consultation" | "subscription",
  engagement: NormalizedEngagement,
): void {
  const userIds = [
    engagement.consultantUser?.id,
    engagement.consulteeUser?.id,
  ].filter((id): id is string => !!id);
  if (userIds.length === 0) return;

  const engagementOrgId = engagement.appointments[0]?.organizationId ?? null;
  void notifyAppointmentCancelled(userIds, {
    ...notificationScope(engagementOrgId),
    appointmentType:
      engagement.appointments[0]?.appointmentType ?? kind.toUpperCase(),
    consultantName: engagement.consultantUser?.name || "Consultant",
    consulteeName: engagement.consulteeUser?.name || "Consultee",
    // #536 — never show the customer a placeholder as the session's name.
    planTitle: planTitleOrSessionLabel(
      engagement.planTitle,
      engagement.appointments[0]?.appointmentType ?? kind,
    ),
    dashboardUrl: notificationHref(engagementOrgId, "appointments"),
    reason: "MODERATION",
    cancelledBy: "system",
  });
}

async function cancelExclusiveEngagement(
  kind: "consultation" | "subscription",
  engagementId: string,
  ctx: {
    initiatedByUserId: string;
    notes?: string;
    summary: BulkCancelSummary;
  },
) {
  const engagement = await loadExclusiveEngagement(kind, engagementId);
  if (!engagement) return;

  const moved = await casCancelExclusiveEngagement(kind, engagementId, ctx);
  if (moved === 0) return; // lost the CAS — already terminal, no refund

  ctx.summary.engagementsCancelled += 1;

  for (const p of refundableEngagementPayments(engagement)) {
    await issueFullRefund(p.id, ctx.initiatedByUserId, ctx.summary);
  }

  notifyExclusiveCancellation(kind, engagement);
}

async function cancelGroupEvent(
  kind: "webinar-event" | "class-event",
  eventId: string,
  ctx: { initiatedByUserId: string; summary: BulkCancelSummary },
) {
  const isWebinar = kind === "webinar-event";

  const moved = await prisma.$transaction(async (tx) => {
    const res = isWebinar
      ? await tx.webinar.updateMany({
          where: { id: eventId, status: { in: EVENT_ALLOWED_FROM.CANCELLED } },
          data: { status: "CANCELLED" },
        })
      : await tx.class.updateMany({
          where: {
            id: eventId,
            status: { in: CLASS_EVENT_ALLOWED_FROM.CANCELLED },
          },
          data: { status: "CANCELLED" },
        });
    if (res.count === 0) return 0;
    await tx.slotOfAppointment.updateMany({
      where: {
        appointment: isWebinar ? { webinarId: eventId } : { classId: eventId },
        completionStatus: "SCHEDULED",
      },
      data: { completionStatus: "CANCELLED" },
    });
    return res.count;
  });
  if (moved === 0) return;

  ctx.summary.engagementsCancelled += 1;

  // Whole-event moderation cancel refunds EVERY attendee in full via the
  // reversal engine (#776 §C): org-funded seats reverse in-ledger (CLASS_MULTI),
  // card/mock seats credit the gateway. The old per-payment refundPayment loop
  // failed org-funded seats (createRefund → UNKNOWN_GATEWAY on a synthetic id).
  const eventRefund = await refundWholeEventPayments(
    isWebinar ? "webinar" : "class",
    eventId,
    "moderation (100% — platform-initiated cancellation)",
    ctx.initiatedByUserId,
  );
  ctx.summary.refundsIssued += eventRefund.refundsIssued;
  ctx.summary.refundedPaise += eventRefund.refundedPaise;
  for (const f of eventRefund.failures) {
    ctx.summary.failures.push({
      kind: "refund",
      id: f.paymentId,
      error: f.error,
    });
  }

  // Light query for attendee notification (the helper doesn't return userIds).
  const attendees = await prisma.payment.findMany({
    where: {
      appointment: isWebinar ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
    },
    select: {
      userId: true,
      // Every attendee of one event shares its org-ness, so the first row
      // decides the scope for the whole batch.
      appointment: { select: { organizationId: true } },
    },
  });
  // #1580 C-P1-5 — the event's accepted collaborators lose it too.
  const collaboratorIds = await collaboratorUserIdsForEvent(
    isWebinar ? "webinar" : "class",
    eventId,
  );
  const attendeeIds = Array.from(
    new Set([...attendees.map((p) => p.userId), ...collaboratorIds]),
  );
  if (attendeeIds.length > 0) {
    const eventOrgId = attendees[0]?.appointment?.organizationId ?? null;
    void notifyAppointmentCancelled(attendeeIds, {
      ...notificationScope(eventOrgId),
      appointmentType: isWebinar ? "WEBINAR" : "CLASS",
      consultantName: "Consultant",
      consulteeName: "Attendee",
      // #536 — the event's own title is not loaded on this path, so the
      // session label stands in rather than a placeholder.
      planTitle: planTitleOrSessionLabel(null, isWebinar ? "WEBINAR" : "CLASS"),
      dashboardUrl: notificationHref(eventOrgId, "appointments"),
      reason: "MODERATION",
      cancelledBy: "system",
    });
  }
}

async function removeAttendee(
  kind: "webinar-attendance" | "class-attendance",
  eventId: string,
  targetUserId: string,
  ctx: { initiatedByUserId: string; summary: BulkCancelSummary },
) {
  const isWebinar = kind === "webinar-attendance";
  const eventFilter = isWebinar ? { webinarId: eventId } : { classId: eventId };

  const slots = await prisma.slotOfAppointment.findMany({
    where: {
      appointment: eventFilter,
      completionStatus: "SCHEDULED",
      startsAt: { gt: new Date() },
      user: { some: { id: targetUserId } },
    },
    select: { id: true },
  });
  if (slots.length === 0) return;

  await prisma.$transaction(
    slots.map((slot) =>
      prisma.slotOfAppointment.update({
        where: { id: slot.id },
        data: { user: { disconnect: { id: targetUserId } } },
      }),
    ),
  );
  ctx.summary.attendeeRemovals += 1;

  const paid = await prisma.payment.findFirst({
    where: {
      userId: targetUserId,
      appointment: eventFilter,
      paymentStatus: "SUCCEEDED",
      amount: { gt: 0 },
      // #781 §B — a retired row is refused by the front door; picking one here
      // would only mint a false refund failure.
      deletedAt: null,
    },
    select: { id: true },
  });
  if (paid) {
    await issueFullRefund(paid.id, ctx.initiatedByUserId, ctx.summary);
  }
}

async function issueFullRefund(
  paymentId: string,
  initiatedByUserId: string,
  summary: BulkCancelSummary,
) {
  try {
    // #1003 — via the rail-aware front door, not refundPayment directly: an
    // org-funded seat carries a synthetic intent that died on UNKNOWN_GATEWAY,
    // so moderation silently reversed nothing for org-sponsored bookings.
    const r = await refundBookingPayment({
      paymentId,
      // amountPaise omitted → the full refundable balance
      reason: "moderation (100% — platform-initiated cancellation)",
      initiatedByUserId,
    });
    summary.refundsIssued += 1;
    summary.refundedPaise += r.amountRefundedPaise;
  } catch (error) {
    summary.failures.push({
      kind: "refund",
      id: paymentId,
      error: errMsg(error),
    });
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "moderation" } },
    );
  }
}
