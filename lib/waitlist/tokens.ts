/**
 * Stateless links for the newsletter: confirm and unsubscribe.
 *
 * Both are HMACs over the subscriber's email rather than random tokens in a
 * column, so a link survives a reseed and nothing has to be cleaned up when it
 * goes unused. The purpose is bound into the signature, which is what stops a
 * confirm link from doubling as an unsubscribe link.
 *
 * Confirm links carry their issue time in the URL and expire; unsubscribe
 * links never do — an unsubscribe link in a two-year-old email must still
 * work, and RFC 8058 one-click depends on it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppUrl } from "@/lib/url";

export const CONFIRM_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

type TokenPurpose = "confirm" | "unsubscribe";

/**
 * Deliberately no fallback to RESEND_API_KEY: sharing the secret meant that
 * rotating the Resend key silently invalidated every unsubscribe link ever
 * sent. In development an unset secret falls back to a fixed string so the
 * flow is testable without configuring anything.
 */
function getHmacSecret(): string {
  const secret = process.env.WAITLIST_HMAC_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV !== "production") {
    return "dev-waitlist-hmac-secret";
  }
  throw new Error(
    "WAITLIST_HMAC_SECRET is not configured. Newsletter confirm and unsubscribe links cannot be signed.",
  );
}

function sign(purpose: TokenPurpose, email: string, issuedAt: number): string {
  return createHmac("sha256", getHmacSecret())
    .update(`${purpose}|${email.toLowerCase()}|${issuedAt}`)
    .digest("hex");
}

/** Unsubscribe tokens are timeless, so they sign issuedAt = 0. */
export function generateUnsubscribeToken(email: string): string {
  return sign("unsubscribe", email, 0);
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  return safeEquals(token, () => generateUnsubscribeToken(email));
}

export function generateConfirmToken(email: string, issuedAt: number): string {
  return sign("confirm", email, issuedAt);
}

/**
 * Rejects a tampered signature and an expired link alike — the caller only
 * needs to know whether to honour the click.
 */
export function verifyConfirmToken(
  email: string,
  token: string,
  issuedAt: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  if (now - issuedAt > CONFIRM_TOKEN_TTL_MS) return false;
  return safeEquals(token, () => generateConfirmToken(email, issuedAt));
}

function safeEquals(token: string, expected: () => string): boolean {
  try {
    const want = expected();
    if (token.length !== want.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(want));
  } catch {
    return false;
  }
}

/**
 * Whether links can be signed at all, without throwing.
 *
 * Callers use this to fail the same way for every address. Deciding late —
 * after a membership lookup has already short-circuited — makes the failure
 * depend on membership, which turns the response into an oracle.
 */
export function canSignLinks(): boolean {
  try {
    getHmacSecret();
    return true;
  } catch {
    return false;
  }
}

export function buildConfirmUrl(email: string, issuedAt: number): string {
  const token = generateConfirmToken(email, issuedAt);
  return `${getAppUrl()}/api/waitlist/confirm?email=${encodeURIComponent(
    email,
  )}&issued=${issuedAt}&token=${token}`;
}

export function buildUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email);
  return `${getAppUrl()}/api/waitlist/unsubscribe?email=${encodeURIComponent(
    email,
  )}&token=${token}`;
}
