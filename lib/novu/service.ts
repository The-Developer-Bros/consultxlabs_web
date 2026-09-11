/**
 * Novu Notification Service
 * High-level methods for triggering notifications in business logic.
 * Non-throwing: logs errors and returns success/failure status.
 * Pattern follows lib/email.ts (graceful degradation).
 */
import { createHash } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { getNovuClient, isNovuConfigured } from "./client";
import {
  NOVU_WORKFLOWS,
  type AccountBannedPayload,
  type AccountSuspendedInput,
  type AccountSuspendedPayload,
  type AnnouncementPayload,
  type AppointmentCancelledInput,
  type AppointmentCancelledPayload,
  type AppointmentPartiallyScheduledInput,
  type AppointmentPartiallyScheduledPayload,
  type AppointmentPayload,
  type AppointmentPayloadInput,
  type AppointmentRescheduledInput,
  type AppointmentRescheduledPayload,
  type BookingRequestInput,
  type BookingRequestPayload,
  type CollaboratorAcceptedPayload,
  type CollaboratorInvitedPayload,
  type CollaboratorRemovedPayload,
  type ConsultantApplicationPayload,
  type DisputeInput,
  type DisputePayload,
  type DocumentReviewedPayload,
  type DocumentUploadedPayload,
  type FeedbackPayload,
  type MaintenanceInput,
  type MaintenancePayload,
  type ModerationWarningPayload,
  type OrgExpertRemovedPayload,
  type PaymentFailedInput,
  type PaymentFailedPayload,
  type PaymentSuccessInput,
  type PaymentSuccessPayload,
  type PayoutInput,
  type PayoutPayload,
  type RecordingExpiringInput,
  type RecordingExpiringPayload,
  type RecordingFailedPayload,
  type RecordingPayload,
  type RefereeWelcomeBonusInput,
  type RefereeWelcomeBonusPayload,
  type ReferralBonusInput,
  type ReferralBonusPayload,
  type ReferralCreditsAppliedInput,
  type ReferralCreditsAppliedPayload,
  type RefundInput,
  type RefundPayload,
  type ReviewPayload,
  type RescheduleOutcomeFields,
  type SubscriptionPayload,
  type SupportTicketPayload,
  type TrialSessionInput,
  type TrialSessionPayload,
  type VerificationPayload,
} from "./workflows";
import {
  appointmentTypeLabel,
  cancellationReasonLabel,
  cancelledByLabel,
  DEFAULT_NOTIFICATION_TIMEZONE,
  formatNotificationAmountBare,
  formatNotificationDateTime,
  formatNotificationMoney,
  groupRecipientsByTimezone,
  resolveRecipientTimezones,
} from "./humanize";

// ============================================================================
// Core trigger function
// ============================================================================

/** Payload base type — all workflow payloads extend this. */
type NovuPayload = Record<string, string | number | boolean | null | undefined>;

interface TriggerResult {
  success: boolean;
  error?: Error | string;
}

// Unconfigured Novu in a deployed env means notifications silently vanish —
// a console.warn nobody reads is not enough. Local dev stays console-only.
function reportNotConfigured(workflowId: string): void {
  console.warn(`[Novu] Not configured. Skipped workflow: ${workflowId}`);
  if (process.env.NODE_ENV === "production") {
    Sentry.captureMessage(`[Novu] Not configured — dropped ${workflowId}`, {
      level: "warning",
      tags: { subsystem: "novu" },
    });
  }
}

/**
 * What the SDK actually told us about a failed trigger.
 *
 * `@novu/api` validates the RESPONSE against its own generated Zod schema and
 * throws `ResponseValidationError` before handing back the status. Its 422
 * schema requires an `errors` record, but the two 422s Novu documents for this
 * endpoint — an unknown or unpublished workflow (`workflow_not_found`) and an
 * idempotency key reused with a different body — both answer with `statusCode`
 * and `message` only. So all that reached Sentry was a ZodError about a field
 * of the SDK's own error envelope: the status and Novu's reason were both lost
 * (FAMILIARISE_WEB-1B). No published `@novu/api` relaxes that field (checked
 * through 3.19.1), so read the status off the error instead of chasing a bump.
 *
 * Duck-typed on `statusCode`: every `NovuError` subclass carries it, and the
 * class itself is not re-exported from the package root, so an `instanceof`
 * would mean deep-importing generated internals.
 */
