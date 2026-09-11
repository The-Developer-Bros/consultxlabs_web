/**
 * Status guards for the appointment/event status union. Moved here from the
 * consultee appointments feature (utils/status-guards.ts, which re-exports
 * this module) so the shared appointments VM layer can bucket without
 * importing from a dashboard route.
 *
 * The event union carries statuses from three enums (AppointmentStatus,
 * TrialSessionStatus, Webinar/ClassStatus) plus legacy lowercase values,
 * so guards normalize case rather than typing against one enum.
 */

import {
  APPOINTMENT_STATUS_BADGE,
  EVENT_STATUS_BADGE,
  TRIAL_STATUS_BADGE,
  formatStatusLabel,
  type StatusBadgeStyle,
} from "@/lib/labels/session-labels";

const TERMINAL_STATUSES = new Set([
  "CANCELLED",
  "REJECTED",
  "COMPLETED",
  "EXPIRED",
  // TrialSessionStatus terminal: the consultee subscribed after the trial —
  // nothing further can happen on the trial booking itself.
  "CONVERTED",
]);

/** Terminal AND negative — the booking never (fully) happened. */
const CANCELLED_LIKE_STATUSES = new Set(["CANCELLED", "REJECTED", "EXPIRED"]);

/** Terminal AND positive — the booking ran its course. */
const COMPLETED_LIKE_STATUSES = new Set(["COMPLETED", "CONVERTED"]);

// "APPROVED" appears here AND in isApprovedStatus deliberately: approved is
// both a locked-in state (uploads/joining enabled — isConfirmedStatus) and a
// distinct pre-scheduling phase some surfaces branch on (isApprovedStatus is
// a strict subset check of isConfirmedStatus).
const CONFIRMED_STATUSES = new Set(["APPROVED", "SCHEDULED", "IN_PROGRESS"]);

export const normalizeStatus = (status: string | null | undefined): string =>
  status?.toUpperCase() ?? "";

/** Terminal states — no further user action is possible on the booking. */
export function isInactiveStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

/** Terminal-negative: cancelled / rejected / expired. */
export function isCancelledLikeStatus(
  status: string | null | undefined,
): boolean {
  return CANCELLED_LIKE_STATUSES.has(normalizeStatus(status));
}

/** Terminal-positive: completed / converted. */
export function isCompletedLikeStatus(
  status: string | null | undefined,
): boolean {
  return COMPLETED_LIKE_STATUSES.has(normalizeStatus(status));
}

/** Consultant approved; payment is the blocking step. Cancellable (no charge yet). */
export function isPendingPaymentStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeStatus(status);
  // AWAITING_PAYMENT is the trial equivalent of APPROVED_PENDING_PAYMENT:
  // accepted by the provider, slot held, money not yet collected. Both must
  // bucket as PAY_NOW or the learner never sees the "Pay Now to Confirm"
  // affordance on the booking itself.
  return (
    normalized === "APPROVED_PENDING_PAYMENT" ||
    normalized === "AWAITING_PAYMENT"
  );
}

export function isPendingStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status) === "PENDING";
}

export function isApprovedStatus(status: string | null | undefined): boolean {
  return normalizeStatus(status) === "APPROVED";
}

/** Booking is locked in (approved/scheduled/live) — enables uploads, joining, etc. */
export function isConfirmedStatus(status: string | null | undefined): boolean {
  return CONFIRMED_STATUSES.has(normalizeStatus(status));
}

/**
 * Badge style for the event status UNION (consultations/subscriptions carry
 * AppointmentStatus, webinars/classes carry Webinar/ClassStatus, trials
 * carry TrialSessionStatus). Tries the maps in specificity order and falls
 * back to a neutral title-cased pill for legacy values.
 */
export function eventUnionStatusBadge(
  status: string | null | undefined,
): StatusBadgeStyle {
  const s = normalizeStatus(status);
  if (s in APPOINTMENT_STATUS_BADGE) {
    return APPOINTMENT_STATUS_BADGE[s as keyof typeof APPOINTMENT_STATUS_BADGE];
  }
  if (s in EVENT_STATUS_BADGE) {
    return EVENT_STATUS_BADGE[s as keyof typeof EVENT_STATUS_BADGE];
  }
  if (s in TRIAL_STATUS_BADGE) {
    return TRIAL_STATUS_BADGE[s as keyof typeof TRIAL_STATUS_BADGE];
  }
  return {
    label: status ? formatStatusLabel(status) : "Unknown",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  };
}
