/**
 * Consultant-side TDS service — Section 194J + Form 26Q audit trail.
 *
 * This is the production pipeline for consultant payouts
 * (`lib/payments/payouts/payout-service.ts`). It owns:
 *   - Section 194J flat 10% / 20% calculation with the ₹50K fiscal-year threshold
 *   - Indian FY date arithmetic (Apr–Mar) and quarter mapping
 *   - Cumulative FY payout aggregation for threshold-crossing math
 *   - `TDSRecord` audit-trail writes (drives Form 26Q quarterly filing)
 *   - Admin queries for the TDS dashboard
 *
 * The companion lib `lib/compliance/tds.ts` handles the org-side payout
 * pipeline with the full 2026 statutory surface (Section 194-O ECO default,
 * 194J, 194C, Section 197 lower-rate certs, Section 206AA PAN fallback,
 * DTAA rate lookup). The two pipelines have different defaults and
 * different audit shapes — unifying them requires accountant signoff on
 * which section governs consultant payouts post-194-O (ECO precedence
 * argument vs the existing 194J threshold-based approach) and is tracked
 * as a separate PR. Do not delete this file without that signoff.
 *
 * Rules encoded here (Section 194J):
 * - Threshold: ₹50,000/financial year (April–March)
 * - Rate: 10% with verified PAN, 20% without PAN (Section 206AA)
 * - Applies to professional/technical services
 * - Must be deposited by 7th of next month
 * - Quarterly filing: Form 26Q
 *
 * ───────────────────────────────────────────────────────────────────────────
 * #778 §E — DEPRECATION PLAN (v1; do NOT execute without CA signoff)
 *
 * Decision: consolidate to a SINGLE TDS engine — `lib/compliance/tds.ts`
 * (Section 194-O) — and deprecate this 194J/₹50K consultant pipeline. 194-O
 * (0.1%, 5% no-PAN, 206AA, DTAA) is the correct default for an e-commerce
 * operator post-Oct-2024; running two engines with different defaults on
 * consultant vs org payouts is the divergence v3 flagged.
 *
 * Blocked on: written CA confirmation that 194-O governs consultant payouts
 * (ECO-precedence) rather than the 194J threshold path. Until then, KEEP both
 * and default conservative (higher withholding).
 *
 * When unblocked:
 *   1. Route consultant payouts through `deriveTds()` in compliance/tds.ts.
 *   2. Use the now-frozen schema: `ConsultantTaxInfo.taxEntityType` (#778 §D;
 *      canonical since the BLOCKER-0 dedup, #1230)
 *      + `tdsSection` override drive the residual 194J/194C threshold cases
 *      this engine handled; the ₹50K/entity-type threshold logic moves there.
 *   3. Keep `TDSRecord` + this file's FY/quarter arithmetic as the shared
 *      audit-trail writer; delete only the rate/section DECISION logic here.
 *   4. Rate fields move Float→integer bps (#781 §C) as part of the cutover so
 *      both engines share one exact rate representation.
 *   5. Verify TDS posts to the TDS_PAYABLE ledger account on both paths.
 *
 * Do not delete this file before steps 1–5 land + CA signoff.
 * ───────────────────────────────────────────────────────────────────────────
 */

import prisma, { type Tx } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";

// ============================================================================
// Constants
// ============================================================================

/** TDS threshold per financial year in paise (₹50,000 = 5,000,000 paise) */
export const TDS_THRESHOLD_PAISE = 5_000_000;

/** TDS rate with verified PAN (10%) */
export const TDS_RATE_WITH_PAN = 10;

/** TDS rate without PAN (20%) — Section 206AA */
export const TDS_RATE_WITHOUT_PAN = 20;

// #1132 — the 194-O taxable-base rules live in lib/compliance/tds-194o.ts so
// they stay unit-testable without pulling Prisma into the test. Re-exported
// here because the payout services already import from this module.
export {
  resolve194OTaxablePaise,
  TDS_194O_EXEMPTION_PAISE,
  TDS_194O_EXEMPT_ENTITY_TYPES,
} from "@/lib/compliance/tds-194o";

// ============================================================================
// Financial Year Utilities
// ============================================================================