function describeNovuFailure(error: unknown): {
  statusCode?: number;
  /** Novu's own error text. Never the whole body — it can echo payload values. */
  novuMessage?: string;
  /** True when the SDK rejected a body Novu had already accepted. */
  accepted: boolean;
} {
  if (!error || typeof error !== "object") return { accepted: false };
  const { statusCode, body } = error as {
    statusCode?: unknown;
    body?: unknown;
  };
  if (typeof statusCode !== "number") return { accepted: false };

  let novuMessage: string | undefined;
  if (typeof body === "string" && body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body);
      const message =
        parsed && typeof parsed === "object"
          ? (parsed as { message?: unknown }).message
          : undefined;
      if (typeof message === "string") novuMessage = message.slice(0, 200);
    } catch {
      // Not JSON (an HTML gateway page); the status alone is the signal.
    }
  }

  return {
    statusCode,
    novuMessage,
    accepted: statusCode >= 200 && statusCode < 300,
  };
}

/**
 * One report shape for every `novu.trigger` failure. `accepted` means the
 * notification is already queued at Novu and only the SDK's response parsing
 * failed, so it is an expected outcome rather than a lost notification.
 */
function reportTriggerFailure(
  error: unknown,
  workflowId: string,
  recipientCount: number,
): { accepted: boolean } {
  const { statusCode, novuMessage, accepted } = describeNovuFailure(error);
  // Never pass the raw SDK error: `NovuError.body` is the submitted payload
  // echoed back on validation failures, so it can carry notification PII.
  console.error(`[Novu] Failed to trigger ${workflowId}:`, {
    workflowId,
    statusCode,
    novuMessage,
    recipientCount,
    accepted,
  });
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    {
      tags: {
        subsystem: "novu",
        op: "trigger",
        expected: String(accepted),
      },
      level: "warning",
      extra: { workflowId, statusCode, novuMessage, recipientCount },
    },
  );
  return { accepted };
}

// Deterministic transactionId so app-level retries can't double-notify: Novu
// rejects a repeated transactionId. Derived from recipient(s) + workflow +
// canonical payload (the payloads carry the entity ids). `dedupeKey` lets a
// caller that legitimately re-sends an identical payload (e.g. 24h vs 1h
// appointment reminders) disambiguate the sends.
function deriveTransactionId(
  workflowId: string,
  recipients: string | string[],
  payload: NovuPayload,
  dedupeKey?: string,
): string {
  const canonicalPayload = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const recipientKey = Array.isArray(recipients)
    ? recipients.toSorted((a, b) => a.localeCompare(b)).join(",")
    : recipients;
  const hash = createHash("sha256")
    .update(`${workflowId}|${recipientKey}|${dedupeKey ?? canonicalPayload}`)
    .digest("hex");
  return `${workflowId}:${hash.slice(0, 32)}`;
}

async function triggerWorkflow<T extends NovuPayload>(
  workflowId: string,
  subscriberId: string,
  payload: T,
  dedupeKey?: string,
): Promise<TriggerResult> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return { success: false, error: "Novu not configured" };
  }

  try {
    const novu = getNovuClient();
    await novu.trigger({
      workflowId,
      to: subscriberId,
      payload,
      transactionId: deriveTransactionId(
        workflowId,
        subscriberId,
        payload,
        dedupeKey,
      ),
    });
    console.log(`[Novu] Triggered ${workflowId} for ${subscriberId}`);
    return { success: true };
  } catch (error) {
    // A 2xx the SDK could not parse still queued the notification; reporting it
    // as a failed send made callers retry a send Novu had already accepted.
    if (reportTriggerFailure(error, workflowId, 1).accepted) {
      return { success: true };
    }
    return {
      success: false,
      error: error instanceof Error ? error : String(error),
    };
  }
}

