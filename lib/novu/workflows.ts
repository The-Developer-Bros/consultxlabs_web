/**
 * Novu Workflow Definitions
 * All workflow IDs must match their counterparts in the Novu dashboard.
 * Each workflow includes typed payload interfaces.
 */

// ============================================================================
// Workflow ID Constants
// ============================================================================

export const NOVU_WORKFLOWS = {
  // Appointment lifecycle
  APPOINTMENT_BOOKED: "appointment-booked",
  // #1206 — the consultant allocated only the sessions that fit. Distinct from
  // APPOINTMENT_BOOKED because "you are booked" and "4 of your 24 sessions are
  // booked" are different promises, and only the second one needs to say what
  // happens to the remainder.
  APPOINTMENT_PARTIALLY_SCHEDULED: "appointment-partially-scheduled",
  APPOINTMENT_CANCELLED: "appointment-cancelled",
  APPOINTMENT_RESCHEDULED: "appointment-rescheduled",
  APPOINTMENT_REMINDER: "appointment-reminder",
  APPOINTMENT_COMPLETED: "appointment-completed",

  // Payment events
  PAYMENT_SUCCESS: "payment-success",
  PAYMENT_FAILED: "payment-failed",
  REFUND_PROCESSED: "refund-processed",
  REFUND_REQUESTED: "refund-requested",
  // #779 §A — a refund the gateway rejected. In-app to the payer so they
  // know the money isn't coming back via this attempt + can chase support.
  REFUND_FAILED: "refund-failed",

  // Support
  SUPPORT_TICKET_CREATED: "support-ticket-created",
  SUPPORT_TICKET_UPDATE: "support-ticket-update",
  SUPPORT_TICKET_RESPONSE: "support-ticket-response",

  // Feedback & Reviews
  FEEDBACK_RECEIVED: "feedback-received",
  NEW_REVIEW_RECEIVED: "new-review-received",

  // Trials
  TRIAL_SESSION_REQUESTED: "trial-session-requested",
  TRIAL_SESSION_SCHEDULED: "trial-session-scheduled",
  TRIAL_SESSION_COMPLETED: "trial-session-completed",
  TRIAL_SESSION_CANCELLED: "trial-session-cancelled",

  // Subscriptions
  SUBSCRIPTION_STARTED: "subscription-started",
  SUBSCRIPTION_CANCELLED: "subscription-cancelled",
  SUBSCRIPTION_RENEWED: "subscription-renewed",

  // Consultant-specific
  NEW_BOOKING_REQUEST: "new-booking-request",
  VERIFICATION_STATUS_CHANGED: "verification-status-changed",
  PAYOUT_PROCESSED: "payout-processed",

  // Admin / System
  GENERAL_ANNOUNCEMENT: "general-announcement",
  NEW_CONSULTANT_APPLICATION: "new-consultant-application",

  // Moderation (#693) — staff actions against a reported user. Workflow
  // definitions must exist in the Novu dashboard with these slugs.
  MODERATION_WARNING: "moderation-warning",
  ACCOUNT_SUSPENDED: "account-suspended",
  ACCOUNT_BANNED: "account-banned",

  // Disputes
  DISPUTE_CREATED: "dispute-created",
  DISPUTE_RESOLVED: "dispute-resolved",

  // Recordings
  RECORDING_AVAILABLE: "recording-available",
  RECORDING_FAILED: "recording-failed",
  // STR-3 — STREAM_ONLY recordings aren't auto-transferred; warn the host
  // before their Stream S3 URL lapses so they can download/keep it.
  RECORDING_EXPIRING: "recording-expiring",

  // Documents — per-appointment review flow. An upload pings the reviewer,
  // a decision pings the uploader (see notifyDocumentUploaded/Reviewed).
  DOCUMENT_UPLOADED: "document-uploaded",
  DOCUMENT_REVIEWED: "document-reviewed",

  // Referrals
  REFERRAL_BONUS_EARNED: "referral-bonus-earned",
  REFEREE_WELCOME_BONUS: "referee-welcome-bonus",
  REFERRAL_CREDITS_APPLIED: "referral-credits-applied",

  // Collaborators
  COLLABORATOR_INVITED: "collaborator-invited",
  COLLABORATOR_ACCEPTED: "collaborator-accepted",
  COLLABORATOR_REMOVED: "collaborator-removed",
  // #1580 C-P1-7 — to the host when a collaborator withdraws their own row.
  COLLABORATOR_WITHDRAWN: "collaborator-withdrawn",
  // #1580 C-P1-5 — to the host when an invitee declines.
  COLLABORATOR_DECLINED: "collaborator-declined",

  // Maintenance
  MAINTENANCE_SCHEDULED: "maintenance-scheduled",
  MAINTENANCE_STARTED: "maintenance-started",
  MAINTENANCE_ENDED: "maintenance-ended",

  // Enterprise (arch-4) — org-scoped events. Workflow definitions must
  // exist in the Novu dashboard with the matching slug; each is one
  // in-app + optional email step. Delivery-channel routing is Novu's
  // responsibility — the app just triggers with payload.
  ORG_INVITE_SENT: "org-invite-sent",
  ORG_INVITE_ACCEPTED: "org-invite-accepted",
  ORG_INVOICE_ISSUED: "org-invoice-issued",
  ORG_INVOICE_PAID: "org-invoice-paid",
  // #779 §A — dunning. ISSUED→OVERDUE first-notice + the escalating
  // 7-day reminders share one workflow; `reminderStage` drives the copy.
  ORG_INVOICE_OVERDUE: "org-invoice-overdue",
  // #779 §A — a CHARGE_MEMBER overage side-charge hit its 14-day timeout
  // (PENDING→FAILED). In-app to the member only (their obligation lapsed).
  ORG_MEMBER_OVERAGE_TIMED_OUT: "org-member-overage-timed-out",
  ORG_LICENSE_RENEWAL_UPCOMING: "org-license-renewal-upcoming",
  ORG_DATA_EXPORT_READY: "org-data-export-ready",
  ORG_WALLET_TOPUP_CONFIRMED: "org-wallet-topup-confirmed",
  // #777 §C — wallet dipped below its configured minimum. NOTIFY-ONLY floor:
  // tells finance to top up; the auto-charge lands with payment mandates.
  ORG_WALLET_LOW: "org-wallet-low",
  ORG_PAYOUT_COMPLETED: "org-payout-completed",
  ORG_PAYOUT_FAILED: "org-payout-failed",
  ORG_PAYOUT_REVERSED: "org-payout-reversed",
  ORG_PROGRAM_EXHAUSTED: "org-program-exhausted",
  // #768 lockdown #22 — 80% early-warning sibling of ORG_PROGRAM_EXHAUSTED.
  // Fires once per cycle on the <80% → >=80% transition so operators can
  // upsize before bookings actually start getting refused at 100%.
  ORG_PROGRAM_CAP_NEAR: "org-program-cap-near",
  // #775 — a CHARGE_MEMBER over-cap booking created a side-charge the member
  // now owes. In-app to the member only (their personal payment obligation).
  ORG_PROGRAM_OVERAGE_DUE: "org-program-overage-due",
  ORG_SSO_PROVIDER_DELETED: "org-sso-provider-deleted",
  ORG_SSO_CERT_EXPIRING: "org-sso-cert-expiring",
  // A7: notify the consultant that their EXPERT membership at an org was
  // soft-deleted. Triggered from the member DELETE handler.
  ORG_EXPERT_REMOVED: "org-expert-removed",
} as const;