/**
 * Get Indian financial year string for a date.
 * FY runs April 1 to March 31.
 * e.g., March 2027 → "2026-27", April 2027 → "2027-28"
 */
export function getIndianFinancialYear(date: Date = new Date()): string {
  // #813 — the Indian FY (Apr–Mar) is reckoned in IST, not UTC. Same +5:30 shift
  // as invoice-numbering.ts:indianFiscalYear; local getMonth/getFullYear mis-file
  // a near-midnight-IST Apr 1 payout under the prior FY on a UTC runtime.
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const month = ist.getUTCMonth(); // 0-indexed (0=Jan, 3=Apr)
  const year = ist.getUTCFullYear();

  // If Jan-Mar, FY started previous year
  const fyStartYear = month < 3 ? year - 1 : year;
  const fyEndYear = fyStartYear + 1;

  return `${fyStartYear}-${String(fyEndYear).slice(2)}`;
}

/**
 * Get the quarter number (1-4) for a date within the Indian FY.
 * Q1: Apr-Jun, Q2: Jul-Sep, Q3: Oct-Dec, Q4: Jan-Mar
 */
export function getIndianFYQuarter(date: Date = new Date()): number {
  // #813 — IST-reckoned like getIndianFinancialYear (see precedent there).
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const month = ist.getUTCMonth(); // 0-indexed
  if (month >= 3 && month <= 5) return 1; // Apr-Jun
  if (month >= 6 && month <= 8) return 2; // Jul-Sep
  if (month >= 9 && month <= 11) return 3; // Oct-Dec
  return 4; // Jan-Mar
}

/**
 * Get FY start and end dates for a financial year string.
 */
export function getFYDateRange(fy: string): { start: Date; end: Date } {
  const startYear = parseInt(fy.split("-")[0]);
  // IST-anchored boundaries (CR #1234 r3): the fiscal year is an Indian
  // legal construct, so Apr 1 00:00 means 18:30Z on Mar 31 — local-time
  // components put each bound 5½h late on a UTC host, excluding early-April
  // IST records and bleeding in next-FY ones. End stays EXCLUSIVE; callers
  // must use `lt`.
  const start = new Date(`${startYear}-03-31T18:30:00.000Z`);
  const end = new Date(`${startYear + 1}-03-31T18:30:00.000Z`);
  return { start, end };
}

// ============================================================================
// TDS Calculation
// ============================================================================

/**
 * Get cumulative payout amounts actually credited/paid for the current FY.
 * Uses completed payouts as the basis instead of raw earnings creation time.
 */
export async function getCurrentFYCumulativePayments(
  consultantProfileId: string,
  financialYear?: string,
): Promise<number> {
  const fy = financialYear || getIndianFinancialYear();
  const { start, end } = getFYDateRange(fy);

  const result = await prisma.consultantPayout.aggregate({
    where: {
      consultantProfileId,
      status: "COMPLETED",
      processedAt: { gte: start, lt: end },
    },
    _sum: { amount: true },
  });

  return sumPaise(result._sum.amount);
}

interface TDSCalculationResult {
  /** TDS amount to deduct, in paise */
  tdsAmount: number;
  /** TDS rate applied (10 or 20) */
  tdsRate: number;
  /** Whether cumulative payments crossed the threshold */
  isAboveThreshold: boolean;
  /** Cumulative credited/payout amounts for FY (BEFORE this payout), in paise */
  cumulativeBeforePayout: number;
  /** Cumulative credited/payout amounts for FY (AFTER this payout), in paise */
  cumulativeAfterPayout: number;
  /** Current financial year */
  financialYear: string;
}

/**
 * Calculate TDS for a payout.
 *
 * TDS applies when cumulative FY payments exceed ₹50,000.
 * If the threshold is crossed mid-payout, TDS is calculated on:
 * - The excess amount if this payout crosses the threshold
 * - The full payout amount if already above threshold
 */
/**
 * @deprecated #778 §E — the 194J/percent calculator. The engine of record is
 * lib/compliance/tds.ts (computeTdsForPayout); both payout paths call it via
 * the TDS_ENGINE-flagged derivation in the payout services. Kept only for
 * reference until the CA sign-off closes the question; do not add callers.
 */
