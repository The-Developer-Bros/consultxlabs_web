/**
 * HMAC-SHA256 signing + verification for outbound webhook deliveries.
 *
 * Header shape — `X-Familiarise-Signature: t=<unix>,v1=<hex>`
 * ------------------------------------------------------------
 * Mirrors Stripe's signature scheme so integrators with prior Stripe
 * experience can verify our signatures with minimal mental switch cost.
 * The `t=` timestamp is part of the signed payload, which closes the
 * "replay an old delivery body" attack vector — receivers can refuse
 * any request whose timestamp drifts beyond a configurable window.
 *
 * Why HMAC-SHA256 (not Ed25519, not asymmetric)
 * ---------------------------------------------
 * - Receivers don't need to manage a public key — the shared secret
 *   is also the verification material. One secret per endpoint
 *   rotated via the dedicated `/rotate-secret` route.
 * - HMAC-SHA256 is universally available in every server runtime
 *   (Node, Workers, Lambda, PHP, Ruby) without extra dependencies.
 * - The threat model is "prevent a third party from forging a body";
 *   it is NOT "prevent the org's own admins from forging" (they hold
 *   the secret by definition). Asymmetric crypto would buy us
 *   non-repudiation we don't need.
 *
 * Constant-time verification
 * --------------------------
 * `crypto.timingSafeEqual` short-circuits on length mismatch but
 * otherwise does NOT branch on byte equality — so a network observer
 * cannot use response-time differences to brute-force the signature.
 * This is load-bearing: any `===` comparison here would silently leak
 * the secret over enough requests.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Familiarise-Signature";

/**
 * Default replay window, in seconds. Receivers should reject any
 * signature whose timestamp drifts beyond this — the window has to be
 * generous enough to absorb clock skew + retry delay (worker pushes
 * the same signature on retries; see `worker.ts`) but small enough
 * that a captured body can't be replayed days later.
 *
 * Tuned for the worker's longest retry interval (8 hours) plus
 * headroom. If the worker's backoff schedule changes, this window has
 * to widen accordingly.
 */
export const DEFAULT_REPLAY_WINDOW_SECONDS = 60 * 60 * 9; // 9h

/**
 * Secret-rotation grace window. After /rotate-secret stamps
 * `secretRotatedAt`, the worker dual-signs every delivery (current +
 * previous secret) for this long so receivers stay green across the
 * cutover. Mirrors Stripe/Svix, which list multiple `v1=` signatures
 * during their own rotation grace. After the window the worker drops
 * back to single-signing with the current secret. #768
 */
export const WEBHOOK_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Sign a JSON body with the endpoint's shared secret. Returns the
 * fully-formed header value ready to put on the outbound request.
 *
 * During the rotation grace window the caller passes `previousSecret`;
 * we then emit BOTH signatures as repeated `v1=` entries —
 * `t=<unix>,v1=<current>,v1=<previous>` — so a receiver running the
 * body through either secret matches one of them. This is exactly how
 * Stripe/Svix list multiple signatures, so a standard verifier that
 * scans every `v1=` value Just Works.
 *
 * The caller is responsible for ensuring `body` is the *exact* bytes
 * that will go on the wire — any pretty-printing / re-serialization
 * after this call will produce a signature receivers can't verify.
 */
export function signPayload(
  secret: string,
  body: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
  previousSecret?: string | null,
): string {
  const signed = `${timestampSeconds}.${body}`;
  const sign = (key: string) =>
    createHmac("sha256", key).update(signed).digest("hex");
  const parts = [`t=${timestampSeconds}`, `v1=${sign(secret)}`];
  if (previousSecret) parts.push(`v1=${sign(previousSecret)}`);
  return parts.join(",");
}

/**
 * Verifier — for integration tests + the receiver-side reference
 * implementation in `docs/enterprise/40-compliance-and-data/04-outbound-webhooks.md`. Not
 * called from production code paths; lives here so the canonical
 * verification logic stays adjacent to the signing logic.
 */
export function verifySignature(
  secret: string,
  body: string,
  headerValue: string,
  options: {
    replayWindowSeconds?: number;
    /// Inject for testing — production should use the default. Receives
    /// the same UTC seconds the signature uses.
    now?: () => number;
  } = {},
): { valid: boolean; reason?: string } {
  const replayWindow =
    options.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);

  const parts = headerValue.split(",");
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  // During the rotation grace window we emit repeated `v1=` entries —
  // collect ALL of them and accept the body if it matches any one,
  // mirroring how Stripe/Svix verifiers iterate every listed signature.
  const v1s = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || v1s.length === 0) return { valid: false, reason: "MALFORMED_HEADER" };

  const ts = Number(t);
  if (!Number.isFinite(ts)) return { valid: false, reason: "MALFORMED_TIMESTAMP" };

  // Replay window check — the timestamp is BEFORE the signature
  // verification because rejecting on clock drift is cheaper than the
  // HMAC compute AND ensures a captured-and-stored body can't be
  // replayed days later even if the attacker has the signature.
  if (Math.abs(now - ts) > replayWindow) {
    return { valid: false, reason: "REPLAY_WINDOW_EXCEEDED" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest();
  for (const v1 of v1s) {
    let received: Buffer;
    try {
      received = Buffer.from(v1, "hex");
    } catch {
      continue;
    }
    // timingSafeEqual throws on length mismatch — short-circuit ourselves
    // so we move on to the next candidate instead of throwing.
    if (received.length !== expected.length) continue;
    if (timingSafeEqual(received, expected)) return { valid: true };
  }
  return { valid: false, reason: "SIGNATURE_MISMATCH" };
}

/**
 * Generate a fresh endpoint secret. 32 bytes → 64 hex chars; matches
 * the entropy ceiling of HMAC-SHA256 (any longer is wasted) and the
 * standard "shared-secret" pattern receivers will recognize.
 */
export function generateEndpointSecret(): string {
  // node:crypto's randomBytes is the only sanctioned CSPRNG source in
  // Next.js server runtime. Avoid Math.random (not cryptographically
  // secure) and Web Crypto's getRandomValues (only available in edge,
  // not the Node runtime that handles webhook CRUD).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return randomBytes(32).toString("hex");
}
