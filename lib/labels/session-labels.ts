/**
 * Shared user-facing labels for the personal-dashboard session lifecycle —
 * the consultant/consultee sibling of `lib/labels/org-labels.ts`.
 *
 * Every badge that renders an appointment / trial / slot / document /
 * recording / payment / refund / earning / payout / referral / newsletter /
 * verification status pulls its label + colour pair from here. Before this
 * module the same enums were styled by eight independent inline maps
 * (consultant appointments BADGE_STYLES, earnings statusConfig, referrals
 * map, consultee statusConfig.ts, BookingHistoryTab, PaymentsTab,
 * FeedbackSupportTab, VerificationStatusBadge) that drifted apart and left
 * real DB states unmapped (EarningStatus.PENDING_TRUST rendered
 * `undefined`; ReferralStatus.QUALIFIED/FRAUDULENT fell through to raw
 * enum text).
 *
 * Palette conventions (mirrors org-labels):
 *   - amber:   awaiting someone else (pending review/approval/queue)
 *   - orange:  awaiting YOU (payment required, revision needed, reversed)
 *   - blue:    in flight / informational (under review, processing)
 *   - emerald: confirmed upcoming (scheduled, ready)
 *   - green:   positive terminal (completed, paid, booked)
 *   - purple:  converted/refunded (money or state moved elsewhere)
 *   - red:     negative (rejected, failed, fraudulent)
 *   - zinc:    neutral terminal (cancelled, expired, superseded)
 *
 * Badge classes are worn by `components/dashboard/StatusBadge.tsx`
 * (rounded-full pill). Every resolver falls back to a zinc pill with the
 * title-cased raw value so an unmapped/legacy status renders legibly
 * instead of crashing or vanishing.
 */

import type {
  AppointmentStatus,
  ConsultantVerificationStatus,
  DocumentReviewStatus,
  EarningStatus,
  PaymentStatus,
  PayoutStatus,
  RecordingStatus,
  ReferralStatus,
  RefundStatus,
  SlotCompletionStatus,
  TrialSessionStatus,
  WaitlistStatus,
  WebinarStatus,
} from "@prisma/client";

export interface StatusBadgeStyle {
  label: string;
  className: string;
  /** Optional leading-dot colour for card surfaces that render dot pills. */
  dotClassName?: string;
}

/** Title-case an unknown/legacy status string: "SOME_STATE" → "Some State". */
export function formatStatusLabel(status: string): string {
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const FALLBACK_CLASS = "bg-zinc-100 text-zinc-600 border-zinc-200";

function resolve<K extends string>(
  map: Record<K, StatusBadgeStyle>,
  status: K | string | null | undefined,
): StatusBadgeStyle {
  if (status && status in map) return map[status as K];
  return {
    label: status ? formatStatusLabel(String(status)) : "Unknown",
    className: FALLBACK_CLASS,
    dotClassName: "bg-zinc-400",
  };
}

// ───────────────────────────── AppointmentStatus ─────────────────────────────
// Booking lifecycle for consultations / subscriptions (@@map RequestStatus).

export const APPOINTMENT_STATUS_BADGE: Record<
  AppointmentStatus,
  StatusBadgeStyle
> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
    dotClassName: "bg-amber-500",
  },
  APPROVED: {
    label: "Approved",
    className: "bg-blue-100 text-blue-900 border-blue-200",
    dotClassName: "bg-blue-500",
  },
  APPROVED_PENDING_PAYMENT: {
    label: "Payment required",
    className: "bg-orange-100 text-orange-900 border-orange-200",
    dotClassName: "bg-orange-500",
  },
  SCHEDULED: {
    label: "Scheduled",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
    dotClassName: "bg-emerald-500",
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-green-100 text-green-900 border-green-200",
    dotClassName: "bg-green-500",
  },
  REJECTED: {
    label: "Rejected",
    className: "bg-red-100 text-red-900 border-red-200",
    dotClassName: "bg-red-500",
  },
  CANCELLED: {
    label: "Cancelled",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  },
  EXPIRED: {
    label: "Expired",
    className: "bg-zinc-100 text-zinc-500 border-zinc-200",
    dotClassName: "bg-zinc-400",
  },
};

export const appointmentStatusBadge = (
  status: AppointmentStatus | string | null | undefined,
): StatusBadgeStyle => resolve(APPOINTMENT_STATUS_BADGE, status);

// ───────────────────────────── TrialSessionStatus ─────────────────────────────

