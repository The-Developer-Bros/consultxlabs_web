/**
 * Form 15CA / 15CB cross-border remittance — INDIA COMPLIANCE STUB.
 *
 * STATUS: stub. Returns placeholder references. Live workflow lands in a
 * follow-up PR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIVE IMPLEMENTATION REQUIREMENTS (follow-up PR)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Applies to payouts where the consultant is NON_RESIDENT and amount
 * exceeds specific thresholds (under Rule 37BB):
 *
 *   - Form 15CA Part A: single remittance ≤ ₹5 lakh in FY. Self-declared.
 *   - Form 15CA Part B: remittance requires order/certificate from AO.
 *   - Form 15CA Part C: > ₹5 lakh single OR > ₹5 lakh aggregate in FY, and
 *     the payment is chargeable to tax under the Act. Requires Form 15CB.
 *   - Form 15CA Part D: payment not chargeable to tax under the Act
 *     (e.g. personal remittance).
 *
 * Form 15CB is a CA (Chartered Accountant) certificate confirming:
 *   - Nature of remittance
 *   - Rate and amount of tax to be deducted
 *   - Applicability of DTAA provisions
 *
 * Typical flow for Familiarise PROVIDER payouts to non-resident
 * consultants:
 *
 *   1. Determine remittance category from payout purpose + amount.
 *   2. If Part C: engage a CA to issue Form 15CB (manual off-platform
 *      step today; automate via a CA integration like Taxmann or
 *      TaxSpanner in a later phase).
 *   3. File Form 15CA on the e-filing portal (https://www.incometax.gov.in)
 *      BEFORE remitting. Requires DSC (Digital Signature Certificate).
 *   4. Capture Acknowledgment Number → Payout.form15caPartCRef.
 *   5. Capture 15CB UDIN (Unique Document Identification Number) →
 *      Payout.form15cbRef.
 *   6. RBI purpose code (P0802 = Business & Management Consultancy,
 *      P0807 = Other Technical Services) → Payout.rbiPurposeCode.
 *   7. FX rate at the time of remittance → Payout.fxRateUsed.
 *   8. Inward/outward remittance certificate (FIRC for inward, Outward
 *      Remittance Certificate for outward) from the AD bank →
 *      Payout.firceRef.
 *
 * Cross-border payouts in v1 are explicitly NOT ENABLED at checkout.
 * PROVIDER orgs must mark `providerCountry = IN` for every consultant
 * until Form 15CA/15CB workflow lands.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface Form15Refs {
  form15caPartCRef: string | null;
  form15cbRef: string | null;
  rbiPurposeCode: string | null;
  dtaaRateApplied: number | null;
  fxRateUsed: number | null;
  firceRef: string | null;
  reason: string;
}

/**
 * STUB: Prepares Form 15CA/15CB references for a cross-border payout.
 *
 * TODO: replace with CA integration + e-filing workflow per the docblock.
 */
export async function prepareForm15References(_params: {
  payoutId: string;
  grossAmountPaise: number;
  providerCountry: string;
}): Promise<Form15Refs> {
  return {
    form15caPartCRef: null,
    form15cbRef: null,
    rbiPurposeCode: null,
    dtaaRateApplied: null,
    fxRateUsed: null,
    firceRef: null,
    reason: "STUB: Form 15CA/15CB workflow not yet implemented",
  };
}