/**
 * Helper to trigger the same workflow for multiple users (e.g. both parties).
 * Uses a single API call with array `to` field (max 100 per call).
 */
async function triggerForMultiple<T extends NovuPayload>(
  workflowId: string,
  userIds: string[],
  payload: T,
  dedupeKey?: string,
): Promise<TriggerResult[]> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return userIds.map(() => ({
      success: false,
      error: "Novu not configured" as const,
    }));
  }

  if (userIds.length === 0) return [];
  if (userIds.length === 1)
    return [await triggerWorkflow(workflowId, userIds[0], payload, dedupeKey)];

  const BATCH_SIZE = 100;
  const results: TriggerResult[] = [];

  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);
    try {
      const novu = getNovuClient();
      await novu.trigger({
        workflowId,
        to: batch,
        payload,
        transactionId: deriveTransactionId(
          workflowId,
          batch,
          payload,
          dedupeKey,
        ),
      });
      console.log(
        `[Novu] Triggered ${workflowId} for ${batch.length} subscribers`,
      );
      results.push(...batch.map(() => ({ success: true }) as TriggerResult));
    } catch (error) {
      if (reportTriggerFailure(error, workflowId, batch.length).accepted) {
        results.push(...batch.map(() => ({ success: true }) as TriggerResult));
        continue;
      }
      const err: TriggerResult = {
        success: false,
        error: error instanceof Error ? error : String(error),
      };
      results.push(...batch.map(() => err));
    }
  }

  return results;
}

/**
 * Trigger a broadcast workflow to all existing subscribers.
 * Uses Novu's triggerBroadcast API — no need to fetch user IDs.
 */
