import type { TrialSessionStatus } from "@prisma/client";

/**
 * Which existing trial statuses block a fresh trial request.
 *
 * `TrialSession` is `@@unique([consulteeProfileId, consultantProfileId])`, so
 * exactly one row can exist per learner–consultant pair. Eligibility used to be
 * "no row at all", which meant ANY prior trial — including one the consultant
 * declined, one the learner cancelled, or (once paid trials landed) one that
 * simply lapsed unpaid — barred that learner from ever trialling that
 * consultant again. Never paying isn't the same as having used your trial.
 *
 * So only trials that are live or already delivered block a re-request. The
 * terminal-without-delivery outcomes below free the pair, and the old row is
 * deleted when the new request is made (the unique constraint leaves no other
 * option).
 *
 * NOTE ON ABUSE: this is deliberately the permissive setting. It does allow
 * someone to repeatedly request → get declined → request again, which could be
 * used to pester a consultant, and to repeatedly hold slots without paying. If
 * that shows up in practice, tighten by moving REJECTED (pestering) and/or
 * CANCELLED (slot-holding) back into the blocking set — that single change
 * restores the old one-shot behaviour without touching any call site.
 */
export const TRIAL_REQUEST_BLOCKING_STATUSES: TrialSessionStatus[] = [
  "PENDING", // awaiting the consultant
  "AWAITING_PAYMENT", // accepted, pay-link live and not yet lapsed
  "SCHEDULED", // confirmed, upcoming
  "COMPLETED", // trial actually delivered — this is the real one-per-pair rule
  "CONVERTED", // delivered and subscribed
];

/** Terminal outcomes where the learner never received a trial. */
export const TRIAL_REQUEST_FREEING_STATUSES: TrialSessionStatus[] = [
  "CANCELLED", // withdrawn by the learner, or lapsed unpaid
  "REJECTED", // declined by the consultant
];

export function blocksNewTrialRequest(status: TrialSessionStatus): boolean {
  return TRIAL_REQUEST_BLOCKING_STATUSES.includes(status);
}

/**
 * Paid-trial payment window: 24h from acceptance, clamped to the session start.
 * A slot three hours out must not stay payable past the slot itself.
 */
export const TRIAL_PAYMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function computeTrialPaymentDueAt(
  acceptedAt: Date,
  sessionStartsAt: Date | null | undefined,
): Date {
  const window = new Date(acceptedAt.getTime() + TRIAL_PAYMENT_WINDOW_MS);
  if (sessionStartsAt && sessionStartsAt < window) return sessionStartsAt;
  return window;
}
