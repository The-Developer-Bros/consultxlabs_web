/**
 * MSME (Micro, Small, Medium Enterprises) payment-deadline computation —
 * INDIA COMPLIANCE.
 *
 * Section 43B(h) of the Income Tax Act (inserted by Finance Act 2023):
 *   - Payments to MSME-registered suppliers must be made within:
 *       * 15 days of invoice date if there is NO written agreement
 *       * 45 days of invoice date if there IS a written agreement
 *   - Applies to MICRO + SMALL only. MEDIUM and non-MSME (NONE) keep the
 *     org's default payment terms (60 days unless overridden).
 *   - If breached, the buyer cannot claim the expense as a tax deduction
 *     in the current year — it is disallowed until actually paid. Hard
 *     ceiling: 43B(h) days WIN over a longer `defaultTermsDays`.
 *
 * Cron: `jobs/compliance/msme-payment-alerts.ts` sweeps rows where
 *   `mustPayByDate - now < 5 days AND status != SUCCEEDED`
 * and surfaces them to finance for settlement.
 *
 * Udyam number format: UDYAM-XX-NN-NNNNNNN (19 chars).
 */

import type { MsmeStatus } from "@prisma/client";

/** Section 43B(h): 15 days when no written agreement exists. */
export const MSME_NO_WRITTEN_AGREEMENT_DAYS = 15;

/** Section 43B(h): 45 days when a written agreement is on file. */
export const MSME_WRITTEN_AGREEMENT_DAYS = 45;

/** Default payment terms for non-43B counterparties (MEDIUM, NONE). */
export const DEFAULT_MSME_DEADLINE_DAYS = 60;

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Compute the deadline by which a payment to this provider must be
 * settled to remain compliant with Section 43B(h).
 *
 * @param params.counterpartyMsmeStatus — the consultant's `msmeStatus`
 *   (NOT the buyer org's). 43B(h) protects the supplier; the buyer
 *   bears the risk of late payment.
 * @param params.writtenAgreement — true iff a written agreement is on
 *   file with the consultant. Defaults to **false** (safer = shorter
 *   deadline; if we forget to set the flag, we err toward early
 *   settlement instead of toward a tax disallowance).
 * @param params.defaultTermsDays — only applied when MSME status is
 *   MEDIUM or NONE. Ignored for MICRO/SMALL because 43B(h) is a hard
 *   ceiling.
 */
export function computeMsmePaymentDeadline(params: {
  invoiceDate: Date;
  counterpartyMsmeStatus: MsmeStatus;
  writtenAgreement?: boolean;
  defaultTermsDays?: number;
}): Date {
  const writtenAgreement = params.writtenAgreement ?? false;
  const status = params.counterpartyMsmeStatus;

  if (status === "MICRO" || status === "SMALL") {
    // 43B(h) hard ceiling — defaultTermsDays cannot extend past this.
    const days = writtenAgreement
      ? MSME_WRITTEN_AGREEMENT_DAYS
      : MSME_NO_WRITTEN_AGREEMENT_DAYS;
    return addDays(params.invoiceDate, days);
  }

  // MEDIUM and NONE — use defaultTermsDays or fall back to 60.
  return addDays(
    params.invoiceDate,
    params.defaultTermsDays ?? DEFAULT_MSME_DEADLINE_DAYS,
  );
}

/**
 * Validates an Udyam registration number format. State code is two
 * uppercase letters, district is two digits, registration sequence is
 * seven digits.
 */
export function isValidUdyamNumber(n: string | null | undefined): boolean {
  if (!n) return false;
  return /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/.test(n);
}