export async function calculateTDS(params: {
  consultantProfileId: string;
  payoutAmountPaise: number;
}): Promise<TDSCalculationResult> {
  const { consultantProfileId, payoutAmountPaise } = params;
  const financialYear = getIndianFinancialYear();

  // Fetch tax info early for residency check + PAN verification
  const taxInfo = await prisma.consultantTaxInfo.findUnique({
    where: { consultantProfileId },
  });

  // Non-resident guard: Section 194J does not apply to non-residents.
  // Non-residents would need Section 195 (international withholding) which is not yet supported.
  if (taxInfo && !taxInfo.isIndianResident) {
    const cumulativeBeforePayout =
      await getCurrentFYCumulativePayments(consultantProfileId);
    return {
      tdsAmount: 0,
      tdsRate: 0,
      isAboveThreshold: false,
      cumulativeBeforePayout,
      cumulativeAfterPayout: cumulativeBeforePayout + payoutAmountPaise,
      financialYear,
    };
  }

  // Get cumulative payments for this FY
  const cumulativeBeforePayout =
    await getCurrentFYCumulativePayments(consultantProfileId);
  const cumulativeAfterPayout = cumulativeBeforePayout + payoutAmountPaise;

  // Below threshold — no TDS
  if (cumulativeAfterPayout <= TDS_THRESHOLD_PAISE) {
    return {
      tdsAmount: 0,
      tdsRate: 0,
      isAboveThreshold: false,
      cumulativeBeforePayout,
      cumulativeAfterPayout,
      financialYear,
    };
  }

  const tdsRate = taxInfo?.panVerified
    ? TDS_RATE_WITH_PAN
    : TDS_RATE_WITHOUT_PAN;

  // Calculate taxable amount
  let taxableAmount: number;

  if (cumulativeBeforePayout >= TDS_THRESHOLD_PAISE) {
    // Already above threshold — TDS on full payout
    taxableAmount = payoutAmountPaise;
  } else {
    // Crossing threshold this payout — TDS only on excess
    taxableAmount = cumulativeAfterPayout - TDS_THRESHOLD_PAISE;
  }

  const tdsAmount = Math.round((taxableAmount * tdsRate) / 100);

  return {
    tdsAmount,
    tdsRate,
    isAboveThreshold: true,
    cumulativeBeforePayout,
    cumulativeAfterPayout,
    financialYear,
  };
}

/**
 * Record a TDS deduction.
 * Called after payout is processed to create an audit trail.
 */
export async function recordTDSDeduction(params: {
  consultantProfileId: string;
  financialYear: string;
  tdsDeducted: number;
  /** #781 §C — integer basis points (194-O = 10, no-PAN 206AA = 500). */
  tdsRateBps: number;
  cumulativeAmountCredited: number;
  payoutId?: string;
  earningsId?: string;
  /** #776 — statutory section ("194O" for ECO consultant payouts) for 26Q audit. */
  tdsSection?: string;
  db?: Tx | typeof prisma;
}) {
  const quarter = getIndianFYQuarter();

  const db = params.db || prisma;

  return db.tDSRecord.create({
    data: {
      consultantProfileId: params.consultantProfileId,
      financialYear: params.financialYear,
      quarter,
      cumulativeAmountCredited: params.cumulativeAmountCredited,
      tdsDeducted: params.tdsDeducted,
      tdsRateBps: params.tdsRateBps,
      tdsSection: params.tdsSection ?? null,
      payoutId: params.payoutId,
      earningsId: params.earningsId,
    },
  });
}

/**
 * #813 — record a refund-driven TDS reversal as a negative `isReversal` TDSRecord
 * so the quarterly 26Q nets the withholding back out. Shared by the gateway/cron
 * refund cascade (operations/refund.ts) and admin forceRefund (earnings-service.ts),
 * which previously duplicated this with float math + no dedup cap.
 *
 * No-op (returns null) when there is nothing to reverse. All reads/writes go
 * through the passed tx so the reversal commits atomically with the cascade.
 */