export const TRIAL_STATUS_BADGE: Record<TrialSessionStatus, StatusBadgeStyle> =
  {
    PENDING: {
      label: "Pending",
      className: "bg-amber-100 text-amber-900 border-amber-200",
      dotClassName: "bg-amber-500",
    },
    // Accepted by the consultant, waiting on the learner to pay. Amber like
    // PENDING because both are "waiting", but the label names who we're
    // waiting on — that distinction is the whole reason this status exists.
    AWAITING_PAYMENT: {
      label: "Awaiting payment",
      className: "bg-amber-100 text-amber-900 border-amber-200",
      dotClassName: "bg-amber-500",
    },
    SCHEDULED: {
      label: "Scheduled",
      className: "bg-emerald-100 text-emerald-900 border-emerald-200",
      dotClassName: "bg-emerald-500",
    },
    COMPLETED: {
      label: "Completed",
      className: "bg-green-100 text-green-900 border-green-200",
      dotClassName: "bg-green-500",
    },
    CONVERTED: {
      label: "Converted",
      className: "bg-purple-100 text-purple-900 border-purple-200",
      dotClassName: "bg-purple-500",
    },
    CANCELLED: {
      label: "Cancelled",
      className: "bg-zinc-100 text-zinc-600 border-zinc-200",
      dotClassName: "bg-zinc-400",
    },
    REJECTED: {
      label: "Rejected",
      className: "bg-red-100 text-red-900 border-red-200",
      dotClassName: "bg-red-500",
    },
  };

export const trialStatusBadge = (
  status: TrialSessionStatus | string | null | undefined,
): StatusBadgeStyle => resolve(TRIAL_STATUS_BADGE, status);

// ───────────────────────────── Webinar / Class status ─────────────────────────────
// WebinarStatus and ClassStatus are enum-identical; one map serves both
// (same doctrine as EVENT_ALLOWED_FROM in lib/booking/transitions.ts).

export const EVENT_STATUS_BADGE: Record<WebinarStatus, StatusBadgeStyle> = {
  DRAFT: {
    label: "Draft",
    className: "bg-amber-100 text-amber-900 border-amber-200",
    dotClassName: "bg-amber-500",
  },
  SCHEDULED: {
    label: "Scheduled",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
    dotClassName: "bg-emerald-500",
  },
  IN_PROGRESS: {
    label: "In progress",
    className: "bg-blue-100 text-blue-900 border-blue-200",
    dotClassName: "bg-blue-500",
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-green-100 text-green-900 border-green-200",
    dotClassName: "bg-green-500",
  },
  CANCELLED: {
    label: "Cancelled",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  },
};

export const eventStatusBadge = (
  status: WebinarStatus | string | null | undefined,
): StatusBadgeStyle => resolve(EVENT_STATUS_BADGE, status);

// ───────────────────────────── SlotCompletionStatus ─────────────────────────────

export const SLOT_STATUS_BADGE: Record<SlotCompletionStatus, StatusBadgeStyle> =
  {
    SCHEDULED: {
      label: "Scheduled",
      className: "bg-emerald-100 text-emerald-900 border-emerald-200",
    },
    COMPLETED: {
      label: "Completed",
      className: "bg-green-100 text-green-900 border-green-200",
    },
    UNVERIFIED: {
      label: "Unverified",
      className: "bg-amber-100 text-amber-900 border-amber-200",
    },
    CANCELLED: {
      label: "Cancelled",
      className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    },
    RESCHEDULED: {
      label: "Rescheduled",
      className: "bg-blue-100 text-blue-900 border-blue-200",
    },
  };

export const slotStatusBadge = (
  status: SlotCompletionStatus | string | null | undefined,
): StatusBadgeStyle => resolve(SLOT_STATUS_BADGE, status);

// ───────────────────────────── WaitlistStatus ─────────────────────────────
// Newsletter subscription lifecycle, not event capacity.

export const WAITLIST_STATUS_BADGE: Record<WaitlistStatus, StatusBadgeStyle> = {
  PENDING: {
    label: "Awaiting confirmation",
    className: "bg-amber-100 text-amber-900 border-amber-200",
    dotClassName: "bg-amber-500",
  },
  SUBSCRIBED: {
    label: "Subscribed",
    className: "bg-green-100 text-green-900 border-green-200",
    dotClassName: "bg-green-500",
  },
  UNSUBSCRIBED: {
    label: "Unsubscribed",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
    dotClassName: "bg-zinc-400",
  },
  BOUNCED: {
    label: "Bounced",
    className: "bg-red-100 text-red-900 border-red-200",
    dotClassName: "bg-red-500",
  },
};

export const waitlistStatusBadge = (
  status: WaitlistStatus | string | null | undefined,
): StatusBadgeStyle => resolve(WAITLIST_STATUS_BADGE, status);

