import crypto from "node:crypto";

/**
 * Which configured secret verified an inbound Razorpay webhook.
 *
 * `previous` exists only during a secret rotation. `razorpayx` is the separate
 * RazorpayX (payouts) product secret, which is a different value again and is
 * only ever consulted for `payout.*` events.
 */
export type RazorpayWebhookSecretRole = "current" | "previous" | "razorpayx";

export interface RazorpayWebhookSecretCandidate {
  role: RazorpayWebhookSecretRole;
  value: string;
}

// Razorpay signs with HMAC-SHA256 and sends the digest hex-encoded, so a
// well-formed `x-razorpay-signature` is always 64 characters. The length
// pre-check is not decoration: `timingSafeEqual` THROWS on a length mismatch,
// so without it an attacker-controlled header turns a rejected signature into
// an unhandled 500.
const HMAC_SHA256_HEX_LENGTH = 64;

/** Constant-time HMAC-SHA256 check of the RAW body against one secret. */
export function verifyRazorpaySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  if (signature.length !== HMAC_SHA256_HEX_LENGTH) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

/**
 * The payment-side secrets a delivery may legitimately be signed with, in the
 * order they should be tried.
 *
 * #1377 — rotating `RAZORPAY_WEBHOOK_SECRET` is otherwise a hard cutover, and
 * the two sides cannot swap atomically: the operator saves the new secret in
 * the Razorpay dashboard, and every event Razorpay signs between that click
 * and the platform finishing its redeploy is rejected with a 400. Razorpay
 * treats any non-2xx as a delivery failure, retries with exponential backoff
 * for 24 hours and then DISABLES the webhook, and a disabled webhook loses
 * events permanently because there is no self-serve replay. So a routine
 * hygiene action could silently take payment confirmation offline.
 *
 * `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` closes that gap the same way ADR 09
 * closes it for our OUTBOUND webhooks: both secrets are honoured across the
 * cutover, and the old one is retired afterwards. The window here is
 * operational rather than timestamped — the variable IS the window — so every
 * delivery that actually lands on the previous secret is reported by the
 * caller, and a variable left behind after the rotation is loud rather than
 * silent.
 *
 * An unset, blank or duplicated previous secret contributes no candidate, so
 * the normal steady state is a single-secret check. A missing CURRENT secret
 * contributes none at all: the grace window is an aid to a rotation, not a
 * secret in its own right, so a deployment that has lost
 * `RAZORPAY_WEBHOOK_SECRET` must fail loudly on the route's 500 rather than
 * quietly keep accepting deliveries on a value the operator has retired.
 */
export function resolveRazorpayPaymentSecrets(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RazorpayWebhookSecretCandidate[] {
  const current = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  const previous = env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS?.trim();

  const candidates: RazorpayWebhookSecretCandidate[] = [];
  if (!current) {
    return candidates;
  }
  candidates.push({ role: "current", value: current });
  if (previous && previous !== current) {
    candidates.push({ role: "previous", value: previous });
  }
  return candidates;
}

/**
 * Try each candidate in order and report which one matched, or null.
 *
 * Trying several secrets does not widen the trust boundary: each check is the
 * same full HMAC over the same raw body, so a forged signature still has to
 * match a secret the platform holds. What it widens is the SET of secrets the
 * platform holds, which is exactly why `resolveRazorpayPaymentSecrets` only
 * ever returns more than one while a rotation is in flight.
 */
export function matchRazorpayWebhookSecret(
  rawBody: string,
  signature: string,
  candidates: readonly RazorpayWebhookSecretCandidate[],
): RazorpayWebhookSecretRole | null {
  for (const candidate of candidates) {
    if (verifyRazorpaySignature(rawBody, signature, candidate.value)) {
      return candidate.role;
    }
  }
  return null;
}

/**
 * True when the parsed body names a RazorpayX payout event.
 *
 * The RazorpayX secret is only ever tried for these, and the ordering — main
 * secrets first, X secret only on a `payout.*` name — is the whole safety
 * property: a non-payout event can never be accepted by the X secret, so the
 * fallback cannot be used to smuggle a forged `payment.captured` through.
 * The name is read from an as-yet-UNVERIFIED body, which is safe precisely
 * because it can only ever narrow what we are willing to accept.
 */
export function isPayoutEventName(rawBody: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { event?: unknown }).event === "string" &&
      (parsed as { event: string }).event.startsWith("payout.")
    );
  } catch {
    // Unparseable body — not a webhook we can classify, so no fallback.
    return false;
  }
}