async function triggerBroadcastWorkflow<T extends NovuPayload>(
  workflowId: string,
  payload: T,
): Promise<TriggerResult> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return { success: false, error: "Novu not configured" };
  }

  try {
    const novu = getNovuClient();
    await novu.triggerBroadcast({
      name: workflowId,
      payload,
    });
    console.log(`[Novu] Broadcast triggered: ${workflowId}`);
    return { success: true };
  } catch (error) {
    console.error(`[Novu] Failed to broadcast ${workflowId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error : String(error),
    };
  }
}

// ============================================================================
// Customer-ready payloads (#536)
// ============================================================================

/**
 * Trigger once per distinct recipient timezone.
 *
 * `triggerForMultiple` sends ONE payload to a list of subscribers, so a
 * rendered date inside it can only be correct for whichever recipient happens
 * to share the zone it was rendered in. Every other recipient reads a time that
 * is not theirs. Splitting on the zone is cheaper than it looks: both parties
 * to a booking are usually in the same zone, so this is one trigger in the
 * common case and two in the cross-border one.
 *
 * The zones are loaded in a single query; see `resolveRecipientTimezones` for
 * why that read is bounded and never throws.
 */
async function triggerForMultipleZoned(
  workflowId: string,
  userIds: string[],
  build: (timezone: string) => NovuPayload,
  dedupeKey?: string,
): Promise<TriggerResult[]> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return userIds.map(() => ({
      success: false,
      error: "Novu not configured" as const,
    }));
  }
  if (userIds.length === 0) return [];

  const zones = await resolveRecipientTimezones(userIds);
  const results: TriggerResult[] = [];
  for (const [timezone, recipients] of groupRecipientsByTimezone(
    userIds,
    zones,
  )) {
    results.push(
      ...(await triggerForMultiple(
        workflowId,
        recipients,
        build(timezone),
        dedupeKey,
      )),
    );
  }
  return results;
}

/** Single-recipient sibling of {@link triggerForMultipleZoned}. */
async function triggerWorkflowZoned(
  workflowId: string,
  subscriberId: string,
  build: (timezone: string) => NovuPayload,
  dedupeKey?: string,
): Promise<TriggerResult> {
  if (!isNovuConfigured()) {
    reportNotConfigured(workflowId);
    return { success: false, error: "Novu not configured" };
  }
  const zones = await resolveRecipientTimezones([subscriberId]);
  const timezone = zones.get(subscriberId) ?? DEFAULT_NOTIFICATION_TIMEZONE;
  return triggerWorkflow(workflowId, subscriberId, build(timezone), dedupeKey);
}

/** Raw enum in, sentence label plus the original out. */
function appointmentWire(
  input: AppointmentPayloadInput,
  timezone: string,
): AppointmentPayload {
  // The raw instant is lifted out BEFORE the spread: the templates gate on
  // `{{#if payload.dateTime}}`, which any non-empty string satisfies, so a
  // value the formatter rejects must not ride through under the display key.
  // Omitted rather than blanked for the same reason.
  const { dateTime: rawDateTime, ...rest } = input;
  const dateTime = formatNotificationDateTime(rawDateTime, timezone);
  return {
    ...rest,
    appointmentType: appointmentTypeLabel(input.appointmentType),
    appointmentTypeCode: input.appointmentType,
    ...(dateTime ? { dateTime, dateTimeIso: rawDateTime } : {}),
  };
}

function partiallyScheduledWire(
  input: AppointmentPartiallyScheduledInput,
  timezone: string,
): AppointmentPartiallyScheduledPayload {
  return {
    ...appointmentWire(input, timezone),
    placedSessions: input.placedSessions,
    requiredSessions: input.requiredSessions,
    unplacedSessions: input.unplacedSessions,
  };
}

function cancelledWire(
  input: AppointmentCancelledInput,
  timezone: string,
): AppointmentCancelledPayload {
  return {
    ...appointmentWire(input, timezone),
    reason: cancellationReasonLabel(input.reason),
    cancelledBy: cancelledByLabel(input.cancelledBy, input),
    cancelledByRole: input.cancelledBy,
  };
}

/**
 * #1085 — what fills `newDateTime` when the outcome has no destination time.
 *
 * The `appointment-rescheduled` template renders "from X to Y" unconditionally,
 * and three of the five outcomes have no Y, which is how the inbox came to show
 * "rescheduled the CONSULTATION for Basic Consultation from&nbsp;&nbsp;to". A
 * phrase completes the sentence in every case. The MOVED and PROPOSED entries
 * are reachable only if a stored instant fails to parse, which would otherwise
 * reintroduce the blank.
 */
const RESCHEDULE_AWAITING_TIME: Record<
  RescheduleOutcomeFields["outcome"],
  string
> = {
  MOVED: "a new time your consultant will confirm",
  PROPOSED: "a new time your consultant will confirm",
  RELEASED: "a new time your consultant will confirm",
  DECLINED: "the time it was already booked for",
  WITHDRAWN: "the time it was already booked for",
};

function rescheduledWire(
  input: AppointmentRescheduledInput,
  timezone: string,
): AppointmentRescheduledPayload {
  // Both raw instants leave the input before it reaches `appointmentWire`, so
  // neither can survive that spread unformatted.
  const { oldDateTime: rawOld, newDateTime: rawNew, ...base } = input;
  const oldDateTime = formatNotificationDateTime(rawOld, timezone);
  const hasDestination =
    input.outcome === "MOVED" || input.outcome === "PROPOSED";
  const newDateTimeIso = hasDestination ? rawNew : undefined;
  const newDateTime = formatNotificationDateTime(newDateTimeIso, timezone);

  return {
    ...appointmentWire(base, timezone),
    outcome: input.outcome,
    ...(oldDateTime ? { oldDateTime, oldDateTimeIso: rawOld } : {}),
    newDateTime: newDateTime ?? RESCHEDULE_AWAITING_TIME[input.outcome],
    ...(newDateTime ? { newDateTimeIso } : {}),
  };
}

function trialWire(
  input: TrialSessionInput,
  timezone: string,
): TrialSessionPayload {
  const { dateTime: rawDateTime, ...rest } = input;
  const dateTime = formatNotificationDateTime(rawDateTime, timezone);
  return {
    ...rest,
    status: input.status.toLowerCase().replace(/_/g, " "),
    statusCode: input.status,
    ...(dateTime ? { dateTime, dateTimeIso: rawDateTime } : {}),
  };
}

function bookingRequestWire(
  input: BookingRequestInput,
  timezone: string,
): BookingRequestPayload {
  const { requestedDateTime: rawRequested, ...rest } = input;
  const requestedDateTime = formatNotificationDateTime(rawRequested, timezone);
  return {
    ...rest,
    appointmentType: appointmentTypeLabel(input.appointmentType),
    appointmentTypeCode: input.appointmentType,
    ...(requestedDateTime
      ? { requestedDateTime, requestedDateTimeIso: rawRequested }
      : {}),
  };
}

// ============================================================================
// Appointment Notifications
// ============================================================================

export async function notifyAppointmentBooked(
  userIds: string[],
  payload: AppointmentPayloadInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_BOOKED,
    userIds,
    (timezone) => appointmentWire(payload, timezone),
  );
}

/**
 * #1206 — sent to the CONSULTEE only. The consultant already knows: they were
 * shown "only N of M fit" and confirmed it. This is the half of that exchange
 * the consultee never saw.
 */
export async function notifyAppointmentPartiallyScheduled(
  userIds: string[],
  payload: AppointmentPartiallyScheduledInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_PARTIALLY_SCHEDULED,
    userIds,
    (timezone) => partiallyScheduledWire(payload, timezone),
  );
}

export async function notifyAppointmentCancelled(
  userIds: string[],
  payload: AppointmentCancelledInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
    userIds,
    (timezone) => cancelledWire(payload, timezone),
  );
}

