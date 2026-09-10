/**
 * GST (Goods and Services Tax) derivation — INDIA COMPLIANCE.
 *
 * STATUS: LIVE (#771 P2 — header corrected; this was never a stub).
 * `deriveGstBreakdown` computes CGST/SGST vs IGST and zero-rated export. It
 * needs `buyerStateCode` (from Organization.gstStateCode) to pick intra- vs
 * inter-state; it falls back to IGST when the state is unknown — #771 §8 wants
 * that state made mandatory for B2B invoices. HSN default 999293 (educational);
 * set 998314 / 998399 for professional / IT-consulting lines.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LIVE IMPLEMENTATION REQUIREMENTS (follow-up PR)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. Place-of-supply resolution (Sec 12 & 13 IGST Act):
 *      - B2B (both parties registered): place-of-supply = buyer's GSTIN state.
 *      - B2C: place-of-supply = buyer's registered address state.
 *      - Cross-border export of services (supplier IN → buyer foreign):
 *          * Zero-rated under IGST Act s.16 if payment in convertible forex.
 *          * Requires LUT (Letter of Undertaking) filed with GST authorities
 *            — captured in `OrganizationInvoice.lutNumber`.
 *      - Imports of services (foreign supplier → buyer IN): reverse charge
 *          mechanism (RCM) — `reverseCharge = true`, buyer pays GST.
 *
 * 2. IGST vs CGST+SGST split:
 *      - If place-of-supply state == supplier state → CGST (9%) + SGST (9%)
 *        = 18% total. Split 50/50.
 *      - If place-of-supply state != supplier state → IGST 18% only.
 *      - For services, default HSN/SAC code is 999293 (educational services).
 *      - Reclassify for consultancy: 998399 (other professional services).
 *
 * 3. GSTIN format: 15 characters. First 2 = state code. Characters 3-12 =
 *    PAN. Character 13 = entity number. Character 14 = 'Z' literal.
 *    Character 15 = checksum.
 *    Regex: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.
 *
 * 4. Regular vs composition scheme (`gstRegStatus`):
 *      - REGULAR: normal 18% with ITC.
 *      - COMPOSITION: 6% flat, no ITC (unlikely for B2B SaaS; flagged only).
 *      - UNREGISTERED: no GST, but buyer may apply RCM.
 *
 * 5. Invoice numbering: sequential per financial year per billing account,
 *    must be continuous. Use a DB sequence or row-lock helper — never
 *    regenerate after issue.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

import { numericStateCode } from "./state-codes";
import { hasValidPlatformLut } from "./lut";

export interface GstBreakdown {
  subtotalPaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
  hsnCode: string;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  reason: string;
}

const GST_RATE = 0.18; // 18% standard rate for SAC 999293 / 998399

/**
 * Derives GST breakdown for an invoice line subtotal.
 *
 * Rules (Sec 12 & 13 IGST Act):
 *  - Export (buyerCountry !== "IN"): zero-rated under IGST Act s.16
 *  - Intra-state (buyerState === supplierState): CGST 9% + SGST 9%
 *  - Inter-state (buyerState !== supplierState): IGST 18%
 *  - Unknown buyer state → falls back to IGST (conservative)
 */
