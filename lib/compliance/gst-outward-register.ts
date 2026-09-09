/**
 * Outward-supplies register — #1370.
 *
 * The one artefact a CA actually needs to file GSTR-1: every tax invoice and
 * every credit note the platform issued in a period, B2B and B2C in a single
 * list, with the tax heads, the place of supply and the document references
 * already resolved. Before this existed the org invoices lived in one model,
 * the consumer invoices in another and the credit notes in two more, and
 * reconciling them was a manual export-and-merge each month.
 *
 * Pure module: no Prisma import, no clock, no environment. The job in
 * jobs/compliance/gst-outward-register-export.ts reads the rows and this
 * builds the register and the CSV from them, so the shaping is unit-testable
 * and the reading stays in one place.
 */

import { escapeCsvField } from "@/lib/csv/keyset-export";

export interface OutwardRegisterRow {
  docType: "INVOICE" | "CREDIT_NOTE";
  docNumber: string;
  docDate: Date;
  buyerType: "B2B" | "B2C";
  /** The buyer's GSTIN for a B2B supply; always null for B2C. */
  buyerGstin: string | null;
  /** 2-digit numeric state code, or null when the document never resolved one. */
  placeOfSupply: string | null;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  sacCode: string;
  /** For a credit note, the invoice it adjusts (s.34(1)); null on an invoice. */
  originalInvoiceNumber: string | null;
  paymentId: string | null;
  /** Rule 46: a B2C document of ₹50,000 or more without the recipient's
   *  address and state. */
  needsBuyerAddress: boolean;
}

export interface OutwardRegisterTotals {
  documentCount: number;
  invoiceCount: number;
  creditNoteCount: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface OutwardRegister {
  periodLabel: string;
  rows: OutwardRegisterRow[];
  totals: OutwardRegisterTotals;
  warnings: string[];
}

/** ₹50,000 in paise — the Rule 46 B2C address threshold. */
const RULE_46_ADDRESS_THRESHOLD_PAISE = 5_000_000;

function istDateLabel(d: Date): string {
  // Every statutory period here is reckoned in IST, so a UTC-midnight boundary
  // must be shifted before its calendar components are read.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Aggregate the period's documents and flag everything a filer would have to
 * chase. The warnings are the point of the exercise: a register that silently
 * totals a document with no place of supply files it under the wrong state.
 */
export function buildOutwardRegister(
  rows: OutwardRegisterRow[],
  periodStart: Date,
  periodEnd: Date,
): OutwardRegister {
  const warnings: string[] = [];
  const totals: OutwardRegisterTotals = {
    documentCount: rows.length,
    invoiceCount: 0,
    creditNoteCount: 0,
    taxablePaise: 0,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 0,
    totalPaise: 0,
  };

  for (const row of rows) {
    if (row.docType === "INVOICE") totals.invoiceCount += 1;
    else totals.creditNoteCount += 1;
    totals.taxablePaise += row.taxablePaise;
    totals.cgstPaise += row.cgstPaise;
    totals.sgstPaise += row.sgstPaise;
    totals.igstPaise += row.igstPaise;
    totals.totalPaise += row.totalPaise;

    if (!row.placeOfSupply) {
      warnings.push(
        `${row.docNumber}: no place of supply on the document — GSTR-1 cannot assign it to a state.`,
      );
    }

    const heads = row.cgstPaise + row.sgstPaise + row.igstPaise;
    if (heads !== row.totalPaise - row.taxablePaise) {
      warnings.push(
        `${row.docNumber}: tax heads (${heads}p) do not reconcile to total minus taxable (${
          row.totalPaise - row.taxablePaise
        }p).`,
      );
    }

    if (
      row.buyerType === "B2C" &&
      row.totalPaise >= RULE_46_ADDRESS_THRESHOLD_PAISE &&
      row.needsBuyerAddress
    ) {
      warnings.push(
        `${row.docNumber}: B2C document of ₹50,000 or more without the recipient's address and state (Rule 46).`,
      );
    }
  }

  return {
    // `periodEnd` is EXCLUSIVE (the job queries `lt`), so labelling it names a
    // day the file does not contain and a filer reads the register as covering
    // one extra day. Step back a whole day rather than a millisecond: the label
    // is rendered in IST and a GST_REGISTER_PERIOD_END override is a UTC
    // midnight, so `periodEnd - 1ms` still lands inside the next IST calendar
    // day and would print the same wrong date.
    periodLabel: `${istDateLabel(periodStart)} to ${istDateLabel(
      new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000),
    )}`,
    rows,
    totals,
    warnings,
  };
}

/** The CSV column order the register is filed from. Changing it changes the
 *  file the CA's import template expects, so it is written out once here. */
export const OUTWARD_REGISTER_CSV_HEADER =
  "doc_type,doc_number,doc_date,buyer_type,buyer_gstin,place_of_supply," +
  "taxable_paise,cgst_paise,sgst_paise,igst_paise,total_paise,sac_code," +
  "original_invoice_number,payment_id";

export function buildOutwardRegisterCsv(rows: OutwardRegisterRow[]): string {
  const lines = [OUTWARD_REGISTER_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        row.docType,
        row.docNumber,
        // ISO date only: the filing is date-precision, and a time component
        // invites a spreadsheet to reinterpret the cell.
        istDateLabel(row.docDate),
        row.buyerType,
        row.buyerGstin,
        row.placeOfSupply,
        row.taxablePaise,
        row.cgstPaise,
        row.sgstPaise,
        row.igstPaise,
        row.totalPaise,
        row.sacCode,
        row.originalInvoiceNumber,
        row.paymentId,
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