// ============================================================================
// Notification scope
// ============================================================================

/**
 * Which dashboard owns the work a notification is about.
 *
 * ADR 19 splits the dashboards by the org-ness of the underlying session, plan
 * or payment, but the notification layer never learned the split: one Novu
 * subscriber per user, no org field on any payload, and an Inbox with no
 * filter. A consultant who also delivers for an organization got one merged
 * feed in which an org-session booking was byte-identical to a B2C one.
 *
 * Every payload for work that can happen in both contexts carries this. It is
 * REQUIRED rather than optional on purpose — an omission should fail the build
 * at the call site, not silently produce another unattributable notification.
 *
 * `scope` is derivable from `organizationId` and is stored anyway: Novu's Inbox
 * filters tabs on payload equality, and "this field is null" is not expressible
 * that way. Use {@link notificationScope} so the two can never disagree.
 */
export type NotificationScope = {
  /** Null for B2C work. Copied from the triggering record's own column. */
  organizationId: string | null;
  scope: "personal" | "org";
  /** Display name of the owning org. Absent for personal work. */
  orgName?: string;
};

export function notificationScope(
  organizationId: string | null | undefined,
  orgName?: string | null,
): NotificationScope {
  const orgId = organizationId ?? null;
  return {
    organizationId: orgId,
    scope: orgId ? "org" : "personal",
    ...(orgId && orgName ? { orgName } : {}),
  };
}

