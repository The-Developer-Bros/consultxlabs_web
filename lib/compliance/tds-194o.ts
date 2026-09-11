/**
 * Section 194-O taxable-base resolution — pure tax math, no I/O (#1132).
 *
 * Deliberately separate from lib/payments/tax/tds-service.ts, which imports
 * Prisma: the statutory rules below are worth testing in isolation, and pulling
 * a database client into that test buys nothing.
 *
 * 194-O is now s.393(1) Table Sl. 8(v) of the Income-tax Act 2025. The base is
 * the GROSS amount of the sale or service — CBDT Circulars 17/2020 and 20/2021
 * are explicit that the operator's retained commission is not deductible from
 * it, and Note 3 to s.393 even deems direct customer-to-participant payments
 * into the gross.
 */

/**
 * Section 194-O exemption per financial year in paise (₹5,00,000 = 50,000,000).
 * #1132 — distinct from TDS_THRESHOLD_PAISE above, which is the 194J figure and
 * was being applied to 194-O by mistake (10x too low).
 *
 * The exemption is only available when ALL THREE limbs hold; it is not a
 * general allowance:
 *   1. the participant is an individual or a HUF (companies, firms and LLPs are
 *      withheld from the first rupee — there is no threshold for them), AND
 *   2. gross FY receipts do not exceed ₹5,00,000, AND
 *   3. PAN or Aadhaar has been furnished.
 */
export const TDS_194O_EXEMPTION_PAISE = 50_000_000;

/**
 * Entity types eligible for the 194-O ₹5L exemption (limb 1). Everything else
 * in TaxEntityType — PARTNERSHIP, LLP, COMPANY — is withheld from the first
 * rupee. A null/unknown entity type is treated as ineligible: withholding too
 * much is recoverable by the consultant at assessment, withholding too little
 * is our s.201 liability.
 */
export const TDS_194O_EXEMPT_ENTITY_TYPES = ["INDIVIDUAL", "HUF"] as const;

/**
 * Resolves the 194-O taxable amount for a payout, applying the three-limb ₹5L
 * exemption. `grossBeforePaise` / `grossThisPayoutPaise` are GROSS consideration
 * (not net of platform commission) — see ENABLE_TDS_194O_GROSS.
 *
 * Returns the portion of this payout that is taxable. On the payout that
 * crosses the exemption, only the excess is taxable.
 */
export function resolve194OTaxablePaise(params: {
  grossBeforePaise: number;
  grossThisPayoutPaise: number;
  entityType: string | null;
  panOnFile: boolean;
}): { taxablePaise: number; reason: string } {
  const eligible =
    params.panOnFile &&
    params.entityType !== null &&
    (TDS_194O_EXEMPT_ENTITY_TYPES as readonly string[]).includes(
      params.entityType,
    );

  if (!eligible) {
    const why = !params.panOnFile
      ? "no PAN on file"
      : `entity type ${params.entityType ?? "unknown"} has no 194-O threshold`;
    return {
      taxablePaise: params.grossThisPayoutPaise,
      reason: `194-O exemption not available (${why}) — taxable from the first rupee`,
    };
  }

  const cumulative = params.grossBeforePaise + params.grossThisPayoutPaise;
  if (cumulative <= TDS_194O_EXEMPTION_PAISE) {
    return {
      taxablePaise: 0,
      reason: `below ₹5L 194-O exemption (cumulative gross=${cumulative} paise)`,
    };
  }
  if (params.grossBeforePaise >= TDS_194O_EXEMPTION_PAISE) {
    return {
      taxablePaise: params.grossThisPayoutPaise,
      reason: "194-O exemption already exhausted this FY — fully taxable",
    };
  }
  return {
    taxablePaise: cumulative - TDS_194O_EXEMPTION_PAISE,
    reason: `crossing the ₹5L 194-O exemption — taxable on the excess only`,
  };
}