export async function recordTdsReversal(
  tx: Tx | typeof prisma,
  params: {
    payoutId: string;
    consultantProfileId: string;
    earningsId?: string;
    /** Refund slice in paise; proportion basis numerator. */
    refundAmountPaise: number;
    /** Original payment amount in paise; proportion basis denominator. */
    paymentAmountPaise: number;
    /** Triggering Refund row, when the reversal arises from one (#778 §D). */
    refundId?: string;
  },
) {
  if (params.paymentAmountPaise <= 0) return null;

  // Original withholding for this payout/consultant.
  const original = await tx.tDSRecord.findFirst({
    where: {
      payoutId: params.payoutId,
      consultantProfileId: params.consultantProfileId,
      isReversal: false,
    },
  });
  if (!original || original.tdsDeducted <= 0) return null;

  // Integer paise proportion (floor — never reverse more than the refund earns).
  let tdsToReverse = Math.floor(
    (original.tdsDeducted * params.refundAmountPaise) /
      params.paymentAmountPaise,
  );
  if (tdsToReverse <= 0) return null;

  // Dedup + cap: prior reversals carry negative tdsDeducted, so their sum is the
  // negation of what's already been reversed. Cap cumulative reversal at the
  // original — stops a second cascade (app refund THEN lost-dispute chargeback)
  // from double-reversing, and keeps partial-refund accumulation bounded.
  const priorReversals = await tx.tDSRecord.findMany({
    where: {
      payoutId: params.payoutId,
      consultantProfileId: params.consultantProfileId,
      isReversal: true,
    },
    select: { tdsDeducted: true },
  });
  const alreadyReversed = priorReversals.reduce(
    (sum, r) => sum - r.tdsDeducted,
    0,
  );
  tdsToReverse = Math.min(tdsToReverse, original.tdsDeducted - alreadyReversed);
  if (tdsToReverse <= 0) return null;

  // FY/quarter policy (pending CA sign-off): an unfiled original is corrected in
  // place (copy its FY+quarter); a filed original (reportedInForm26Q) is adjusted
  // against the current quarter's liability (IST-aware now), since a correction
  // statement for a filed quarter is a manual CA action, not an automated rewrite.
  const filed = original.reportedInForm26Q === true;
  const financialYear = filed
    ? getIndianFinancialYear()
    : original.financialYear;
  const quarter = filed ? getIndianFYQuarter() : original.quarter;

  const reversal = await tx.tDSRecord.create({
    data: {
      consultantProfileId: params.consultantProfileId,
      financialYear,
      quarter,
      cumulativeAmountCredited: original.cumulativeAmountCredited,
      tdsDeducted: -tdsToReverse, // signed: reverses prior withholding
      tdsRateBps: original.tdsRateBps,
      tdsSection: original.tdsSection,
      payoutId: params.payoutId,
      earningsId: params.earningsId,
      isReversal: true,
    },
  });

  // #778 §D — the filing artifact. The negative TDSRecord above stays the
  // YTD/dedup-cap source of truth; TdsAdjustment is what the Form 26Q/140
  // return generator exports as the revised-statement line. Emitting both is
  // additive (no reader of TdsAdjustment exists yet) and lets the export land
  // without re-deriving history.
  await tx.tdsAdjustment.create({
    data: {
      consultantProfileId: params.consultantProfileId,
      tdsRecordId: reversal.id,
      payoutId: params.payoutId,
      refundId: params.refundId ?? null,
      financialYear,
      quarter,
      amountPaise: -tdsToReverse,
      reason: filed
        ? "refund reversal — original quarter already filed; adjust current quarter"
        : "refund reversal — original quarter unfiled; corrected in place",
    },
  });

  return reversal;
}

// ============================================================================
// Org rail (#1354)
//
// Host-organisation payouts computed and stamped their withholding on
// `OrganizationPayout` from day one, but never wrote a `TDSRecord`. Everything
// downstream of withholding — the quarterly return draft, the TDS dashboard,
// the reversal cap — reads TDSRecord, so an entire rail of real statutory
// deductions was invisible to the filing side.
//
// These are siblings of the consultant writers above rather than a widening of
// them: the consultant bodies are load-bearing for the 194-O/194J question that
// is still open on CA sign-off (#778 §E), and the two rails key, dedupe and
// reverse differently. What they share is the FY/quarter arithmetic and the
// filed-aware correction policy, which are called, not copied.
// ============================================================================

