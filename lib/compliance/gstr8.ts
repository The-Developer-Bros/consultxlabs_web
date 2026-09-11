/**
 * GSTR-8 draft builder — GST-TCS u/s 52 statement (#1230).
 *
 * An e-commerce operator must file GSTR-8 by the 10th of the following
 * month, depositing TCS at 0.5% of the NET value of taxable supplies
 * facilitated through the platform (supplies minus returns, GST-exclusive).
 * There is no turnover threshold and no nil concession; late filing bars the
 * credit permanently after three years.
 *
 * The statutory split is 0.25% CGST + 0.25% SGST for intra-state supplies and
 * 0.5% IGST for inter-state — but the collection pipeline does not yet stamp
 * place-of-supply on payments, so this draft reports TOTALS only and leaves
 * the intra/inter columns explicitly null rather than guessing. That is the
 * honest scaffold: the numbers become filing-grade when the §52 accrual
 * writer lands (blocked on the money-path-hardening merge) and starts
 * populating Payment.gstTcsCollectedPaise / state metadata.
 *
 * Pure module (no Prisma import) so it stays unit-testable under jsdom.
 */

export interface Gstr8SourceRow {
  /** Supplier (consultant) identifier for the seller-wise annex. */
  consultantProfileId: string;
  /** Net taxable value of supplies facilitated for this supplier, paise. */
  netTaxablePaise: number;
  /** TCS collected against these supplies, paise. */
  tcsCollectedPaise: number;
}

export interface Gstr8Draft {
  periodLabel: string;
  /** GSTR-8 Table 3 aggregate: net value of taxable supplies. */
  totalNetTaxablePaise: number;
  /** GSTR-8 Table 4 aggregate: TCS collected. */
  totalTcsCollectedPaise: number;
  /**
   * Intra/inter-state TCS split — deliberately null until place-of-supply
   * capture exists; a guessed split files wrong CGST/SGST heads.
   */
  intraStateTcsPaise: null;
  interStateTcsPaise: null;
  suppliers: Array<{
    consultantProfileId: string;
    netTaxablePaise: number;
    tcsCollectedPaise: number;
  }>;
  warnings: string[];
}

/** IST fiscal-month label like "2026-08" — GSTR-8 periods are calendar months. */
export function gstr8PeriodLabel(monthStartUTC: Date): string {
  // IST is UTC+5:30; a supply at 2026-08-01T00:15Z belongs to July IST-side?
  // No — UTC midnight + 5:30h is still Aug 1 IST. Only times before 18:30Z on
  // the 1st could slip back; anchor on IST date arithmetic to stay exact.
  const ist = new Date(monthStartUTC.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function buildGstr8Draft(
  rows: Gstr8SourceRow[],
  monthStartUTC: Date,
): Gstr8Draft {
  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push("No TCS-bearing rows for the period — verify the accrual writer ran.");
  }

  let totalNetTaxablePaise = 0;
  let totalTcsCollectedPaise = 0;
  const bySupplier = new Map<
    string,
    { netTaxablePaise: number; tcsCollectedPaise: number }
  >();

  for (const row of rows) {
    // Integer-paise doctrine (ADR-02): clamp negatives here rather than
    // letting a refund-adjustment bug file a negative liability.
    const net = Math.max(0, Math.round(row.netTaxablePaise));
    const tcs = Math.max(0, Math.round(row.tcsCollectedPaise));
    totalNetTaxablePaise += net;
    totalTcsCollectedPaise += tcs;

    const agg = bySupplier.get(row.consultantProfileId) ?? {
      netTaxablePaise: 0,
      tcsCollectedPaise: 0,
    };
    agg.netTaxablePaise += net;
    agg.tcsCollectedPaise += tcs;
    bySupplier.set(row.consultantProfileId, agg);
  }

  return {
    periodLabel: gstr8PeriodLabel(monthStartUTC),
    totalNetTaxablePaise,
    totalTcsCollectedPaise,
    intraStateTcsPaise: null,
    interStateTcsPaise: null,
    suppliers: [...bySupplier.entries()].map(([id, v]) => ({
      consultantProfileId: id,
      ...v,
    })),
    warnings,
  };
}