// ============================================================================
// Payload Type Definitions
// ============================================================================

/**
 * What the `appointment-*` templates render.
 *
 * #536 — every field here is the value a customer reads. `appointmentType` is a
 * label ("consultation"), not the enum; `dateTime` is a sentence such as
 * "Sat, 6 Sep 2026 · 7:53 AM IST" rendered in the RECIPIENT's zone, not an ISO
 * timestamp. The machine-readable originals travel alongside under a
 * unit-suffixed name so a consumer that has to branch or compute still can.
 *
 * Callers do not build this type. They pass {@link AppointmentPayloadInput} —
 * raw values straight off the record — and `lib/novu/service.ts` renders it
 * once per distinct recipient timezone.
 */
export type AppointmentPayload = NotificationScope & {
  appointmentId?: string;
  /** Sentence-ready label, e.g. "consultation". */
  appointmentType: string;
  /** The raw `AppointmentsType` member, for consumers that branch on it. */
  appointmentTypeCode?: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  /** Friendly, in the recipient's timezone. */
  dateTime?: string;
  /** ISO 8601 copy of `dateTime`. */
  dateTimeIso?: string;
  dashboardUrl: string;
};

/**
 * The caller-facing half of {@link AppointmentPayload}: `appointmentType` is
 * the raw enum member and `dateTime` is an ISO 8601 instant. Both are converted
 * at the trigger boundary, so no call site has to know the house date format or
 * the label table.
 */
export type AppointmentPayloadInput = Omit<
  AppointmentPayload,
  "appointmentTypeCode" | "dateTimeIso"
>;

/**
 * #1206 — only SOME of the plan's sessions have times yet. The consultant was
 * shown the shortfall and chose to place what fits, so the consultee has to be
 * told the same thing: a bare "you're booked" on a 4-of-24 schedule reads as a
 * complete booking and they would never learn otherwise. The counts are whole
 * sessions, the unit both parties reason in.
 */
export type AppointmentPartiallyScheduledPayload = AppointmentPayload & {
  placedSessions: number;
  requiredSessions: number;
  unplacedSessions: number;
};

export type AppointmentPartiallyScheduledInput = AppointmentPayloadInput & {
  placedSessions: number;
  requiredSessions: number;
  unplacedSessions: number;
};

export type AppointmentCancelledPayload = AppointmentPayload & {
  /**
   * Always present. The live template ends on "Reason: {{reason}}", so an
   * absent value left the sentence hanging on a colon; "No reason given"
   * stands in when the caller has nothing to say.
   */
  reason: string;
  /**
   * A noun the template can print, e.g. "Sarah Chen" or "the platform". The
   * live template renders this value straight into its sentence, and one
   * payload reaches both parties, so it names the person rather than taking a
   * side ("your consultant" is false for the consultant reading it).
   */
  cancelledBy: string;
  /** The raw discriminator, for templates that branch on who acted. */
  cancelledByRole?: "consultant" | "consultee" | "system";
};

export type AppointmentCancelledInput = AppointmentPayloadInput & {
  reason?: string;
  cancelledBy: "consultant" | "consultee" | "system";
};

/**
 * Which of the three reschedule outcomes happened, and therefore which sentence
 * the `appointment-rescheduled` template must render.
 *
 * A reschedule does not always have a destination. "Any time works" is the
 * common case — the slots go back to the consultant's queue and no new time
 * exists yet — so a template that always says "moved from X to Y" has nothing
 * to put in either blank. The discriminator makes that a template branch rather
 * than two empty interpolations, the same way `OrgInvoiceOverduePayload`
 * (`reminderStage`) and `OrgPayoutFailedPayload` (`kind`) drive their copy.
 *
 * The arms are unions rather than optional fields on purpose: MOVED and
 * PROPOSED cannot be constructed without both times, so the blank-blank payload
 * that produced "from&nbsp;&nbsp;to" is now a compile error.
 */
