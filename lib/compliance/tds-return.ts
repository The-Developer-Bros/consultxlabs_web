/**
 * Form 26Q / Form 140 draft builder — quarterly TDS return scaffold (#1230).
 *
 * TDS accrues into `TDSRecord` rows continuously; this module is the
 * filing-side half that turns a quarter of those rows into the deductee-wise
 * draft a chartered accountant works from. From FY 2026-27 the quarterly
 * resident return moves from Form 26Q to **Form 140** under the Income Tax
 * Act 2025, so the builder emits the data shape for both labels and leaves
 * portal serialization (FVU) as the explicit remaining human step.
 *
 * #1354 — both withholding rails now arrive here. Host-organisation payouts
 * write a `TDSRecord` at completion exactly as consultant payouts do, so a
 * deductee is identified by a (type, id) pair rather than by a consultant id.
 * The draft that used to carry a standing warning about org withholding having
 * no return artifact no longer needs one, because the artifact exists.
 *
 * Reversal semantics: refund- and bounce-triggered reversals arrive as
 * negative `tdsDeducted` rows (`isReversal: true`). They net against the
 * quarter's deduction rather than being dropped, mirroring how the portal
 * treats late-claim adjustments, and they are also kept separable so the CSV
 * can emit them as their own line.
 *
 * Pure module (no Prisma import) so it stays unit-testable under jsdom.
 */

import { escapeCsvField } from "@/lib/csv/keyset-export";

/** Which rail a deductee sits on. The two never share an identifier space. */
export type TdsDeducteeType = "CONSULTANT" | "ORGANIZATION";

export interface TdsReturnSourceRow {
  deducteeType: TdsDeducteeType;
  /** ConsultantProfile id or Organization id, per `deducteeType`. */
  deducteeId: string;
  /** Name as it should appear against the PAN; null when we hold none. */
  deducteeName: string | null;
  /** Last four PAN characters only — the draft never carries a full PAN. */
  deducteePanLast4: string | null;
  deducteeGstin: string | null;
  tdsSection: string | null;
  /** IT Act 2025 §393 challan payment code; null on pre-2026 rate rows. */
  paymentCode: string | null;
  /** Amount credited/paid to the deductee this record covers, paise. */
  amountCreditedPaise: number;
  /** TDS deducted (negative for reversal records), paise. */
  tdsDeductedPaise: number;
  isReversal: boolean;
}

export interface TdsReturnDeductee {
  deducteeType: TdsDeducteeType;
  deducteeId: string;
  deducteeName: string | null;
  deducteePanLast4: string | null;
  deducteeGstin: string | null;
  tdsSection: string;
  paymentCode: string | null;
  amountCreditedPaise: number;
  /** Positive withholding booked in the quarter, paise. */
  deductionsPaise: number;
  /** Reversals booked in the quarter, paise (negative or zero). */
  reversalsPaise: number;
  /** `deductionsPaise + reversalsPaise` — what the quarter actually owes. */
  tdsDeductedNetPaise: number;
}

export interface TdsReturnDraft {
  formLabel: "FORM_26Q" | "FORM_140";
  financialYear: string;
  quarter: number;
  /** Deductee-count for the challan annex. */
  deductees: TdsReturnDeductee[];
  totalAmountCreditedPaise: number;
  totalTdsDeductedNetPaise: number;
  warnings: string[];
}

/** India has no DST, so the offset is a constant rather than a tz lookup. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * IST fiscal quarters: Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
 * Accepts any instant inside the quarter.
 */
export function indianFyQuarterOf(instantUTC: Date): {
  financialYear: string;
  quarter: number;
} {
  const ist = new Date(instantUTC.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth() + 1; // 1..12
  // Indian FY runs Apr→Mar; FY label uses the START calendar year ("2026-27").
  const fyStartYear = m >= 4 ? y : y - 1;
  const quarter = Math.ceil((((m - 4 + 12) % 12) + 1) / 3);
  return {
    financialYear: `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`,
    quarter,
  };
}

/**
 * The fiscal quarter that had already CLOSED at `instantUTC`.
 *
 * #1354 — a return is filed for a finished quarter, so the run that fires on
 * the fifth of the month after a quarter ends must not target the quarter that
 * contains today: on 5 April that is FY 2026-27 Q1, five days old, instead of
 * the FY 2025-26 Q4 that is actually due. Stepping back to the instant before
 * the current quarter opened lands inside the closed one whatever the month.
 */
export function closedIndianFyQuarterOf(instantUTC: Date): {
  financialYear: string;
  quarter: number;
} {
  const ist = new Date(instantUTC.getTime() + IST_OFFSET_MS);
  // Quarters open in Apr, Jul, Oct and Jan, i.e. every third month from Apr.
  const monthsIntoQuarter = (((ist.getUTCMonth() - 3) % 3) + 3) % 3;
  const quarterStartIstMs = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth() - monthsIntoQuarter,
    1,
  );
  return indianFyQuarterOf(new Date(quarterStartIstMs - IST_OFFSET_MS - 1));
}

/**
 * Aggregation key for a deductee across every section they were withheld
 * under. The CSV's full-PAN lookup is keyed the same way, because a PAN
 * belongs to the person, not to the section a payment was classified under.
 */
export function tdsDeducteeKey(
  deducteeType: TdsDeducteeType,
  deducteeId: string,
): string {
  return `${deducteeType}:${deducteeId}`;
}

/**
 * Where the quarter's full-PAN CSV lives in the private bucket. The export job
 * writes it and the admin route signs it, so the path is derived once here
 * rather than spelled out twice.
 */
export function tdsReturnCsvStoragePath(
  financialYear: string,
  quarter: number,
): string {
  return `compliance/tds/${financialYear}-Q${quarter}.csv`;
}

