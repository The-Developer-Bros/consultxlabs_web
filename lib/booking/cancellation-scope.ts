/**
 * Resolve the refund facts for a WHOLE booking, not one appointment (#1006).
 *
 * Cancellation is a whole-booking act, but a booking is not always one
 * Appointment row. A subscription is a slot-less placeholder created at
 * checkout — which is the row that carries the Payment — plus one further
 * Appointment per allocated session, none of which carry money. A class is one
 * Appointment per session with every attendee's Payment piled onto the first.
 * Only a consultation and a webinar are genuinely 1:1 with their Appointment.
 *
 * The cancel route used to read the payment, the frozen policy snapshot and
 * the start time straight off the appointment it was handed, so:
 *
 *   - cancelling a subscription refunded NOTHING. The dashboards target the
 *     next actionable session, which never carries a Payment, so the route
 *     found no payment and skipped the refund block entirely while still
 *     cancelling every slot and the subscription itself.
 *   - the refund tier depended on WHICH session you cancelled from, and was
 *     computed from the earliest slot including already-delivered ones — so a
 *     live subscription whose first session is in the past always scored 0%.
 *
 * This module answers those questions once, against every appointment of the
 * booking: which payment funds it, whose terms were frozen at purchase, when
 * the next undelivered session starts, and how much has already been consumed.
 */

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { recordSystemError } from "@/lib/enterprise/system-events";
import type { CancellationPolicyTerms } from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";

/** Slots that still represent an undelivered session. */
const LIVE_SLOT_STATUSES = ["SCHEDULED", "RESCHEDULED"] as const;

export type BookingRefundContext = {
  /** The single SUCCEEDED payment funding this booking (zero-amount credit-funded included), if any. */
  paidPayment: {
    id: string;
    /** Gross captured — the base the policy percentage applies to. */
    amountPaise: number;
    /** #1161 — free_ (credit-funded) detection for the restoration rail. */
    paymentIntent: string;
    /**
     * Gross less anything already given back. Callers must clamp to this: a
     * percentage of the gross overshoots on a payment with an earlier partial
     * refund, and the refund operation rejects the whole request rather than
     * paying the remainder.
     */
    refundablePaise: number;
  } | null;
  /**
   * #1499 — the terms the buyer was sold under, loaded from the immutable policy
   * version the booking points at. Always populated: a booking with no policy row
   * resolves to the platform ladder rather than to null, so no caller has to.
   */
  policy: CancellationPolicyTerms;
  /**
   * Hours until the earliest session that has not been delivered or cancelled,
   * or null when the booking has no live session at all (an unallocated
   * subscription, or one whose sessions have all been held).
   */
  hoursUntilNextSession: number | null;
  /** Sessions already delivered — the proration input (#1006). */
  sessionsCompleted: number;
  /** Sessions still owed to the buyer. */
  sessionsRemaining: number;
  /**
   * Slots of ANY status on the booking. Zero means no session was ever
   * scheduled, which is a different fact from "every session is terminal" —
   * and the two must not be conflated, because only the former means the
   * consultant never held time for this buyer.
   */
  slotsTotal: number;
};

/** Identifies a booking: the parent request/event, or a lone appointment. */
export type BookingRef = {
  /** Only used when no parent link is given (trials, unlinked appointments). */
  appointmentId?: string;
  consultationId?: string | null;
  subscriptionId?: string | null;
  classId?: string | null;
  webinarId?: string | null;
};

/** Every Appointment row belonging to the same booking as `ref`. */
export function bookingAppointmentFilter(
  ref: BookingRef,
): Prisma.AppointmentWhereInput {
  if (ref.subscriptionId) return { subscriptionId: ref.subscriptionId };
  if (ref.classId) return { classId: ref.classId };
  if (ref.consultationId) return { consultationId: ref.consultationId };
  if (ref.webinarId) return { webinarId: ref.webinarId };
  // Trials and anything unlinked are genuinely single-appointment.
  if (ref.appointmentId) return { id: ref.appointmentId };
  throw new Error("bookingAppointmentFilter: no booking identifier given");
}