// ───────────────────────────── DocumentReviewStatus ─────────────────────────────

export const DOCUMENT_REVIEW_STATUS_BADGE: Record<
  DocumentReviewStatus,
  StatusBadgeStyle
> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  IN_REVIEW: {
    label: "In review",
    className: "bg-blue-100 text-blue-900 border-blue-200",
  },
  APPROVED: {
    label: "Approved",
    className: "bg-green-100 text-green-900 border-green-200",
  },
  REJECTED: {
    label: "Rejected",
    className: "bg-red-100 text-red-900 border-red-200",
  },
  NEEDS_REVISION: {
    label: "Needs revision",
    className: "bg-orange-100 text-orange-900 border-orange-200",
  },
};

export const documentReviewStatusBadge = (
  status: DocumentReviewStatus | string | null | undefined,
): StatusBadgeStyle => resolve(DOCUMENT_REVIEW_STATUS_BADGE, status);

// ───────────────────────────── RecordingStatus ─────────────────────────────

export const RECORDING_STATUS_BADGE: Record<RecordingStatus, StatusBadgeStyle> =
  {
    RECORDING: {
      label: "Recording",
      className: "bg-red-100 text-red-900 border-red-200",
    },
    PROCESSING: {
      label: "Processing",
      className: "bg-blue-100 text-blue-900 border-blue-200",
    },
    READY: {
      label: "Ready",
      className: "bg-emerald-100 text-emerald-900 border-emerald-200",
    },
    TRANSFERRING: {
      label: "Transferring",
      className: "bg-blue-100 text-blue-900 border-blue-200",
    },
    AVAILABLE: {
      label: "Available",
      className: "bg-green-100 text-green-900 border-green-200",
    },
    FAILED: {
      label: "Failed",
      className: "bg-red-100 text-red-900 border-red-200",
    },
    EXPIRED: {
      label: "Expired",
      className: "bg-zinc-100 text-zinc-500 border-zinc-200",
    },
  };

export const recordingStatusBadge = (
  status: RecordingStatus | string | null | undefined,
): StatusBadgeStyle => resolve(RECORDING_STATUS_BADGE, status);

// ───────────────────────────── PaymentStatus (+ derived display) ─────────────────────────────
// Prisma PaymentStatus never reaches REFUNDED — refunds live on the Refund
// relation. Consumer-facing surfaces render a DERIVED display status so a
// refunded payment doesn't read "Succeeded" forever; the consultee payments
// API computes it (REFUNDED / PARTIALLY_REFUNDED when SUCCEEDED refunds
// exist against the payment).

export type PaymentDisplayStatus =
  | PaymentStatus
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

export const PAYMENT_STATUS_BADGE: Record<
  PaymentDisplayStatus,
  StatusBadgeStyle
> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  SUCCEEDED: {
    label: "Paid",
    className: "bg-green-100 text-green-900 border-green-200",
  },
  FAILED: {
    label: "Failed",
    className: "bg-red-100 text-red-900 border-red-200",
  },
  EXPIRED: {
    label: "Expired",
    className: "bg-zinc-100 text-zinc-500 border-zinc-200",
  },
  REFUNDED: {
    label: "Refunded",
    className: "bg-purple-100 text-purple-900 border-purple-200",
  },
  PARTIALLY_REFUNDED: {
    label: "Partially refunded",
    className: "bg-purple-100 text-purple-900 border-purple-200",
  },
};

export const paymentStatusBadge = (
  status: PaymentDisplayStatus | string | null | undefined,
): StatusBadgeStyle => resolve(PAYMENT_STATUS_BADGE, status);

// ───────────────────────────── RefundStatus ─────────────────────────────

export const REFUND_STATUS_BADGE: Record<RefundStatus, StatusBadgeStyle> = {
  PENDING: {
    label: "Refund pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  SUCCEEDED: {
    label: "Refunded",
    className: "bg-purple-100 text-purple-900 border-purple-200",
  },
  FAILED: {
    label: "Refund failed",
    className: "bg-red-100 text-red-900 border-red-200",
  },
  CANCELLED: {
    label: "Refund cancelled",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
  },
};

export const refundStatusBadge = (
  status: RefundStatus | string | null | undefined,
): StatusBadgeStyle => resolve(REFUND_STATUS_BADGE, status);

// ───────────────────────────── EarningStatus ─────────────────────────────