export type RescheduleOutcomeFields =
  | {
      /** MOVED: auto-confirmed, the booking now holds `newDateTime`.
       *  PROPOSED: `newDateTime` was asked for and awaits the other party. */
      outcome: "MOVED" | "PROPOSED";
      oldDateTime: string;
      newDateTime: string;
    }
  | {
      /** Slots released with no replacement time — awaiting a new one. */
      outcome: "RELEASED";
      oldDateTime?: string;
      newDateTime?: never;
    }
  | {
      /** PR 2e — the proposal was declined or withdrawn; the booking stays
       *  at its original times (or is in the consultant's queue if slots
       *  were released). No destination time exists. */
      outcome: "DECLINED" | "WITHDRAWN";
      oldDateTime?: string;
      newDateTime?: never;
    };

// `dateTime` from AppointmentPayload is deliberately unused here: a reschedule
// is about the pair of times, not a single one.
export type AppointmentRescheduledInput = AppointmentPayloadInput &
  RescheduleOutcomeFields;

/**
 * #1085 — what the `appointment-rescheduled` template actually receives.
 *
 * `newDateTime` is REQUIRED here even though three of the five outcomes have no
 * destination time, because the template renders "from X to Y" unconditionally
 * and an absent field rendered as "from&nbsp;&nbsp;to". The outcomes without a
 * destination get a phrase instead of a timestamp ("a new time your consultant
 * will confirm"), so the sentence always completes. The discriminated
 * {@link RescheduleOutcomeFields} input keeps its compile-time guarantee that a
 * caller cannot invent a time that does not exist — only the trigger boundary
 * may substitute the phrase.
 */
export type AppointmentRescheduledPayload = AppointmentPayload & {
  outcome: RescheduleOutcomeFields["outcome"];
  /** Friendly, in the recipient's timezone. Absent if the source time is unknown. */
  oldDateTime?: string;
  oldDateTimeIso?: string;
  /** Friendly time, or the awaiting-a-time phrase. Never blank. */
  newDateTime: string;
  /** Present only when `newDateTime` is a real instant. */
  newDateTimeIso?: string;
};

/*
 * #536 — money comes in two shapes here, and the difference is not arbitrary.
 *
 * `PaymentSuccessPayload`, `PaymentFailedPayload` and `RefundPayload` feed the
 * four live in-app templates that already print `{{currency}} {{amount}}`
 * themselves. Those templates cannot be edited on the current Novu plan, so
 * their `amount` is the bare figure and the ISO code the template prints is the
 * only currency marker; `amountFormatted` carries the symbol-bearing string for
 * whichever template is written next.
 *
 * Every other money payload — `PayoutPayload`, `DisputePayload`, the referral
 * payloads and the organisation ones — puts the symbol in `amount`, because no
 * template prints a currency code beside it.
 */
export type PaymentSuccessPayload = NotificationScope & {
  /**
   * The figure WITHOUT a symbol, e.g. "55,679.48". The live template renders
   * `{{currency}} {{amount}}`, so a symbol here would read "INR ₹55,679.48".
   */
  amount: string;
  /** The same figure WITH the symbol, e.g. "₹55,679.48". */
  amountFormatted: string;
  /** The same amount in integer minor units, for consumers doing arithmetic. */
  amountPaise: number;
  currency: string;
  consultantName: string;
  /** Sentence-ready label, e.g. "subscription session". */
  appointmentType: string;
  appointmentTypeCode?: string;
  planTitle: string;
  receiptUrl?: string;
  dashboardUrl: string;
};

/** Callers pass integer minor units and the raw enum; see {@link PaymentSuccessPayload}. */
export type PaymentSuccessInput = Omit<
  PaymentSuccessPayload,
  "amount" | "amountFormatted" | "amountPaise" | "appointmentTypeCode"
> & {
  amount: number;
};

export type PaymentFailedPayload = {
  /** Symbol-free; the live template supplies `{{currency}}` itself. */
  amount: string;
  amountFormatted: string;
  amountPaise: number;
  currency: string;
  consultantName: string;
  appointmentType: string;
  appointmentTypeCode?: string;
  planTitle?: string;
  failureReason: string;
  retryUrl?: string;
};

export type PaymentFailedInput = Omit<
  PaymentFailedPayload,
  "amount" | "amountFormatted" | "amountPaise" | "appointmentTypeCode"
> & {
  amount: number;
};

export type RefundPayload = NotificationScope & {
  /** Symbol-free; the live templates supply `{{currency}}` themselves. */
  amount: string;
  amountFormatted: string;
  amountPaise: number;
  currency: string;
  reason?: string;
  appointmentType?: string;
  appointmentTypeCode?: string;
  consultantName?: string;
  dashboardUrl: string;
};