export function buildTdsReturnDraft(
  rows: TdsReturnSourceRow[],
  financialYear: string,
  quarter: number,
): TdsReturnDraft {
  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push(
      "No TDSRecord rows in scope — verify the payout pipeline ran this quarter.",
    );
  }

  let totalAmountCreditedPaise = 0;
  let totalTdsDeductedNetPaise = 0;
  const byDeductee = new Map<string, TdsReturnDeductee>();

  for (const row of rows) {
    const credited = Math.max(0, Math.round(row.amountCreditedPaise));
    const tds = Math.round(row.tdsDeductedPaise); // negatives are legitimate (reversals)
    totalAmountCreditedPaise += credited;
    totalTdsDeductedNetPaise += tds;

    // #1354 — the type is part of the key, not decoration: a consultant id and
    // an organisation id are drawn from different spaces and a collision would
    // merge two unrelated deductees onto one return line.
    const key = `${row.deducteeType}:${row.deducteeId}:${row.tdsSection ?? "UNKNOWN"}`;
    const agg = byDeductee.get(key) ?? {
      deducteeType: row.deducteeType,
      deducteeId: row.deducteeId,
      deducteeName: row.deducteeName,
      deducteePanLast4: row.deducteePanLast4,
      deducteeGstin: row.deducteeGstin,
      tdsSection: row.tdsSection ?? "UNKNOWN",
      paymentCode: row.paymentCode,
      amountCreditedPaise: 0,
      deductionsPaise: 0,
      reversalsPaise: 0,
      tdsDeductedNetPaise: 0,
    };
    agg.amountCreditedPaise += credited;
    if (row.isReversal) agg.reversalsPaise += tds;
    else agg.deductionsPaise += tds;
    agg.tdsDeductedNetPaise = agg.deductionsPaise + agg.reversalsPaise;
    byDeductee.set(key, agg);
  }

  const deductees = [...byDeductee.values()].sort(
    (a, b) => b.tdsDeductedNetPaise - a.tdsDeductedNetPaise,
  );

  if (deductees.some((d) => d.tdsSection === "UNKNOWN")) {
    warnings.push(
      "Some rows carry no tdsSection — they cannot be classified onto a Form 140 payment code until payout stamping covers them.",
    );
  }
  // A deductee we hold no PAN for has to be withheld at the punitive rate under
  // s.397(2) of the IT Act 2025 (the s.206AA successor); filing the line at the
  // ordinary rate makes the shortfall our liability, not theirs.
  const noPan = deductees.filter((d) => !d.deducteePanLast4);
  if (noPan.length > 0) {
    warnings.push(
      `${noPan.length} deductee line(s) carry no PAN on file — s.397(2) requires the higher no-PAN rate, so verify the withheld amount before filing.`,
    );
  }
  // §393 payment codes are how the IT Act 2025 return classifies a line; the
  // pre-2026 Form 26Q had no equivalent, so only flag it once it is required.
  if (financialYear >= "2026-27") {
    const noCode = deductees.filter((d) => !d.paymentCode);
    if (noCode.length > 0) {
      warnings.push(
        `${noCode.length} deductee line(s) have no §393 payment code — add an effective-dated TdsRate row for the section before the return is serialized.`,
      );
    }
  }

  return {
    // The IT Act 2025 renames the resident quarterly return from FY 2026-27.
    formLabel: financialYear >= "2026-27" ? "FORM_140" : "FORM_26Q",
    financialYear,
    quarter,
    deductees,
    totalAmountCreditedPaise,
    totalTdsDeductedNetPaise,
    warnings,
  };
}

/** Exact column order the CA's import template expects. */
const TDS_RETURN_CSV_HEADER =
  "deductee_type,pan,deductee_name,section,payment_code,amount_credited_paise,tds_deducted_paise,quarter,financial_year,is_reversal";

/**
 * Serialize a draft as the CSV the chartered accountant imports into the FVU
 * utility. This is the ONLY artifact that carries a full PAN, and it never
 * reads one off the draft: the caller supplies `fullPanByDeducteeKey` (keyed
 * by {@link tdsDeducteeKey}) from a just-in-time decrypt, so the in-memory
 * draft and every log line derived from it stay masked.
 *
 * Reversals get their own `is_reversal=true` line with `amount_credited_paise`
 * zero, because the portal treats a reversal as an adjustment against a
 * previously reported credit rather than as a new credit of its own.
 */
export function buildTdsReturnCsv(
  draft: TdsReturnDraft,
  fullPanByDeducteeKey: Map<string, string | null>,
): string {
  const lines: string[] = [TDS_RETURN_CSV_HEADER];

  for (const d of draft.deductees) {
    const pan =
      fullPanByDeducteeKey.get(tdsDeducteeKey(d.deducteeType, d.deducteeId)) ??
      null;
    const emit = (
      amountCreditedPaise: number,
      tdsDeductedPaise: number,
      isReversal: boolean,
    ) => {
      lines.push(
        [
          escapeCsvField(d.deducteeType),
          escapeCsvField(pan),
          escapeCsvField(d.deducteeName),
          escapeCsvField(d.tdsSection),
          escapeCsvField(d.paymentCode),
          escapeCsvField(amountCreditedPaise),
          escapeCsvField(tdsDeductedPaise),
          escapeCsvField(draft.quarter),
          escapeCsvField(draft.financialYear),
          escapeCsvField(String(isReversal)),
        ].join(","),
      );
    };

    emit(d.amountCreditedPaise, d.deductionsPaise, false);
    if (d.reversalsPaise !== 0) emit(0, d.reversalsPaise, true);
  }

  return lines.join("\n") + "\n";
}