export async function notifyAppointmentRescheduled(
  userIds: string[],
  payload: AppointmentRescheduledInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_RESCHEDULED,
    userIds,
    (timezone) => rescheduledWire(payload, timezone),
  );
}

export async function notifyAppointmentCompleted(
  userIds: string[],
  payload: AppointmentPayloadInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_COMPLETED,
    userIds,
    (timezone) => appointmentWire(payload, timezone),
  );
}

// `dedupeKey` (appointment + window) keeps the 1h reminder from being
// swallowed as a duplicate of the 24h one — their payloads are identical.
export async function notifyAppointmentReminder(
  userIds: string[],
  payload: AppointmentPayloadInput,
  dedupeKey?: string,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.APPOINTMENT_REMINDER,
    userIds,
    (timezone) => appointmentWire(payload, timezone),
    dedupeKey,
  );
}

// ============================================================================
// Payment Notifications
// ============================================================================

export async function notifyPaymentSuccess(
  userId: string,
  payload: PaymentSuccessInput,
) {
  const wire: PaymentSuccessPayload = {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerWorkflow(NOVU_WORKFLOWS.PAYMENT_SUCCESS, userId, wire);
}

export async function notifyPaymentFailed(
  userId: string,
  payload: PaymentFailedInput,
) {
  const wire: PaymentFailedPayload = {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerWorkflow(NOVU_WORKFLOWS.PAYMENT_FAILED, userId, wire);
}

/**
 * Paise become money before the payer reads them. `amount` is symbol-free
 * because `refund-processed` and `refund-requested` print `{{currency}}`
 * themselves; `refund-failed` shares this payload type and so shares its shape,
 * which is the point — one type cannot mean two things depending on which
 * workflow happens to carry it.
 */
function refundWire(payload: RefundInput): RefundPayload {
  return {
    ...payload,
    amount: formatNotificationAmountBare(payload.amount, payload.currency),
    amountFormatted: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
    ...(payload.appointmentType
      ? {
          appointmentType: appointmentTypeLabel(payload.appointmentType),
          appointmentTypeCode: payload.appointmentType,
        }
      : {}),
  };
}

export async function notifyRefundProcessed(
  userId: string,
  payload: RefundInput,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFUND_PROCESSED,
    userId,
    refundWire(payload),
  );
}

// #779 §A — the gateway rejected a refund (Refund.status = FAILED). Notifies
// the payer; `reason` on the payload carries the gateway failure reason.
export async function notifyRefundFailed(userId: string, payload: RefundInput) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFUND_FAILED,
    userId,
    refundWire(payload),
  );
}