/**
 * Record an org-rail TDS deduction. Mirrors {@link recordTDSDeduction} with
 * the consultant columns left null; the XOR CHECK in
 * prisma/sql/check-constraints.sql is what makes that structurally correct.
 */
export async function recordOrgTDSDeduction(params: {
  organizationId: string;
  financialYear: string;
  tdsDeducted: number;
  /** #781 §C — integer basis points (194-O/§393 = 10, no-PAN §397(2) = 500). */
  tdsRateBps: number;
  cumulativeAmountCredited: number;
  orgPayoutId: string;
  /**
   * Fiscal quarter the deduction is dated in. Callers that already know the
   * instant the withholding happened MUST pass it together with the matching
   * `financialYear`: deriving one from the caller and the other from "now"
   * yields impossible periods such as FY 2025-26 Q1.
   */
  quarter?: number;
  /** #776 — statutory section applied, for the return's line classification. */
  tdsSection?: string;
  db?: Tx | typeof prisma;
}) {
  const quarter = params.quarter ?? getIndianFYQuarter();
  const db = params.db || prisma;

  return db.tDSRecord.create({
    data: {
      consultantProfileId: null,
      organizationId: params.organizationId,
      financialYear: params.financialYear,
      quarter,
      cumulativeAmountCredited: params.cumulativeAmountCredited,
      tdsDeducted: params.tdsDeducted,
      tdsRateBps: params.tdsRateBps,
      tdsSection: params.tdsSection ?? null,
      payoutId: null,
      orgPayoutId: params.orgPayoutId,
    },
  });
}

/**
 * How much of an org payout's withholding a reversal takes back.
 *
 * A bank-returned payout (`markOrgPayoutReversed`, COMPLETED → REVERSED) undoes
 * the whole disbursement, so the whole deduction goes with it. PROPORTIONAL is
 * the refund-cascade shape the consultant rail already uses; no caller reaches
 * it yet, and it is declared here so the org refund cascade does not have to
 * re-open this function's contract to arrive.
 */
export type OrgTdsReversalBasis =
  | { kind: "FULL" }
  | {
      kind: "PROPORTIONAL";
      refundAmountPaise: number;
      payoutAmountPaise: number;
    };

/**
 * #1354 — org-rail counterpart of {@link recordTdsReversal}: writes the
 * negative `TDSRecord` that nets the withholding back out of the quarter, plus
 * the `TdsAdjustment` the return generator exports as the revised-statement
 * line. Returns null when there is nothing to reverse.
 *
 * All reads and writes go through the passed tx so the reversal commits
 * atomically with the payout's own state change.
 */
export async function recordOrgTdsReversal(
  tx: Tx | typeof prisma,
  params: {
    orgPayoutId: string;
    organizationId: string;
    reversalBasis: OrgTdsReversalBasis;
    /** Triggering Refund row, when the reversal arises from one (#778 §D). */
    refundId?: string;
  },
) {
  const original = await tx.tDSRecord.findFirst({
    where: {
      orgPayoutId: params.orgPayoutId,
      organizationId: params.organizationId,
      isReversal: false,
    },
  });
  if (!original || original.tdsDeducted <= 0) return null;

  let tdsToReverse: number;
  if (params.reversalBasis.kind === "FULL") {
    tdsToReverse = original.tdsDeducted;
  } else {
    const { refundAmountPaise, payoutAmountPaise } = params.reversalBasis;
    if (payoutAmountPaise <= 0) return null;
    // Integer paise proportion (floor — never reverse more than the refund earns).
    tdsToReverse = Math.floor(
      (original.tdsDeducted * refundAmountPaise) / payoutAmountPaise,
    );
  }
  if (tdsToReverse <= 0) return null;

  // Dedup + cap, same contract as the consultant rail: prior reversals carry
  // negative tdsDeducted, so their sum negated is what has already been taken
  // back. Without the cap a redelivered `payout.reversed` webhook would reverse
  // the deduction twice and the quarter would report negative withholding.
  const priorReversals = await tx.tDSRecord.findMany({
    where: {
      orgPayoutId: params.orgPayoutId,
      organizationId: params.organizationId,
      isReversal: true,
    },
    select: { tdsDeducted: true },
  });
  const alreadyReversed = priorReversals.reduce(
    (sum, r) => sum - r.tdsDeducted,
    0,
  );
  tdsToReverse = Math.min(tdsToReverse, original.tdsDeducted - alreadyReversed);
  if (tdsToReverse <= 0) return null;

  // Same filed-aware FY/quarter policy as the consultant rail: an unfiled
  // original is corrected in place; a filed one is adjusted against the current
  // quarter, because a correction statement for a filed quarter is a manual CA
  // action rather than an automated rewrite.
  const filed = original.reportedInForm26Q === true;
  const financialYear = filed
    ? getIndianFinancialYear()
    : original.financialYear;
  const quarter = filed ? getIndianFYQuarter() : original.quarter;

  const reversal = await tx.tDSRecord.create({
    data: {
      consultantProfileId: null,
      organizationId: params.organizationId,
      financialYear,
      quarter,
      cumulativeAmountCredited: original.cumulativeAmountCredited,
      tdsDeducted: -tdsToReverse, // signed: reverses prior withholding
      tdsRateBps: original.tdsRateBps,
      tdsSection: original.tdsSection,
      payoutId: null,
      orgPayoutId: params.orgPayoutId,
      isReversal: true,
    },
  });

  await tx.tdsAdjustment.create({
    data: {
      consultantProfileId: null,
      organizationId: params.organizationId,
      tdsRecordId: reversal.id,
      orgPayoutId: params.orgPayoutId,
      refundId: params.refundId ?? null,
      financialYear,
      quarter,
      amountPaise: -tdsToReverse,
      reason: filed
        ? "org payout reversal — original quarter already filed; adjust current quarter"
        : "org payout reversal — original quarter unfiled; corrected in place",
    },
  });

  return reversal;
}

