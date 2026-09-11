/**
 * Razorpay checkout prefill helpers.
 *
 * Razorpay's Standard Checkout accepts `prefill.contact` as an
 * E.164-ish phone string. When the field is missing or malformed,
 * Razorpay's UI silently rejects the user's input on submit (test
 * mode also rejects repeated-digit numbers like 9999999999). Pass
 * the user's stored phone here so they don't have to retype it,
 * and validate before opening so we surface our own error instead
 * of letting Razorpay's modal fail opaquely.
 *
 * Reference issue: #717.
 */

const E164_RE = /^\+?[1-9]\d{9,14}$/;

// Razorpay test mode rejects mobile numbers whose last 10 digits are
// all the same — e.g. "9999999999" or "+919999999999" — as "Invalid
// mobile number". The request reaches their gateway, fails, and the
// user sees an opaque modal error. Catch it client-side so we can
// surface our own "valid phone required" prompt before opening.
//
// The regex matches any run of 10+ identical digits anywhere in the
// string. Indian mobile numbers are exactly 10 digits after the +91
// country code, so this is precise. For longer international numbers
// the test still catches the obviously-fake "all same digit" case
// without over-matching legitimate ones (the National Significant
// Number portion of any E.164 number is ≤ 15 digits and real numbers
// don't repeat any digit 10+ times consecutively).
const REPEATED_DIGIT_RE = /(\d)\1{9,}/;

/**
 * Normalize a stored phone string to a Razorpay-acceptable contact.
 * Strips spaces, hyphens, and parentheses; preserves the leading `+`
 * if present. Returns `null` when the string fails E.164 validation
 * or is a repeated-digit number Razorpay's gateway will reject.
 */
export function normalizeRazorpayContact(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-()]/g, "");
  if (!E164_RE.test(cleaned)) return null;
  if (REPEATED_DIGIT_RE.test(cleaned)) return null;
  return cleaned;
}

/**
 * Build a Razorpay `prefill` object from session-shaped user data.
 * Omits keys whose source value is empty so we don't blank out
 * Razorpay's own field guesses.
 */
export function buildRazorpayPrefill(user: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): { name?: string; email?: string; contact?: string } {
  const prefill: { name?: string; email?: string; contact?: string } = {};
  if (user.name) prefill.name = user.name;
  if (user.email) prefill.email = user.email;
  const contact = normalizeRazorpayContact(user.phone);
  if (contact) prefill.contact = contact;
  return prefill;
}