export async function notifyRefundRequested(
  adminUserIds: string[],
  payload: RefundInput,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.REFUND_REQUESTED,
    adminUserIds,
    refundWire(payload),
  );
}

// ============================================================================
// Support Ticket Notifications
// ============================================================================

export async function notifySupportTicketCreated(
  staffUserIds: string[],
  payload: SupportTicketPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUPPORT_TICKET_CREATED,
    staffUserIds,
    payload,
  );
}

export async function notifySupportTicketUpdate(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE, userId, payload);
}

/**
 * #705 — the ops side of a ticket update, fanned out to several staff.
 * A user replying into an escalated thread used to page nobody at all, so the
 * only way staff learned of it was reopening the inbox.
 */
export async function notifySupportTicketUpdateForStaff(
  userIds: string[],
  payload: SupportTicketPayload,
  dedupeKey?: string,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    userIds,
    payload,
    dedupeKey,
  );
}

export async function notifySupportTicketResponse(
  userId: string,
  payload: SupportTicketPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.SUPPORT_TICKET_RESPONSE,
    userId,
    payload,
  );
}

// ============================================================================
// Feedback & Review Notifications
// ============================================================================

export async function notifyFeedbackReceived(
  adminUserIds: string[],
  payload: FeedbackPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.FEEDBACK_RECEIVED,
    adminUserIds,
    payload,
  );
}

export async function notifyNewReview(
  consultantUserId: string,
  payload: ReviewPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.NEW_REVIEW_RECEIVED,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Trial Session Notifications
// ============================================================================

export async function notifyTrialSessionRequested(
  consultantUserId: string,
  payload: TrialSessionInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_REQUESTED,
    consultantUserId,
    (timezone) => trialWire(payload, timezone),
  );
}

export async function notifyTrialSessionScheduled(
  consulteeUserId: string,
  payload: TrialSessionInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_SCHEDULED,
    consulteeUserId,
    (timezone) => trialWire(payload, timezone),
  );
}

export async function notifyTrialSessionCompleted(
  userIds: string[],
  payload: TrialSessionInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_COMPLETED,
    userIds,
    (timezone) => trialWire(payload, timezone),
  );
}

export async function notifyTrialSessionCancelled(
  userIds: string[],
  payload: TrialSessionInput,
) {
  return triggerForMultipleZoned(
    NOVU_WORKFLOWS.TRIAL_SESSION_CANCELLED,
    userIds,
    (timezone) => trialWire(payload, timezone),
  );
}

// ============================================================================
// Subscription Notifications
// ============================================================================

export async function notifySubscriptionStarted(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUBSCRIPTION_STARTED, userId, payload);
}

export async function notifySubscriptionCancelled(
  userIds: string[],
  payload: SubscriptionPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.SUBSCRIPTION_CANCELLED,
    userIds,
    payload,
  );
}

export async function notifySubscriptionRenewed(
  userId: string,
  payload: SubscriptionPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.SUBSCRIPTION_RENEWED, userId, payload);
}

// ============================================================================
// Consultant-Specific Notifications
// ============================================================================

export async function notifyNewBookingRequest(
  consultantUserId: string,
  payload: BookingRequestInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.NEW_BOOKING_REQUEST,
    consultantUserId,
    (timezone) => bookingRequestWire(payload, timezone),
  );
}

export async function notifyVerificationStatusChanged(
  consultantUserId: string,
  payload: VerificationPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.VERIFICATION_STATUS_CHANGED,
    consultantUserId,
    payload,
  );
}

// Moderation (#693) — fire-and-forget; callers run these in the best-effort
// phase, never inside the moderation transaction.
export async function notifyModerationWarning(
  targetUserId: string,
  payload: ModerationWarningPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.MODERATION_WARNING,
    targetUserId,
    payload,
  );
}

