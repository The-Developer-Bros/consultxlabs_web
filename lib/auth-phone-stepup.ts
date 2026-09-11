/**
 * Phone / SMS step-up verification — STUB. Full implementation tracked in #884.
 *
 * Decision (see docs/referrals/05-auth-onboarding-integration.md and #884):
 * verified email is the universal signup gate; phone is NOT required at signup.
 * Phone verification is a risk-based step-up enforced ONLY at money-moving
 * moments — claiming a referral reward, the first paid booking, and a
 * consultant's first payout. The real implementation (WhatsApp-OTP-primary with
 * SMS fallback, a device/IP/velocity risk score, and TRAI/DLT + DPDP
 * compliance) is out of scope here; this module only scaffolds the integration
 * point so the future gates have a stable seam to call.
 */

export type PhoneStepUpGate =
  | "referral_claim"
  | "first_booking"
  | "consultant_payout";

export interface PhoneStepUpResult {
  /** Whether the user must complete phone verification before this gate. */
  required: boolean;
  /** Optional human-readable reason (e.g. which risk signal triggered it). */
  reason?: string;
}

/**
 * Decide whether `userId` must complete phone step-up before `gate`.
 *
 * STUB: always returns `{ required: false }` so no gate is blocked yet. Replace
 * with a risk-scored decision + OTP challenge once #884 lands. Kept async so the
 * future implementation (DB/risk-service/OTP-provider calls) does not change the
 * signature its callers already await.
 */
export async function evaluatePhoneStepUp(
  _userId: string,
  _gate: PhoneStepUpGate,
): Promise<PhoneStepUpResult> {
  // TODO(#884): risk score (device / IP / velocity) → OTP challenge via the
  // WhatsApp-primary + SMS-fallback provider; cache a verified phone per user.
  return { required: false };
}