export type RefundInput = Omit<
  RefundPayload,
  "amount" | "amountFormatted" | "amountPaise" | "appointmentTypeCode"
> & {
  amount: number;
};

export type SupportTicketPayload = NotificationScope & {
  ticketId: string;
  ticketTitle: string;
  status?: string;
  message?: string;
  respondedBy?: string;
  dashboardUrl: string;
};

export type FeedbackPayload = {
  feedbackId: string;
  userName: string;
  category?: string;
  message: string;
  dashboardUrl: string;
};

export type ReviewPayload = {
  reviewerName: string;
  rating: number;
  comment?: string;
  planTitle?: string;
  dashboardUrl: string;
};

export type TrialSessionPayload = {
  consultantName: string;
  consulteeName: string;
  /** The parent subscription plan's title — never its id (#536). */
  planTitle: string;
  /** Friendly, in the recipient's timezone. */
  dateTime?: string;
  /** ISO 8601 copy of `dateTime`. */
  dateTimeIso?: string;
  /** Sentence-ready status label, e.g. "awaiting payment". */
  status: string;
  /** The raw `TrialSessionStatus` member. */
  statusCode?: string;
  dashboardUrl: string;
};

/** Callers pass an ISO instant and the raw status; see {@link TrialSessionPayload}. */
export type TrialSessionInput = Omit<
  TrialSessionPayload,
  "dateTimeIso" | "statusCode"
>;

export type SubscriptionPayload = {
  subscriptionId?: string;
  planTitle: string;
  consultantName: string;
  consulteeName?: string;
  dashboardUrl: string;
};

export type BookingRequestPayload = NotificationScope & {
  consulteeName: string;
  planTitle: string;
  /** Sentence-ready label, e.g. "consultation". */
  appointmentType: string;
  appointmentTypeCode?: string;
  /** Friendly, in the recipient's timezone. */
  requestedDateTime?: string;
  /** ISO 8601 copy of `requestedDateTime`. */
  requestedDateTimeIso?: string;
  dashboardUrl: string;
};

export type BookingRequestInput = Omit<
  BookingRequestPayload,
  "appointmentTypeCode" | "requestedDateTimeIso"
>;

export type VerificationPayload = {
  status: string;
  reason?: string;
  dashboardUrl: string;
};

// Moderation (#693)
export type ModerationWarningPayload = {
  reason?: string;
};

export type AccountSuspendedPayload = {
  reason?: string;
  /**
   * Friendly, in the recipient's timezone — the date they get their account
   * back, or "further notice" when the suspension has no end date.
   */
  suspendedUntil: string;
  /** ISO timestamp the suspension lapses (lazy expiry at sign-in); absent when indefinite. */
  suspendedUntilIso?: string;
  appointmentsCancelled?: number;
};

export type AccountSuspendedInput = Omit<
  AccountSuspendedPayload,
  "suspendedUntilIso"
>;

export type AccountBannedPayload = {
  reason?: string;
  appointmentsCancelled?: number;
};

export type PayoutPayload = {
  /** Money as the consultant reads it, e.g. "₹12,400.00". */
  amount: string;
  amountPaise: number;
  currency: string;
  payoutId?: string;
  dashboardUrl: string;
};

export type PayoutInput = Omit<PayoutPayload, "amount" | "amountPaise"> & {
  amount: number;
};

export type AnnouncementPayload = {
  title: string;
  content: string;
  linkUrl?: string;
  linkText?: string;
};

export type DisputePayload = {
  disputeId?: string;
  amount: string;
  amountPaise: number;
  currency: string;
  reason?: string;
  status?: string;
  consultantName?: string;
  consulteeName?: string;
  dashboardUrl: string;
};

export type DisputeInput = Omit<DisputePayload, "amount" | "amountPaise"> & {
  amount: number;
};

export type RecordingPayload = NotificationScope & {
  /** Sentence-ready label, e.g. "class". */
  appointmentType: string;
  appointmentTypeCode?: string;
  consultantName: string;
  consulteeName?: string;
  recordingUrl: string;
  dashboardUrl: string;
};

export type RecordingFailedPayload = {
  streamCallId: string;
  errorMessage?: string;
  dashboardUrl: string;
};