export async function notifyAccountSuspended(
  targetUserId: string,
  payload: AccountSuspendedInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.ACCOUNT_SUSPENDED,
    targetUserId,
    (timezone): AccountSuspendedPayload => {
      // An indefinite suspension has no `banExpires`, and the moderation
      // caller sends "" for it — the sentence reads "until {{suspendedUntil}}",
      // so the blank needs words, and the ISO twin is only sent for a real date.
      const { suspendedUntil: raw, ...rest } = payload;
      const suspendedUntil = formatNotificationDateTime(raw, timezone);
      return {
        ...rest,
        suspendedUntil: suspendedUntil ?? "further notice",
        ...(suspendedUntil ? { suspendedUntilIso: raw } : {}),
      };
    },
  );
}

export async function notifyAccountBanned(
  targetUserId: string,
  payload: AccountBannedPayload,
) {
  return triggerWorkflow(NOVU_WORKFLOWS.ACCOUNT_BANNED, targetUserId, payload);
}

export async function notifyPayoutProcessed(
  consultantUserId: string,
  payload: PayoutInput,
) {
  const wire: PayoutPayload = {
    ...payload,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.PAYOUT_PROCESSED,
    consultantUserId,
    wire,
  );
}

/**
 * A7: notify a consultant that their EXPERT membership at an organization
 * was soft-deleted. Fire-and-forget — a Novu outage must not block the
 * member-DELETE API response. Caller is expected to wrap in try/catch.
 */
export async function notifyOrgExpertRemoved(
  consultantUserId: string,
  payload: OrgExpertRemovedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.ORG_EXPERT_REMOVED,
    consultantUserId,
    payload,
  );
}

// ============================================================================
// Admin / System Notifications
// ============================================================================

export async function notifyGeneralAnnouncement(payload: AnnouncementPayload) {
  return triggerBroadcastWorkflow(NOVU_WORKFLOWS.GENERAL_ANNOUNCEMENT, payload);
}

export async function notifyNewConsultantApplication(
  adminUserIds: string[],
  payload: ConsultantApplicationPayload,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.NEW_CONSULTANT_APPLICATION,
    adminUserIds,
    payload,
  );
}

// ============================================================================
// Dispute Notifications
// ============================================================================

function disputeWire(payload: DisputeInput): DisputePayload {
  return {
    ...payload,
    amount: formatNotificationMoney(payload.amount, payload.currency),
    amountPaise: payload.amount,
  };
}

export async function notifyDisputeCreated(
  userIds: string[],
  payload: DisputeInput,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.DISPUTE_CREATED,
    userIds,
    disputeWire(payload),
  );
}

export async function notifyDisputeResolved(
  userIds: string[],
  payload: DisputeInput,
) {
  return triggerForMultiple(
    NOVU_WORKFLOWS.DISPUTE_RESOLVED,
    userIds,
    disputeWire(payload),
  );
}

// ============================================================================
// Recording Notifications
// ============================================================================

export async function notifyRecordingAvailable(
  userIds: string[],
  payload: Omit<RecordingPayload, "appointmentTypeCode">,
) {
  const wire: RecordingPayload = {
    ...payload,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerForMultiple(NOVU_WORKFLOWS.RECORDING_AVAILABLE, userIds, wire);
}

export async function notifyRecordingFailed(
  subscriberId: string,
  payload: RecordingFailedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.RECORDING_FAILED,
    subscriberId,
    payload,
  );
}

// STR-3 — warn a consultant their STREAM_ONLY recording(s) expire soon.
export async function notifyRecordingExpiring(
  consultantUserId: string,
  payload: RecordingExpiringInput,
) {
  return triggerWorkflowZoned(
    NOVU_WORKFLOWS.RECORDING_EXPIRING,
    consultantUserId,
    (timezone): RecordingExpiringPayload => {
      const { expiresAt: raw, ...rest } = payload;
      const expiresAt = formatNotificationDateTime(raw, timezone);
      return {
        ...rest,
        expiresAt: expiresAt ?? "the date shown in your dashboard",
        ...(expiresAt ? { expiresAtIso: raw } : {}),
      };
    },
  );
}

// ============================================================================
// Document Review Notifications
// ============================================================================