export function deriveGstBreakdown(params: {
  subtotalPaise: number;
  supplierStateCode: string | null;
  buyerStateCode: string | null;
  buyerCountry: string;
  hsnCode?: string;
  // Optional GSTINs — when present their first 2 chars are the authoritative
  // state code and win over the stored/env codes.
  supplierGstin?: string | null;
  buyerGstin?: string | null;
}): GstBreakdown {
  const hsnCode = params.hsnCode ?? "999293";

  // #1132 — the two sides are stored in different representations and so never
  // compared equal: the seller is env-sourced alpha ("KA") while the buyer is
  // written numeric ("29") because the settings form strips non-digits. That
  // made the intra-state branch below unreachable and billed every domestic
  // customer IGST. Normalise both to the numeric code before comparing.
  const buyerState = numericStateCode(
    params.buyerGstin ?? null,
    params.buyerStateCode,
  );
  const supplierState = numericStateCode(
    params.supplierGstin ?? null,
    params.supplierStateCode,
  );

  // Derived AFTER resolution, not from the raw input: with buyerStateCode "27"
  // and a buyerGstin starting "29", the tax legs used 29 while the stored
  // place-of-supply still said 27 — an invoice whose heads and whose declared
  // place of supply disagree. When the buyer gave us something we cannot
  // resolve, report null rather than echoing an unusable code or silently
  // falling back to the supplier's own state.
  const placeOfSupply =
    params.buyerStateCode || params.buyerGstin
      ? buyerState
      : (supplierState ?? null);

  // Zero-rated export — but ONLY under a LUT valid for the current FY
  // (Rule 96A / Form RFD-11). #1230: the platform previously zero-rated on
  // buyer country alone; without a filed LUT those supplies were taxable at
  // 18% with interest, retroactively. Fail closed to IGST instead.
  if (params.buyerCountry !== "IN") {
    if (!hasValidPlatformLut()) {
      const taxPaise = Math.round(params.subtotalPaise * GST_RATE);
      return {
        subtotalPaise: params.subtotalPaise,
        igstPaise: taxPaise,
        cgstPaise: 0,
        sgstPaise: 0,
        totalPaise: params.subtotalPaise + taxPaise,
        hsnCode,
        placeOfSupply,
        reverseCharge: false,
        reason: "EXPORT_NO_LUT_IGST",
      };
    }
    return {
      subtotalPaise: params.subtotalPaise,
      igstPaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      totalPaise: params.subtotalPaise,
      hsnCode,
      placeOfSupply,
      reverseCharge: false,
      reason: "ZERO_RATED_EXPORT",
    };
  }

  // #778 §C — deliberate exemption from the floor-everywhere policy: this is
  // a statutory LEVY computation, not a split. Flooring would systematically
  // under-collect output tax; nearest-rounding matches invoice practice
  // (Sec 170 rounds to the rupee at the document level). The CGST/SGST halves
  // below still floor+remainder so the parts sum exactly.
  const taxPaise = Math.round(params.subtotalPaise * GST_RATE);

  // Intra-state: CGST + SGST split 50/50. An unresolvable state on either side
  // stays null and falls through to IGST — never treat unknown as a match.
  if (buyerState && supplierState && buyerState === supplierState) {
    // #776 — deterministic split: floor CGST, SGST absorbs the odd-paise
    // remainder so cgst+sgst === taxPaise exactly. The prior `Math.round(taxPaise/2)`
    // on both legs over-stated the total by 1 paise for odd taxPaise (~50% of
    // non-round subtotals), inflating OrganizationInvoice.totalPaise and
    // desyncing the accrual vs INVOICE_PAID ledger postings.
    const cgstPaise = Math.floor(taxPaise / 2);
    const sgstPaise = taxPaise - cgstPaise;
    return {
      subtotalPaise: params.subtotalPaise,
      igstPaise: 0,
      cgstPaise,
      sgstPaise,
      totalPaise: params.subtotalPaise + taxPaise,
      hsnCode,
      placeOfSupply,
      reverseCharge: false,
      reason: "INTRA_STATE_CGST_SGST",
    };
  }

  // Inter-state, or unknown buyer state. #771 §8 — flag the unknown-state case
  // distinctly so a missing place-of-supply that silently defaulted to IGST is
  // visible in the stored reason (auditable), rather than masquerading as a real
  // inter-state supply.
  // Keyed off the resolved codes, not the raw ones: a state we hold but cannot
  // map is just as unknown as an absent one, and must not read as inter-state.
  // #1132 — this covers BOTH sides. An unresolvable SUPPLIER state also lands
  // here (the intra-state branch requires both), and reporting that as
  // INTER_STATE_IGST recorded an unverified classification as a confirmed one.
  const igstReason =
    !buyerState || !supplierState ? "IGST_STATE_UNKNOWN" : "INTER_STATE_IGST";
  return {
    subtotalPaise: params.subtotalPaise,
    igstPaise: taxPaise,
    cgstPaise: 0,
    sgstPaise: 0,
    totalPaise: params.subtotalPaise + taxPaise,
    hsnCode,
    placeOfSupply,
    reverseCharge: false,
    reason: igstReason,
  };
}

/**
 * STUB: Validates a GSTIN format. Real impl includes checksum verification.
 */
export function isValidGstin(g: string | null | undefined): boolean {
  if (!g) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g);
}

/**
 * STUB: Resolves place-of-supply for a transaction. Returns null for
 * export/import scenarios.
 */
export function resolvePlaceOfSupply(params: {
  supplierStateCode: string | null;
  buyerStateCode: string | null;
  buyerCountry: string;
}): string | null {
  if (params.buyerCountry !== "IN") return null; // export
  return params.buyerStateCode ?? params.supplierStateCode ?? null;
}