// STR-3 — one notification per consultant summarising how many of their
// STREAM_ONLY recordings expire soon. `expiresAt` is the soonest expiry in the
// batch so the copy can lead with the nearest deadline.
export type RecordingExpiringPayload = {
  recordingCount: number;
  /** Friendly, in the recipient's timezone. */
  expiresAt: string;
  /** ISO 8601 copy of `expiresAt`. */
  expiresAtIso?: string;
  dashboardUrl: string;
};

export type RecordingExpiringInput = Omit<
  RecordingExpiringPayload,
  "expiresAtIso"
>;

/**
 * Fired when a document lands on an appointment (consultee submission,
 * consultee revision, or consultant response). Recipient is the other
 * party — the reviewer for consultee uploads, the uploader for responses.
 */
export type DocumentUploadedPayload = NotificationScope & {
  appointmentId: string;
  documentId: string;
  uploadedByRole: "CONSULTEE" | "CONSULTANT";
  /** Original filename as uploaded. */
  fileName: string;
  /** True when threaded onto an existing review (revision or response). */
  isThreaded: boolean;
  /** 1-based sequence within the review thread. */
  versionNo: number;
  consultantName: string;
  consulteeName: string;
  dashboardUrl: string;
};

/**
 * Fired when a consultant changes a document's review status. Recipient is
 * the consultee who submitted it. `reviewStatus` is the NEW status; templates
 * branch on it (approved / rejected / needs-revision / in-review).
 */
export type DocumentReviewedPayload = NotificationScope & {
  appointmentId: string;
  documentId: string;
  reviewStatus:
    | "PENDING"
    | "IN_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "NEEDS_REVISION";
  reviewNotes?: string;
  originalName: string;
  consultantName: string;
  dashboardUrl: string;
};

export type ConsultantApplicationPayload = {
  applicantName: string;
  applicantEmail: string;
  dashboardUrl: string;
};

