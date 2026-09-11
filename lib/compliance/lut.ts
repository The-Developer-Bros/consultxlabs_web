/**
 * Platform Letter of Undertaking (LUT) state — GST Rule 96A / Form RFD-11.
 *
 * Zero-rating an export of services WITHOUT paying IGST requires a LUT
 * valid for the CURRENT financial year filed on the GST portal before the
 * supply. Without it the supply is taxable at 18% IGST (the pay-then-refund
 * route of s.16(3)(b) is available but is a deliberate cash-flow decision,
 * not a default). Forgetting renewal is the classic exporter trap: every
 * invoice raised after April 1 without a fresh LUT accrues IGST plus
 * interest.
 *
 * The supplier on Familiarise invoices is the platform, so the LUT is
 * PLATFORM-level configuration, not per-org data:
 *   - PLATFORM_LUT_NUMBER     e.g. "AD270326000001L/2627"
 *   - PLATFORM_LUT_VALID_TILL ISO date (inclusive), normally the FY end
 *
 * Fail-closed contract (#1230): absent or expired LUT ⇒ callers MUST NOT
 * zero-rate. deriveGstBreakdown and determineTax both consult this module so
 * checkout and invoicing cannot drift apart on the same supply.
 */

export const PLATFORM_LUT_NUMBER_ENV = "PLATFORM_LUT_NUMBER";
export const PLATFORM_LUT_VALID_TILL_ENV = "PLATFORM_LUT_VALID_TILL";

export interface PlatformLutStatus {
  /** Both env vars configured. */
  present: boolean;
  /** present AND the validity date has not passed. */
  valid: boolean;
  number: string | null;
  validTill: Date | null;
}

export function readPlatformLut(now: Date = new Date()): PlatformLutStatus {
  const number = process.env[PLATFORM_LUT_NUMBER_ENV]?.trim() || null;
  const rawTill = process.env[PLATFORM_LUT_VALID_TILL_ENV]?.trim() || null;

  // The inclusive end-of-day is INDIAN: a LUT "valid till 2027-03-31" covers
  // supplies made anywhere in IST on March 31, i.e. through
  // 2027-03-31T18:29:59.999Z. A UTC-midnight comparison let it lapse five and
  // a half hours early — the mirror image of the classic renewal trap.
  // Strict CALENDAR-date validation (CR #1234 r3): a shape-valid string like
  // "2027-02-30" would otherwise normalize to March 2 and silently extend
  // validity; reject anything that doesn't round-trip.
  let validTill: Date | null = null;
  if (rawTill && /^\d{4}-\d{2}-\d{2}$/.test(rawTill)) {
    const [y, m, d] = rawTill.split("-").map(Number);
    const dayStartUtc = new Date(`${rawTill}T00:00:00.000Z`);
    const isRealCalendarDate =
      !Number.isNaN(dayStartUtc.getTime()) &&
      dayStartUtc.getUTCFullYear() === y &&
      dayStartUtc.getUTCMonth() + 1 === m &&
      dayStartUtc.getUTCDate() === d;
    if (isRealCalendarDate) {
      validTill = new Date(dayStartUtc.getTime() + (18 * 60 + 30) * 60 * 1000 - 1);
    }
  }

  const present = !!number && !!validTill;
  const valid = present && !!validTill && validTill.getTime() >= now.getTime();
  return { present, valid, number, validTill };
}

/** True iff exports may be zero-rated right now (fail-closed otherwise). */
export function hasValidPlatformLut(now: Date = new Date()): boolean {
  return readPlatformLut(now).valid;
}