export const EARNING_STATUS_BADGE: Record<EarningStatus, StatusBadgeStyle> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  HELD: {
    label: "On hold",
    className: "bg-orange-100 text-orange-900 border-orange-200",
  },
  READY: {
    label: "Ready for payout",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
  },
  // #837 — in a payout batch but cash hasn't left yet; honestly distinct from Paid.
  BATCHED: {
    label: "Processing payout",
    className: "bg-sky-100 text-sky-900 border-sky-200",
  },
  PAID: {
    label: "Paid",
    className: "bg-green-100 text-green-900 border-green-200",
  },
  REFUNDED: {
    label: "Refunded",
    className: "bg-purple-100 text-purple-900 border-purple-200",
  },
  // Accrued from a not-yet-verified INVOICE-funded org; released by the
  // release-pending-trust-earnings cron (see schema.prisma EarningStatus).
  PENDING_TRUST: {
    label: "Pending org trust",
    className: "bg-blue-100 text-blue-900 border-blue-200",
  },
};

export const earningStatusBadge = (
  status: EarningStatus | string | null | undefined,
): StatusBadgeStyle => resolve(EARNING_STATUS_BADGE, status);

// ───────────────────────────── PayoutStatus ─────────────────────────────

export const PAYOUT_STATUS_BADGE: Record<PayoutStatus, StatusBadgeStyle> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  APPROVED: {
    label: "Approved",
    className: "bg-blue-100 text-blue-900 border-blue-200",
  },
  PROCESSING: {
    label: "Processing",
    className: "bg-blue-100 text-blue-900 border-blue-200",
  },
  COMPLETED: {
    label: "Completed",
    className: "bg-green-100 text-green-900 border-green-200",
  },
  FAILED: {
    label: "Failed",
    className: "bg-red-100 text-red-900 border-red-200",
  },
  CANCELLED: {
    label: "Cancelled",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
  },
  REVERSED: {
    label: "Reversed",
    className: "bg-orange-100 text-orange-900 border-orange-200",
  },
};

export const payoutStatusBadge = (
  status: PayoutStatus | string | null | undefined,
): StatusBadgeStyle => resolve(PAYOUT_STATUS_BADGE, status);

// ───────────────────────────── ReferralStatus ─────────────────────────────

export const REFERRAL_STATUS_BADGE: Record<ReferralStatus, StatusBadgeStyle> = {
  SIGNED_UP: {
    label: "Signed up",
    className: "bg-blue-100 text-blue-900 border-blue-200",
  },
  QUALIFIED: {
    label: "Qualified",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
  },
  REWARDED: {
    label: "Rewarded",
    className: "bg-green-100 text-green-900 border-green-200",
  },
  EXPIRED: {
    label: "Expired",
    className: "bg-zinc-100 text-zinc-500 border-zinc-200",
  },
  FRAUDULENT: {
    label: "Flagged",
    className: "bg-red-100 text-red-900 border-red-200",
  },
};

export const referralStatusBadge = (
  status: ReferralStatus | string | null | undefined,
): StatusBadgeStyle => resolve(REFERRAL_STATUS_BADGE, status);

// ───────────────────────────── ConsultantVerificationStatus ─────────────────────────────
// PENDING_VERIFICATION is ACTIONABLE (the consultant must complete/submit
// their verification from Settings) — the old overlay's passive "Awaiting
// Verification" copy contradicted SettingsTab and stranded new consultants.

export const VERIFICATION_STATUS_BADGE: Record<
  ConsultantVerificationStatus,
  StatusBadgeStyle
> = {
  PENDING_VERIFICATION: {
    label: "Verification required",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  UNDER_REVIEW: {
    label: "Under review",
    className: "bg-blue-100 text-blue-900 border-blue-200",
  },
  VERIFIED: {
    label: "Verified",
    className: "bg-green-100 text-green-900 border-green-200",
  },
  REJECTED: {
    label: "Rejected",
    className: "bg-red-100 text-red-900 border-red-200",
  },
};

export const verificationStatusBadge = (
  status: ConsultantVerificationStatus | string | null | undefined,
): StatusBadgeStyle => resolve(VERIFICATION_STATUS_BADGE, status);

// ───────────────────────────── Sponsoring-org helper ─────────────────────────────

/**
 * Resolve the display name of the org sponsoring a booking/payment from the
 * session's membership list. Returns null when the record isn't org-funded
 * so callers can skip the "Sponsored ·" badge entirely. Previously copied
 * inline in 4 components (consultant AppointmentsTab/HomeTab, consultee
 * BookingHistoryTab/PaymentsTab).
 */
export function resolveSponsoringOrgName(
  orgId: string | null | undefined,
  memberships:
    | Array<{ organizationId: string; organizationName: string }>
    | null
    | undefined,
): string | null {
  if (!orgId) return null;
  return (
    memberships?.find((m) => m.organizationId === orgId)?.organizationName ??
    "the organization"
  );
}