export type ReferralBonusPayload = {
  referrerName: string;
  refereeName: string;
  /** Money as the referrer reads it, e.g. "₹500.00". */
  bonusAmount: string;
  bonusAmountPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type ReferralBonusInput = Omit<
  ReferralBonusPayload,
  "bonusAmount" | "bonusAmountPaise"
> & { bonusAmount: number };

export type RefereeWelcomeBonusPayload = {
  refereeName: string;
  referrerName: string;
  bonusAmount: string;
  bonusAmountPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type RefereeWelcomeBonusInput = Omit<
  RefereeWelcomeBonusPayload,
  "bonusAmount" | "bonusAmountPaise"
> & { bonusAmount: number };

export type ReferralCreditsAppliedPayload = {
  /** Money as the buyer reads it, e.g. "₹250.00". */
  creditsUsed: string;
  creditsUsedPaise: number;
  currency: string;
  remainingCredits: string;
  remainingCreditsPaise: number;
  /** Sentence-ready label, e.g. "consultation". */
  appointmentType: string;
  appointmentTypeCode?: string;
  dashboardUrl: string;
};

export type ReferralCreditsAppliedInput = Omit<
  ReferralCreditsAppliedPayload,
  | "creditsUsed"
  | "creditsUsedPaise"
  | "remainingCredits"
  | "remainingCreditsPaise"
  | "appointmentTypeCode"
> & { creditsUsed: number; remainingCredits: number };

export type CollaboratorInvitedPayload = {
  planTitle: string;
  planType: string;
  role: string;
  revenueSharePercentage: number;
  ownerName: string;
  dashboardUrl: string;
};

export type CollaboratorAcceptedPayload = {
  planTitle: string;
  planType: string;
  collaboratorName: string;
  role: string;
  dashboardUrl: string;
};

/** The host's copy of a decline; the same shape as the accept. */
export type CollaboratorDeclinedPayload = CollaboratorAcceptedPayload;

export type CollaboratorRemovedPayload = {
  planTitle: string;
  planType: string;
  dashboardUrl: string;
};

/** The host's copy of a withdrawal; the removed shape plus who withdrew. */
export type CollaboratorWithdrawnPayload = CollaboratorRemovedPayload & {
  collaboratorName: string;
};

export type MaintenancePayload = {
  phase: string;
  reason?: string;
  /**
   * Friendly. A maintenance notice is broadcast to every subscriber at once, so
   * there is no single recipient whose zone could be used — it renders in the
   * platform default zone and names it (#536).
   */
  estimatedEnd?: string;
  /** ISO 8601 copy of `estimatedEnd`. */
  estimatedEndIso?: string;
};

export type MaintenanceInput = Omit<MaintenancePayload, "estimatedEndIso">;

// ============================================================================
// Enterprise (arch-4) Payload Types
// ============================================================================

/*
 * #536 — the org payloads follow the same naming rule as the B2C ones: a
 * template interpolates the unit-free name and gets a human value, while the
 * unit-suffixed sibling keeps the machine value.
 *
 * Money is the one place the two families differ in migration cost. These
 * fields were named `*Paise` from the start, so the value they carry is honest
 * and cannot simply be replaced with a string; the human amount arrives as a
 * NEW unit-free field (`totalPaise` keeps the integer, `total` gains
 * "₹12,400.00"). The org templates therefore need a one-line dashboard edit to
 * read the new name — tracked in the pull request that introduced this rule.
 * Dates need no such edit: they were never unit-suffixed, so the existing field
 * now carries the sentence and the ISO copy moves to `*Iso`.
 */

export type OrgInviteSentPayload = {
  inviterName: string;
  orgName: string;
  role: string;
  inviteUrl: string;
  /** Friendly. Delivered by email to someone with no account, so no recipient
   *  zone exists — rendered in the platform default zone, which it names. */
  expiresAt: string;
  expiresAtIso?: string;
};

export type OrgInviteSentInput = Omit<OrgInviteSentPayload, "expiresAtIso">;

export type OrgInviteAcceptedPayload = {
  accepteeName: string;
  accepteeEmail: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
};

export type OrgInvoiceIssuedPayload = {
  invoiceNumber: string;
  orgName: string;
  /** Money as the payer reads it, e.g. "₹12,400.00". */
  total: string;
  totalPaise: number;
  currency: string;
  /** Friendly, in the recipient's timezone. */
  dueDate: string;
  dueDateIso?: string;
  dashboardUrl: string;
  /** #438 — deep link to the invoice PDF route (302s to a signed URL). */
  pdfUrl?: string;
};

export type OrgInvoiceIssuedInput = Omit<
  OrgInvoiceIssuedPayload,
  "total" | "dueDateIso"
>;

export type OrgInvoicePaidPayload = {
  invoiceNumber: string;
  orgName: string;
  total: string;
  totalPaise: number;
  currency: string;
  /** Friendly, in the recipient's timezone. */
  paidAt: string;
  paidAtIso?: string;
  dashboardUrl: string;
};

export type OrgInvoicePaidInput = Omit<
  OrgInvoicePaidPayload,
  "total" | "paidAtIso"
>;

// #779 §A — dunning notice. `reminderStage` is 0 for the first OVERDUE
// notice and 1..3 for the escalating 7-day reminders so the template can
// ramp the urgency copy. `daysLate` is days since dueDate; `payUrl` deep-
// links to the invoice pay surface.
export type OrgInvoiceOverduePayload = {
  invoiceNumber: string;
  orgName: string;
  total: string;
  totalPaise: number;
  currency: string;
  daysLate: number;
  reminderStage: number;
  payUrl: string;
};

export type OrgInvoiceOverdueInput = Omit<OrgInvoiceOverduePayload, "total">;

// #779 §A — a member-owed overage side-charge timed out (PENDING→FAILED)
// after 14 days unpaid. `payUrl` still points at the settle surface (the
// member can retry via FAILED→PENDING resume-checkout).
export type OrgMemberOverageTimedOutPayload = {
  orgName: string;
  programName: string;
  amount: string;
  amountPaise: number;
  currency: string;
  payUrl: string;
};

export type OrgMemberOverageTimedOutInput = Omit<
  OrgMemberOverageTimedOutPayload,
  "amount"
>;

export type OrgLicenseRenewalUpcomingPayload = {
  orgName: string;
  /** Sentence-ready label, e.g. "monthly". */
  cycle: string;
  cycleCode?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  /** Friendly, in the recipient's timezone. */
  renewalDate: string;
  renewalDateIso?: string;
  daysUntilRenewal: number;
  expectedTotal: string;
  expectedTotalPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type OrgLicenseRenewalUpcomingInput = Omit<
  OrgLicenseRenewalUpcomingPayload,
  "cycle" | "cycleCode" | "renewalDateIso" | "expectedTotal"
> & { cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL" };

export type OrgDataExportReadyPayload = {
  orgName: string;
  exportId: string;
  fileSizeBytes: number;
  /** Friendly, in the recipient's timezone. */
  expiresAt: string;
  expiresAtIso?: string;
  downloadUrl: string;
  dashboardUrl: string;
};

export type OrgDataExportReadyInput = Omit<
  OrgDataExportReadyPayload,
  "expiresAtIso"
>;

export type OrgWalletTopupConfirmedPayload = {
  orgName: string;
  amount: string;
  amountPaise: number;
  currency: string;
  newBalance: string;
  newBalancePaise: number;
  dashboardUrl: string;
};

export type OrgWalletTopupConfirmedInput = Omit<
  OrgWalletTopupConfirmedPayload,
  "amount" | "newBalance"
>;

// #777 §C — wallet low-balance alert. `balancePaise` is the live balance that
// tripped the floor; `minimumPaise` is the configured threshold. NOTIFY-ONLY —
// no money moves until mandates land. `topUpUrl` deep-links to the wallet tab.
export type OrgWalletLowPayload = {
  orgName: string;
  balance: string;
  balancePaise: number;
  minimum: string;
  minimumPaise: number;
  currency: string;
  topUpUrl: string;
};

export type OrgWalletLowInput = Omit<
  OrgWalletLowPayload,
  "balance" | "minimum"
>;

export type OrgPayoutCompletedPayload = {
  orgName: string;
  payoutId: string;
  amount: string;
  amountPaise: number;
  currency: string;
  dashboardUrl: string;
};

export type OrgPayoutCompletedInput = Omit<OrgPayoutCompletedPayload, "amount">;

export type OrgProgramExhaustedPayload = {
  orgName: string;
  programName: string;
  assigneeName: string;
  dashboardUrl: string;
};

// #768 lockdown #22 — early-warning payload. `usedPct` is the post-booking
// utilization ratio (0-100) that crossed the 80% line; `engagementsUsed` /
// `cap` let the template render "41 of 50 sessions used".
export type OrgProgramCapNearPayload = {
  orgName: string;
  programName: string;
  assigneeName: string;
  engagementsUsed: number;
  cap: number;
  usedPct: number;
  dashboardUrl: string;
};

// #775 — CHARGE_MEMBER overage side-charge owed by the member. `amountPaise`
// is the marginal (incl. surcharge); `payUrl` deep-links to the pay surface.
export type OrgProgramOverageDuePayload = {
  orgName: string;
  programName: string;
  /** Money as the member reads it. Settlement is INR-only, so no currency
   *  field exists to disagree with. */
  amount: string;
  amountPaise: number;
  payUrl: string;
};

export type OrgProgramOverageDueInput = Omit<
  OrgProgramOverageDuePayload,
  "amount"
>;

export type OrgSsoProviderDeletedPayload = {
  orgName: string;
  providerId: string;
  deletedByName: string;
  dashboardUrl: string;
};

export type OrgSsoCertExpiringPayload = {
  orgName: string;
  providerId: string;
  daysRemaining: number;
  severity: "WARN" | "CRITICAL" | "EXPIRED";
  /** Friendly, in the recipient's timezone. */
  notAfter: string;
  notAfterIso?: string;
  dashboardUrl: string;
};

export type OrgSsoCertExpiringInput = Omit<
  OrgSsoCertExpiringPayload,
  "notAfterIso"
>;

// A1+A8: discriminated payload for the failed/reversed payout webhook
// fan-out. `kind` distinguishes a gateway rejection (FAILED) from a bank
// reversal (REVERSED) so the Novu template can render the right copy.
export type OrgPayoutFailedPayload = {
  orgName: string;
  payoutId: string;
  amount: string;
  amountPaise: number;
  currency: string;
  reason: string;
  kind: "FAILED" | "REVERSED";
  dashboardUrl: string;
};

export type OrgPayoutFailedInput = Omit<OrgPayoutFailedPayload, "amount">;

// A7: payload for the EXPERT-removed-from-org notification. `removedByName`
// is the operator who triggered the soft-delete (or "system" for cron-
// driven removals such as contract expiry). `reason` is optional free-text.
export type OrgExpertRemovedPayload = {
  orgName: string;
  orgSlug: string;
  removedByName: string;
  reason: string | null;
  dashboardUrl: string;
};