export async function resolveBookingRefundContext(
  ref: BookingRef,
  /**
   * Restrict the payment lookup to one buyer. Required for group events, where
   * every attendee's Payment hangs off the same appointment; omit it for 1:1
   * bookings, which have exactly one payer.
   */
  payerUserId?: string,
): Promise<BookingRefundContext> {
  const rows = await prisma.appointment.findMany({
    // Deterministic: the booking's oldest appointment is the one checkout
    // created, so it is the row that carries the payment and the frozen terms.
    orderBy: { createdAt: "asc" },
    where: { ...bookingAppointmentFilter(ref), deletedAt: null },
    select: {
      id: true,
      cancellationPolicy: POLICY_TERMS_INCLUDE,
      payment: {
        where: {
          paymentStatus: "SUCCEEDED",
          // #1161 — no amount floor: a fully-credit-funded payment (amount 0,
          // free_ intent) must surface here or the cancel route's credit-
          // restoration branch can never fire (it was dead code behind this
          // filter — caught by the #1180 preview work).
          deletedAt: null,
          ...(payerUserId ? { userId: payerUserId } : {}),
        },
        select: {
          id: true,
          amount: true,
          // #1161 — free_ detection: a fully-credit-funded payment refunds as
          // credit restoration, which the amount-based tier math cannot see.
          paymentIntent: true,
          ...REFUNDABLE_BALANCE_SELECT,
        },
        orderBy: { createdAt: "asc" },
      },
      slotsOfAppointment: {
        // Scoped to the payer for the same reason the payment lookup is: on a
        // class every attendee's seat hangs off the same appointment, so an
        // unscoped count would tier ONE buyer's refund off OTHER attendees'
        // sessions. A 1:1 booking has no `user` rows to filter on beyond its
        // own, so the constraint is inert there.
        where: {
          deletedAt: null,
          ...(payerUserId ? { user: { some: { id: payerUserId } } } : {}),
        },
        select: { startsAt: true, completionStatus: true },
      },
    },
  });

  const payments = rows.flatMap((r) => r.payment);
  const payment = payments[0];
  // More than one SUCCEEDED payment on a booking should be unreachable:
  // `@@unique([userId, appointmentId])` means one row per payer per
  // appointment, and the CHARGE_MEMBER overage side-charge is deliberately
  // created with `appointmentId: null` to avoid exactly that clash
  // (overage-settlement.ts). Which is precisely why this must not stay silent
  // — if it ever fires, the model has changed under us and a buyer is being
  // refunded less than they paid.
  if (payments.length > 1) {
    void recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary:
        `Booking carries ${payments.length} refundable payments; only the ` +
        `oldest is being refunded, so the buyer may be owed more`,
      err: new Error("MULTIPLE_REFUNDABLE_PAYMENTS"),
      context: { ref, payerUserId, paymentIds: payments.map((p) => p.id) },
    }).catch(() => {});
  }
  const paidPayment = payment
    ? {
        id: payment.id,
        amountPaise: Number(payment.amount),
        paymentIntent: payment.paymentIntent,
        refundablePaise: refundableBalancePaise(
          Number(payment.amount),
          payment,
        ),
      }
    : null;
  const payer = rows.find((r) => r.payment.length > 0);

  // The terms that bind are the ones stamped on the row the buyer actually paid for.
  // The "any session row" fallback survives only for bookings sold before #1499 wrote
  // the FK onto the subscription placeholder; a booking with neither reads as the
  // platform ladder, which is what it was sold under.
  const policy = termsFromPolicyRow(
    payer?.cancellationPolicy ??
      rows.find((r) => r.cancellationPolicy !== null)?.cancellationPolicy ??
      null,
  );

  const slots = rows.flatMap((r) => r.slotsOfAppointment);
  const liveStarts = slots
    .filter((s) =>
      (LIVE_SLOT_STATUSES as readonly string[]).includes(s.completionStatus),
    )
    .map((s) => s.startsAt.getTime())
    .sort((a, b) => a - b);

  return {
    paidPayment,
    policy,
    hoursUntilNextSession:
      liveStarts.length > 0 ? (liveStarts[0] - Date.now()) / 3_600_000 : null,
    sessionsCompleted: slots.filter((s) => s.completionStatus === "COMPLETED")
      .length,
    sessionsRemaining: liveStarts.length,
    slotsTotal: slots.length,
  };
}
