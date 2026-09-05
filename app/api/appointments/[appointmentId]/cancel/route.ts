import * as Sentry from "@sentry/nextjs";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";
import { setParticipantStatus } from "@/lib/booking/participants";
import prisma, { type Tx } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { CancellationReason } from "@prisma/client";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { CancelAppointmentSchema } from "@/schemas/appointments";
import {
  logConsultationCancelled,
  logSubscriptionCancelled,
} from "@/lib/activity/log-activity";

import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  refundBookingPayment,
  type FundingRail,
} from "@/lib/payments/operations/booking-refund";
import { isOrgAdminOfAppointment } from "@/lib/booking/org-actor";
import { resolveBookingRefundContext } from "@/lib/booking/cancellation-scope";
import {
  refundWholeEventPayments,
  type WholeEventRefundSummary,
} from "@/lib/payments/operations/event-refunds";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import {
  CANCELLABLE_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
  RESCHEDULE_OPEN_STATUSES,
  SLOT_RESCHEDULABLE_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionRescheduleRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

/** Audit attribution shared by every CAS this cancel drives (#1322 A12). */
type CancelAuditMeta = {
  actorUserId: string;
  reason: string | null;
  organizationId: string | null;
};

/**
 * Which rows this cancel sweeps. A whole-subscription or whole-class cancel
 * also ends the sessions of its sibling appointments; every other booking ends
 * only its own. The slot sweep and the participant sweep must never disagree
 * about that, so both read the scope from here (#1383).
 */
function cancelSweepScope(appointment: {
  id: string;
  subscription: { id: string } | null;
  class: { id: string } | null;
}) {
  if (appointment.subscription) {
    return { appointment: { subscriptionId: appointment.subscription.id } };
  }
  if (appointment.class) {
    return { appointment: { classId: appointment.class.id } };
  }
  // Consultation/webinar/trial — single appointment.
  return { appointmentId: appointment.id };
}

/**
 * Close any live reschedule proposal on a booking being cancelled. Leaving one
 * open would keep `openForAppointmentId` reserved forever and let the expiry
 * cron act on a cancelled booking. The helper CASes one row by id — hence the
 * read — and releases the reservation itself on every terminal target, so
 * `data` carries nothing here (#1383).
 */
async function declineOpenReschedules(
  tx: Pick<Tx, "rescheduleRequest" | "bookingStatusHistory">,
  appointmentId: string,
  auditMeta: CancelAuditMeta,
): Promise<void> {
  const openProposals = await tx.rescheduleRequest.findMany({
    where: { appointmentId, status: { in: RESCHEDULE_OPEN_STATUSES } },
    select: { id: true },
  });
  for (const proposal of openProposals) {
    try {
      await transitionRescheduleRequest(tx, {
        ...auditMeta,
        appointmentId,
        where: { id: proposal.id },
        to: "DECLINED",
        fromIn: RESCHEDULE_OPEN_STATUSES,
      });
    } catch (err) {
      // The expiry cron holds no appointment lock, so it can answer a
      // proposal between the read above and this CAS. Either way the
      // booking ends with no open proposal, which is the whole point;
      // failing the cancel over it would be the wrong outcome.
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // #1319 — this route triggers refunds/reallocation and had no limiter.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const { appointmentId } = await params;

    // Parse optional request body for cancellation reason
    let validatedData: { reason?: string; notes?: string } = {};
    try {
      const text = await request.text();
      if (text) {
        const parsed = JSON.parse(text);
        const result = CancelAppointmentSchema.safeParse(parsed);
        if (!result.success) {
          return NextResponse.json(
            { error: "Validation failed", details: result.error.issues },
            { status: 400 },
          );
        }
        validatedData = result.data;
      }
    } catch {
      // Body parsing is optional - continue without it
    }

    // Fetch appointment BEFORE transaction to avoid timeout on heavy queries
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { id: true, name: true } } },
                },
              },
            },
          },
        },
        // Notification copy only. The refund tier reads the whole booking's
        // next undelivered session instead (#1006, cancellation-scope.ts) —
        // this row's earliest slot is the wrong answer for a subscription.
        slotsOfAppointment: {
          take: 1,
          orderBy: { startsAt: "asc" },
          select: { startsAt: true },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    // Participant authorization check
    const consultantProfileId = session.user.consultantProfileId;
    const consulteeProfileId = session.user.consulteeProfileId;

    let isParticipant = false;

    if (appointment.consultation) {
      const planConsultantProfileId =
        appointment.consultation.consultationPlan?.consultantProfileId;
      isParticipant =
        consultantProfileId === planConsultantProfileId ||
        consulteeProfileId === appointment.consultation.requestedById;
    } else if (appointment.subscription) {
      const planConsultantProfileId =
        appointment.subscription.subscriptionPlan?.consultantProfileId;
      isParticipant =
        consultantProfileId === planConsultantProfileId ||
        consulteeProfileId === appointment.subscription.requestedById;
    } else if (appointment.webinar) {
      // Only the consultant (organizer) can cancel a group event
      const webinarConsultantId =
        appointment.webinar.webinarPlan?.consultantProfileId;
      isParticipant = consultantProfileId === webinarConsultantId;
    } else if (appointment.class) {
      // Only the consultant (organizer) can cancel a group event
      const classConsultantId =
        appointment.class.classPlan?.consultantProfileId;
      isParticipant = consultantProfileId === classConsultantId;
    }

    const isPrivilegedUser = isPrivileged(session.user.role);

    // #1166 — an admin of the org that FUNDS this booking may cancel it. They
    // act on the payer side: the tier logic below must never read them as
    // consultant-initiated.
    const isOrgAdminActor =
      !isParticipant &&
      !isPrivilegedUser &&
      (await isOrgAdminOfAppointment(
        session.user.id,
        appointment.organizationId,
      ));

    if (!isParticipant && !isPrivilegedUser && !isOrgAdminActor) {
      return NextResponse.json(
        { error: "You are not authorized to cancel this appointment" },
        { status: 403 },
      );
    }

    // Extract notification data BEFORE transaction (appointment will be deleted)
    let consultantUserId: string | undefined;
    let consulteeUserId: string | undefined;
    let consultantName: string | undefined;
    let consulteeName: string | undefined;
    let planTitle: string | undefined;
    const appointmentType: string = appointment.appointmentType;
    const dateTime =
      appointment.slotsOfAppointment?.[0]?.startsAt?.toISOString();

    if (appointment.consultation) {
      consultantUserId =
        appointment.consultation.consultationPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.consultation.requestedBy?.user?.id;
      consultantName =
        appointment.consultation.consultationPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.consultation.requestedBy?.user?.name || undefined;
      planTitle = appointment.consultation.consultationPlan?.title;
    } else if (appointment.subscription) {
      consultantUserId =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.subscription.requestedBy?.user?.id;
      consultantName =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.subscription.requestedBy?.user?.name || undefined;
      planTitle = appointment.subscription.subscriptionPlan?.title;
    } else if (appointment.webinar || appointment.class) {
      // #1003 — group events had no recipients assembled at all, so cancelling
      // one told nobody. The organiser is the consultant on the plan; the
      // attendees are gathered after the refund fan-out below.
      const plan =
        appointment.webinar?.webinarPlan ?? appointment.class?.classPlan;
      consultantUserId = plan?.consultantProfile?.user?.id;
      consultantName = plan?.consultantProfile?.user?.name || undefined;
      planTitle = plan?.title;
    }

    // #1008 — refuse to cancel while a dispute is live on this appointment: the
    // cancel would fire refunds that double-pay against a gateway chargeback.
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be cancelled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    const isExclusiveType =
      !!appointment.consultation || !!appointment.subscription;

    // #1006 — resolve the refund facts BEFORE the transaction, alongside the
    // rest of the pre-transaction fetch.
    //
    // This read MUST precede the cancel: the transaction below stamps every
    // SCHEDULED/RESCHEDULED slot CANCELLED, and "which session is still owed"
    // is derived from exactly those two statuses. Resolved afterwards, the
    // booking always looks like it has no live session left, every
    // consultee-initiated cancellation falls to the 0% tier, and the refund is
    // silently skipped. It reads no transaction state, so hoisting it costs
    // nothing; the alternative — teaching the resolver to treat slots
    // cancelled by this very run as live — would couple it to one call site.
    const bookingCtx = isExclusiveType
      ? await resolveBookingRefundContext({
          appointmentId,
          consultationId: appointment.consultationId,
          subscriptionId: appointment.subscriptionId,
        })
      : null;

    // Prepare cancellation data. `status` is NOT here: the transition helpers
    // own that column, and their `data` type excludes it so a caller cannot
    // write a status past the CAS.
    const cancellationData = {
      cancellationReason: (validatedData.reason as CancellationReason) || null,
      cancellationNotes: validatedData.notes || null,
      cancelledAt: new Date(),
      cancelledBy: session.user.id,
    };

    // Audit attribution for every BookingStatusHistory row this cancel writes
    // (#1322 A12). `appointmentId` is added per call site rather than here: a
    // subscription/class cancel sweeps slots belonging to sibling appointments,
    // and stamping this appointment on those rows would file another session's
    // history under this booking's timeline.
    const auditMeta: CancelAuditMeta = {
      actorUserId: session.user.id,
      reason: validatedData.reason ?? null,
      organizationId: appointment.organizationId,
    };

    // One scope for both sweeps below, resolved before the transaction opens.
    const sweepScope = cancelSweepScope(appointment);

    // Cancellable from-states: never COMPLETED (history), never CANCELLED
    // (idempotency — a double-cancel must not re-run refunds), never
    // REJECTED/EXPIRED (nothing to cancel). The guard rides the WHERE and is
    // re-evaluated under the row lock (B2/B16 — the #825 CAS doctrine), so a
    // cancel racing the capture webhook resolves to exactly one winner.
    // The set lives in lib/booking/transitions.ts so the map is canonical (#836).

    // Transaction for critical database operations only (with increased timeout)
    // #1319 — serialize lifecycle mutations per appointment (lock order:
    // appointment first, before any consultee/slot key a future change adds).
    const result = await withAppointmentLock(appointmentId, () =>
      prisma.$transaction(
        async (tx) => {
          // Update appointment status based on type — through the CAS helpers,
          // which bake the same allowed-from set into the WHERE and append the
          // BookingStatusHistory row this route used to skip entirely.
          let moved = false;
          try {
            if (appointment.consultation) {
              await transitionConsultationRequest(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.consultation.id },
                to: "CANCELLED",
                data: cancellationData,
                fromIn: [...CANCELLABLE_FROM],
              });
              moved = true;
            } else if (appointment.subscription) {
              await transitionSubscriptionRequest(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.subscription.id },
                to: "CANCELLED",
                data: cancellationData,
                fromIn: [...CANCELLABLE_FROM],
              });
              moved = true;
            } else if (appointment.webinar) {
              // Explicit allowed-from (was notIn) — robust against future enum
              // additions (#837).
              await transitionWebinarEvent(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.webinar.id },
                to: "CANCELLED",
                fromIn: EVENT_ALLOWED_FROM.CANCELLED,
              });
              moved = true;
            } else if (appointment.class) {
              await transitionClassEvent(tx, {
                ...auditMeta,
                appointmentId,
                where: { id: appointment.class.id },
                to: "CANCELLED",
                fromIn: CLASS_EVENT_ALLOWED_FROM.CANCELLED,
              });
              moved = true;
            }
          } catch (err) {
            // The helper's zero-row throw IS the old `moved === 0`; the client
            // contract stays NOT_CANCELLABLE rather than ILLEGAL_TRANSITION.
            if (!(err instanceof IllegalTransitionError)) throw err;
          }
          if (!moved) {
            throw Object.assign(
              new Error(
                "This appointment can no longer be cancelled (already cancelled, completed, or expired).",
              ),
              { httpStatus: 409, code: "NOT_CANCELLABLE" },
            );
          }

          // Soft-cancel: mark slots as CANCELLED instead of deleting.
          // CRITICAL: Do NOT delete appointments — Payment records have onDelete: Cascade
          // and deleting appointments would permanently destroy payment/refund/dispute audit trail.
          //
          // RESCHEDULED counts too. A slot released by a pending reschedule is not
          // SCHEDULED, so filtering on SCHEDULED alone left those rows in a
          // non-terminal state on a booking that no longer exists — and proposals
          // hang off exactly those rows.
          //
          // The from-set rides in `fromIn`, never in `where`: the helper
          // overwrites `completionStatus` in the caller's WHERE with its own
          // from-set, so a status left there is silently discarded.
          await transitionSlotCompletion(tx, {
            ...auditMeta,
            where: sweepScope,
            to: "CANCELLED",
            // The tombstone is half of the soft-cancel: without it the row
            // still occupies the consultant's calendar for every reader that
            // filters on `deletedAt: null` (#676 A10, the shape
            // cleanup-abandoned-payments already writes).
            data: { deletedAt: new Date() },
            fromIn: [...SLOT_RESCHEDULABLE_FROM],
            // A booking whose sessions are all delivered or already terminal
            // is still cancellable; matching no live slot is not a conflict.
            allowZero: true,
          });
          // #1319 A9 — every participant of the cancelled engagement.
          await setParticipantStatus(tx, sweepScope, "CANCELLED");

          await declineOpenReschedules(tx, appointmentId, auditMeta);

          return {
            success: true,
            cancellationReason: validatedData.reason,
            cancelledAt: cancellationData.cancelledAt,
            webinarId: appointment.webinar?.id,
            classId: appointment.class?.id,
          };
        },
        {
          maxWait: 10000, // Max time to wait for connection
          timeout: 30000, // 30 second transaction timeout (was 5s default)
        },
      ),
    );

    // B1 — policy-driven refund, AFTER the cancel tx commits (the refund runs
    // its own Serializable tx; the CAS above guarantees this block runs at most
    // once per appointment — a second cancel 409s before reaching it).
    // Scope here: consultation/subscription (single-payment, policy-tiered).
    // Whole-event class/webinar refunds are handled just below via the
    // reversal engine (#776 §C).
    let refund: {
      amountRefundedPaise: number;
      refundPct: number;
      /**
       * What actually happened to the money. `amountRefundedPaise: 0` alone is
       * ambiguous — it is equally "the policy owes nothing", "the balance was
       * already exhausted" and "the gateway refused" — and the client was left
       * inferring failure from a positive `refundPct`, which is a guess.
       */
      status:
        | "REFUNDED"
        | "FAILED"
        | "NOTHING_REFUNDABLE"
        | "POLICY_ZERO"
        | "MANUAL_REVIEW";
      /** #1006 — set when the refund needs a human, not a formula. */
      requiresManualReview?: boolean;
      /**
       * Which rail returned the money. The client renders a different sentence
       * per rail — an org-funded cancellation credits the org's balance, not
       * the learner's card — and `refundBookingPayment` already answers this;
       * dropping it left the UI guessing "card, 5–7 working days" for all three.
       */
      rail?: FundingRail;
    } | null = null;
    if (bookingCtx) {
      const paidPayment = bookingCtx.paidPayment;
      if (paidPayment) {
        // "Not the buyer's choice" is the real question the tier asks, and a
        // platform-initiated cancellation is not the buyer's choice either.
        // Requiring the actor to BE the consultant meant an admin cancelling
        // in the final hours settled a buyer who never asked at 0%, while
        // `cancel-user-engagements.ts` settles the same platform act at 100%.
        const isConsultantInitiated =
          (session.user.consultantProfileId !== null &&
            session.user.consultantProfileId !== undefined &&
            session.user.id !== undefined &&
            consultantUserId === session.user.id) ||
          (isPrivilegedUser && session.user.id !== consulteeUserId);
        // #1161 — a fully-credit-funded booking: its refund IS the credit
        // restoration, all-or-nothing. Full restoration when the cancellation
        // is not the buyer's choice or falls in a full-refund window; a
        // payer-initiated late cancel escalates (partial credit restoration is
        // an unmade product call — same residual as attendee-leave).
        const isFreeCreditFunded =
          paidPayment.amountPaise === 0 &&
          paidPayment.paymentIntent.startsWith("free_");
        // #1319 — the notice tier, the #1006 per-session proration and the
        // clamp to the remaining refundable balance all live in
        // `quoteBookingRefund`, which the cancel preview calls too. The two
        // used to compute the same four steps inline in two files; the preview
        // exists to tell the buyer what this click pays, so they must be one
        // function or the quote eventually stops matching the charge.
        const quote = quoteBookingRefund({
          policySnapshot: bookingCtx.policySnapshot,
          hoursUntilNextSession: bookingCtx.hoursUntilNextSession,
          slotsTotal: bookingCtx.slotsTotal,
          sessionsRemaining: bookingCtx.sessionsRemaining,
          isSubscription: !!appointment.subscription,
          isConsultantInitiated,
          grossPaise: paidPayment.amountPaise,
          refundablePaise: paidPayment.refundablePaise,
        });
        const refundPct = quote.refundPct;
        const refundAmount = quote.refundPaise;

        // Credit-funded first: its refund is a credit restoration, which is
        // all-or-nothing, so the tiered amount above does not apply to it.
        // (#1006's partly-consumed escalation used to branch here; the linear
        // proration in `proratedBasePaise` replaced it — see the PR for why.)
        if (isFreeCreditFunded) {
          if (refundPct === 100) {
            try {
              const restored = await refundBookingPayment({
                paymentId: paidPayment.id,
                reason:
                  "cancellation (credit-funded booking, full restoration)",
                initiatedByUserId: session.user.id,
              });
              refund = {
                // Report what the restoration actually returned. Hardcoding 0
                // reintroduced the ambiguity this field exists to remove — the
                // status says REFUNDED while the amount reads like the policy
                // owed nothing.
                amountRefundedPaise: restored.amountRefundedPaise,
                refundPct: 100,
                status: "REFUNDED",
                requiresManualReview: false,
                rail: restored.rail,
              };
            } catch (freeErr) {
              Sentry.captureException(
                freeErr instanceof Error ? freeErr : new Error(String(freeErr)),
                { tags: { subsystem: "bookings" } },
              );
              refund = {
                amountRefundedPaise: 0,
                refundPct: 100,
                status: "FAILED",
                requiresManualReview: true,
              };
            }
          } else {
            await recordSystemError({
              organizationId: appointment.organizationId ?? null,
              category: "PAYMENT",
              summary:
                "Credit-funded booking cancelled inside a partial-refund window; partial credit restoration has no product rule yet (#1161)",
              err: new Error("FREE_CREDIT_PARTIAL_RESTORATION_UNDEFINED"),
              context: { appointmentId, paymentId: paidPayment.id, refundPct },
            }).catch(() => {});
            refund = {
              amountRefundedPaise: 0,
              refundPct,
              status: "MANUAL_REVIEW",
              requiresManualReview: true,
            };
          }
        } else if (refundAmount > 0) {
          try {
            const r = await refundBookingPayment({
              paymentId: paidPayment.id,
              amountPaise: refundAmount,
              reason: `cancellation (${refundPct}% per booking-time policy, ${
                isConsultantInitiated ? "consultant" : "consultee"
              }-initiated)`,
              initiatedByUserId: session.user.id,
            });
            refund = {
              amountRefundedPaise: r.amountRefundedPaise,
              refundPct,
              status: "REFUNDED",
              rail: r.rail,
            };
          } catch (refundErr) {
            // The cancellation itself stands; a failed refund must be visible,
            // not silently swallowed. Sentry alone is not a queue — this is
            // money owed on a booking that is already cancelled, so it lands on
            // the same durable ops surface as the proration escalation.
            Sentry.captureException(
              refundErr instanceof Error
                ? refundErr
                : new Error(String(refundErr)),
              { tags: { subsystem: "appointments" } },
            );
            console.error(
              `[cancel] refund failed for payment ${paidPayment.id}:`,
              refundErr,
            );
            await recordSystemError({
              organizationId: appointment.organizationId ?? null,
              category: "PAYMENT",
              summary:
                `Cancellation refund failed for payment ${paidPayment.id}; ` +
                `${refundPct}% of ${paidPayment.amountPaise} paise is still owed`,
              err: refundErr,
              context: {
                appointmentId,
                paymentId: paidPayment.id,
                refundPct,
                attemptedPaise: refundAmount,
                refundablePaise: paidPayment.refundablePaise,
              },
            }).catch(() => {});
            refund = { amountRefundedPaise: 0, refundPct, status: "FAILED" };
          }
        } else {
          // Two different facts, and the buyer is owed different words for
          // each: the policy tier is genuinely zero, or the tier is positive
          // but nothing is left to give back.
          refund = {
            amountRefundedPaise: 0,
            refundPct,
            status:
              refundPct > 0 && paidPayment.refundablePaise <= 0
                ? "NOTHING_REFUNDABLE"
                : "POLICY_ZERO",
          };
        }
      }
    }

    // #776 §C — whole-event (class/webinar) cancellation refunds every attendee
    // in full through the reversal engine: org-funded seats reverse in-ledger
    // (CLASS_MULTI), card/mock seats credit the gateway. Same at-most-once CAS
    // guarantee as the block above. Attendees didn't leave voluntarily (the
    // event was cancelled on them), so this is a full refund, not policy-tiered.
    let eventRefund: WholeEventRefundSummary | null = null;
    if (appointment.class || appointment.webinar) {
      const eventKind = appointment.class ? "class" : "webinar";
      const eventId = appointment.class?.id ?? appointment.webinar!.id;
      eventRefund = await refundWholeEventPayments(
        eventKind,
        eventId,
        `whole-event ${eventKind} cancellation (${validatedData.reason ?? "cancelled"})`,
        session.user.id,
      );
    }

    // Notification metadata (for fire-and-forget notifications after transaction)
    const notificationMeta = {
      consultantUserId,
      consulteeUserId,
      consultantName,
      consulteeName,
      planTitle,
      appointmentType,
      dateTime,
      cancelledBy: session.user.id,
    };

    // #1003 — every paid attendee of a cancelled group event has to hear about
    // it too. They have no 1:1 counterpart on the booking, so they are read off
    // the payments, exactly as the moderation bulk-cancel does.
    let attendeeUserIds: string[] = [];
    if (appointment.class || appointment.webinar) {
      const eventFilter = appointment.class
        ? { classId: appointment.class.id }
        : { webinarId: appointment.webinar!.id };
      const attendeePayments = await prisma.payment.findMany({
        where: {
          appointment: eventFilter,
          paymentStatus: "SUCCEEDED",
          amount: { gt: 0 },
          deletedAt: null,
        },
        select: { userId: true },
      });
      attendeeUserIds = Array.from(
        new Set(attendeePayments.map((p) => p.userId)),
      );
    }

    // Fire-and-forget: notify both parties about cancellation
    const userIds = Array.from(
      new Set(
        [
          notificationMeta.consultantUserId,
          notificationMeta.consulteeUserId,
          ...attendeeUserIds,
        ].filter((id): id is string => !!id),
      ),
    );
    if (userIds.length > 0) {
      void notifyAppointmentCancelled(userIds, {
        ...notificationScope(appointment.organizationId),
        appointmentId,
        appointmentType: notificationMeta.appointmentType,
        consultantName: notificationMeta.consultantName || "Consultant",
        consulteeName: notificationMeta.consulteeName || "Consultee",
        planTitle: notificationMeta.planTitle || "N/A",
        dateTime: notificationMeta.dateTime,
        // Both parties receive one payload, so the href has to suit either.
        dashboardUrl: notificationHref(
          appointment.organizationId,
          "appointments",
        ),
        reason: validatedData.reason || undefined,
        // Three-way, not two. A group event has no consultee at all, so the
        // old else-branch told every attendee that "the consultee cancelled"
        // whenever an admin did — and on a 1:1 it said the same of a platform
        // cancellation. `system` is what the payload has for that.
        cancelledBy:
          notificationMeta.cancelledBy === notificationMeta.consultantUserId
            ? "consultant"
            : notificationMeta.cancelledBy === consulteeUserId
              ? "consultee"
              : "system",
      });
    }

    // Log cancellation activity for consultant dashboard (awaited — DB write
    // that should not be dropped in serverless; logActivity swallows errors)
    const actor = {
      id: session.user.id,
      name: session.user.name || "User",
      image: session.user.image,
    };
    // #1169 PR 4 — three-way, matching the notification payload above: a
    // platform/org actor is "system", never mislabeled as the consultee.
    const cancelledBy =
      session.user.id === notificationMeta.consultantUserId
        ? ("consultant" as const)
        : isParticipant
          ? ("consultee" as const)
          : ("system" as const);

    if (appointment.consultation) {
      const cpId =
        appointment.consultation.consultationPlan?.consultantProfileId;
      if (cpId) {
        await logConsultationCancelled(
          cpId,
          appointment.consultation.id,
          actor,
          planTitle || "Consultation",
          cancelledBy,
        );
      }
    } else if (appointment.subscription) {
      const cpId =
        appointment.subscription.subscriptionPlan?.consultantProfileId;
      if (cpId) {
        await logSubscriptionCancelled(
          cpId,
          appointment.subscription.id,
          actor,
          planTitle || "Subscription",
          cancelledBy,
        );
      }
    }

    return NextResponse.json({ ...result, refund, eventRefund });
  } catch (error) {
    // #1319 — lock outcomes are structured, never a 500.
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof AppointmentBusyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      const code =
        "code" in error && typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      return NextResponse.json(
        { error: error.message, ...(code && { code }) },
        { status },
      );
    }
    if (error instanceof Error && error.message === "Appointment not found") {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error canceling appointment:", error);
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}