/** A document (or revision/response) landed on an appointment. */
export async function notifyDocumentUploaded(
  subscriberId: string,
  payload: DocumentUploadedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.DOCUMENT_UPLOADED,
    subscriberId,
    payload,
  );
}

/** A consultant set a review decision on a submitted document. */
export async function notifyDocumentReviewed(
  subscriberId: string,
  payload: DocumentReviewedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.DOCUMENT_REVIEWED,
    subscriberId,
    payload,
  );
}

// ============================================================================
// Referral Notifications
// ============================================================================

export async function notifyReferralBonusEarned(
  referrerUserId: string,
  payload: ReferralBonusInput,
) {
  const wire: ReferralBonusPayload = {
    ...payload,
    bonusAmount: formatNotificationMoney(payload.bonusAmount, payload.currency),
    bonusAmountPaise: payload.bonusAmount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFERRAL_BONUS_EARNED,
    referrerUserId,
    wire,
  );
}

export async function notifyRefereeWelcomeBonus(
  refereeUserId: string,
  payload: RefereeWelcomeBonusInput,
) {
  const wire: RefereeWelcomeBonusPayload = {
    ...payload,
    bonusAmount: formatNotificationMoney(payload.bonusAmount, payload.currency),
    bonusAmountPaise: payload.bonusAmount,
  };
  return triggerWorkflow(
    NOVU_WORKFLOWS.REFEREE_WELCOME_BONUS,
    refereeUserId,
    wire,
  );
}

export async function notifyReferralCreditsApplied(
  userId: string,
  payload: ReferralCreditsAppliedInput,
) {
  const wire: ReferralCreditsAppliedPayload = {
    ...payload,
    creditsUsed: formatNotificationMoney(payload.creditsUsed, payload.currency),
    creditsUsedPaise: payload.creditsUsed,
    remainingCredits: formatNotificationMoney(
      payload.remainingCredits,
      payload.currency,
    ),
    remainingCreditsPaise: payload.remainingCredits,
    appointmentType: appointmentTypeLabel(payload.appointmentType),
    appointmentTypeCode: payload.appointmentType,
  };
  return triggerWorkflow(NOVU_WORKFLOWS.REFERRAL_CREDITS_APPLIED, userId, wire);
}

// ============================================================================
// Collaborator Notifications
// ============================================================================

export async function notifyCollaboratorInvited(
  consultantUserId: string,
  payload: CollaboratorInvitedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_INVITED,
    consultantUserId,
    payload,
  );
}

export async function notifyCollaboratorAccepted(
  ownerUserId: string,
  payload: CollaboratorAcceptedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_ACCEPTED,
    ownerUserId,
    payload,
  );
}

export async function notifyCollaboratorRemoved(
  consultantUserId: string,
  payload: CollaboratorRemovedPayload,
) {
  return triggerWorkflow(
    NOVU_WORKFLOWS.COLLABORATOR_REMOVED,
    consultantUserId,
    payload,
  );
}

// Maintenance notifications (broadcast to all users)

/**
 * A broadcast has no recipient list to load zones from, so the ETA renders in
 * the platform default zone — which the rendered string names, so nobody has to
 * guess which zone they are reading (#536).
 */
function maintenanceWire(payload: MaintenanceInput): MaintenancePayload {
  const { estimatedEnd: raw, ...rest } = payload;
  const estimatedEnd = formatNotificationDateTime(
    raw,
    DEFAULT_NOTIFICATION_TIMEZONE,
  );
  return {
    ...rest,
    ...(estimatedEnd ? { estimatedEnd, estimatedEndIso: raw } : {}),
  };
}

export async function notifyMaintenanceScheduled(payload: MaintenanceInput) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_SCHEDULED,
    maintenanceWire(payload),
  );
}

export async function notifyMaintenanceStarted(payload: MaintenanceInput) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_STARTED,
    maintenanceWire(payload),
  );
}

export async function notifyMaintenanceEnded(payload: MaintenanceInput) {
  return triggerBroadcastWorkflow(
    NOVU_WORKFLOWS.MAINTENANCE_ENDED,
    maintenanceWire(payload),
  );
}