// ============================================================================
// Admin Queries
// ============================================================================

/**
 * Get TDS summary for a financial year.
 */
export async function getTDSSummary(financialYear: string) {
  const records = await prisma.tDSRecord.groupBy({
    by: ["quarter"],
    where: { financialYear },
    _sum: { tdsDeducted: true },
    _count: true,
  });

  const totalDeducted = await prisma.tDSRecord.aggregate({
    where: { financialYear },
    _sum: { tdsDeducted: true },
    _count: true,
  });

  const unfiled = await prisma.tDSRecord.count({
    where: { financialYear, reportedInForm26Q: false },
  });

  return {
    financialYear,
    quarterWise: records.map((r) => ({
      quarter: r.quarter,
      totalDeducted: sumPaise(r._sum.tdsDeducted),
      count: r._count,
    })),
    totalDeducted: sumPaise(totalDeducted._sum.tdsDeducted),
    totalRecords: totalDeducted._count,
    unfiledRecords: unfiled,
  };
}

/**
 * Get per-consultant TDS breakdown for a financial year.
 */
export async function getConsultantTDSBreakdown(financialYear: string) {
  const rows = await prisma.tDSRecord.groupBy({
    by: ["consultantProfileId", "tdsRateBps"],
    where: { financialYear },
    _sum: { tdsDeducted: true, cumulativeAmountCredited: true },
    _count: true,
    orderBy: { _sum: { tdsDeducted: "desc" } },
  });
  // The money result extension does not apply to _sum/groupBy — its own header
  // says so. Returning the raw rows put BigInt into NextResponse.json, which
  // throws; the route's catch turned that into a 500, and the TDS page has no
  // error branch, so it rendered "No consultant TDS for <FY>" — a statutory
  // withholding report that reported nothing, indistinguishable from a year
  // with no deductions.
  return rows.map((r) => ({
    ...r,
    _sum: {
      tdsDeducted: sumPaise(r._sum.tdsDeducted),
      cumulativeAmountCredited: sumPaise(r._sum.cumulativeAmountCredited),
    },
  }));
}

/**
 * Mark TDS records as filed in Form 26Q.
 */
export async function markTDSAsFiled(params: {
  financialYear: string;
  quarter: number;
  filingDate: Date;
}) {
  return prisma.tDSRecord.updateMany({
    where: {
      financialYear: params.financialYear,
      quarter: params.quarter,
      reportedInForm26Q: false,
    },
    data: {
      reportedInForm26Q: true,
      form26QFilingDate: params.filingDate,
    },
  });
}
