/**
 * Centralized occupancy policy for slot conflict detection.
 *
 * FIX Bug #15: Different services used different status filters for determining
 * occupied slots, causing inconsistent booking behavior. This module defines
 * the canonical status sets that all services must use.
 *
 * Policy: A slot is "occupied" if the parent event is in an active state
 * (not yet completed, cancelled, rejected, or expired).
 */

import {
  AppointmentStatus,
  BookingSource,
  PaymentStatus,
  TrialSessionStatus,
  Prisma,
} from "@prisma/client";

/**
 * Consultation/Subscription statuses that count as "slot occupied"
 * These are active booking states where the slot should block future availability.
 *
 * - PENDING: User submitted, awaiting consultant approval (tentative hold)
 * - APPROVED: Consultant approved (confirmed)
 * - APPROVED_PENDING_PAYMENT: Approved but payment not yet completed
 * - SCHEDULED: Fully scheduled and confirmed
 */
export const OCCUPIED_REQUEST_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING,
  AppointmentStatus.APPROVED,
  AppointmentStatus.APPROVED_PENDING_PAYMENT,
  AppointmentStatus.SCHEDULED,
];

/**
 * Webinar/Class statuses that count as "slot occupied"
 * - SCHEDULED: Event is scheduled (confirmed)
 * - IN_PROGRESS: Event is currently happening
 */
export const OCCUPIED_EVENT_STATUSES = ["SCHEDULED", "IN_PROGRESS"] as const;

/**
 * Build a Prisma OR clause for filtering appointments by occupied status.
 * Use this in any query that needs to determine slot occupancy/conflicts.
 *
 * @param consultantProfileId - Optional consultant profile ID to scope the query
 * @returns Prisma OR clause array for appointment filtering
 */
export function buildOccupiedAppointmentFilter(
  consultantProfileId?: string,
): Prisma.AppointmentWhereInput[] {
  const filters: Prisma.AppointmentWhereInput[] = [
    {
      consultation: {
        ...(consultantProfileId
          ? { consultationPlan: { consultantProfileId } }
          : {}),
        status: { in: OCCUPIED_REQUEST_STATUSES },
      },
    },
    {
      subscription: {
        ...(consultantProfileId
          ? { subscriptionPlan: { consultantProfileId } }
          : {}),
        status: { in: OCCUPIED_REQUEST_STATUSES },
      },
    },
    {
      webinar: {
        ...(consultantProfileId
          ? { webinarPlan: { consultantProfileId } }
          : {}),
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
      },
    },
    {
      class: {
        ...(consultantProfileId ? { classPlan: { consultantProfileId } } : {}),
        status: { in: [...OCCUPIED_EVENT_STATUSES] },
      },
    },
  ];

  // Add trial session filter.
  //
  // AWAITING_PAYMENT occupies too: a paid trial's slot is reserved the moment
  // the consultant accepts, and stays reserved while the learner pays. Counting
  // only SCHEDULED would let someone else book the same slot during the payment
  // window, and the capture webhook would then confirm a trial into a
  // double-booked slot. The expiry job releases it by moving the trial to
  // CANCELLED, which drops out of this filter automatically.
  const OCCUPYING_TRIAL_STATUSES = [
    TrialSessionStatus.SCHEDULED,
    TrialSessionStatus.AWAITING_PAYMENT,
  ];

  if (consultantProfileId) {
    filters.push({
      trialSession: {
        is: {
          consultantProfileId,
          status: { in: OCCUPYING_TRIAL_STATUSES },
        },
      },
    });
  } else {
    filters.push({
      trialSession: {
        is: {
          status: { in: OCCUPYING_TRIAL_STATUSES },
        },
      },
    });
  }

  return filters;
}

/**
 * Everything that occupies one consultant's calendar.
 *
 * A consultant is busy for an active appointment when EITHER they are connected
 * to one of its slots (they are attending it, in any role) OR it is delivered
 * under one of their own plans. Both arms are needed:
 *
 *   - Slot participation alone misses group events, whose slot rows connect
 *     registrants rather than the host.
 *   - Plan ownership alone misses every appointment where the consultant is
 *     themselves the consultee — booked with a DIFFERENT consultant, so no plan
 *     of theirs is involved.
 *
 * The availability grid used to ask only the second question while the
 * allocator asked only the first, so a consultant who was a consultee elsewhere
 * saw a green cell that every allocation mode then rejected as booked. Both
 * sides now call this.
 */
export function buildConsultantOccupancyWhere(
  consultantProfileId: string | undefined,
  consultantUserId: string,
): Prisma.AppointmentWhereInput {
  const reachesConsultant: Prisma.AppointmentWhereInput[] = [
    {
      slotsOfAppointment: {
        some: {
          user: { some: { id: consultantUserId } },
          // Defense-in-depth: a tombstoned slot is not a booking. No
          // completionStatus filter — RESCHEDULED rows are a pending
          // reschedule's live hold and must still occupy the grid.
          deletedAt: null,
        },
      },
    },
  ];

  if (consultantProfileId) {
    reachesConsultant.push({
      OR: buildOccupiedAppointmentFilter(consultantProfileId),
    });
  }

  return {
    AND: [{ OR: buildOccupiedAppointmentFilter() }, { OR: reachesConsultant }],
  };
}

/**
 * #1319 — the SQL twin of isOccupiedByLiveAppointment, for callers that select
 * SLOTS rather than appointments and so cannot run the JS predicate (checkout
 * step 1, the trial route). Subtracts the two dead-hold shapes from the
 * occupancy filter: an APPROVED_PENDING_PAYMENT or DIRECT_CHECKOUT PENDING
 * request whose every payment is EXPIRED or past its window. Kept beside
 * buildOccupiedAppointmentFilter so the two cannot drift silently;
 * hold-expiry-predicate.test.ts asserts they agree.
 *
 * Prisma subtlety: `every` is vacuously true on an appointment with no
 * payments, so `some: {}` is required alongside it — that is the SQL form of
 * the `payments.length > 0` guard in the JS predicate.
 */
export function buildDeadHoldFilter(now: Date): Prisma.AppointmentWhereInput {
  const allPaymentsDead: Prisma.AppointmentWhereInput = {
    payment: {
      some: {},
      every: {
        OR: [
          { paymentStatus: PaymentStatus.EXPIRED },
          { paymentStatus: PaymentStatus.FAILED },
          // Clock-dead only while still PENDING: a SUCCEEDED row keeps its
          // expiresAt and must never free the slot it paid for.
          { paymentStatus: PaymentStatus.PENDING, expiresAt: { lt: now } },
        ],
      },
    },
  };
  return {
    OR: [
      {
        consultation: { status: AppointmentStatus.APPROVED_PENDING_PAYMENT },
        ...allPaymentsDead,
      },
      {
        subscription: { status: AppointmentStatus.APPROVED_PENDING_PAYMENT },
        ...allPaymentsDead,
      },
      {
        consultation: {
          status: AppointmentStatus.PENDING,
          bookingSource: BookingSource.DIRECT_CHECKOUT,
        },
        ...allPaymentsDead,
      },
      {
        subscription: {
          status: AppointmentStatus.PENDING,
          bookingSource: BookingSource.DIRECT_CHECKOUT,
        },
        ...allPaymentsDead,
      },
    ],
  };
}
