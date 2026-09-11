/**
 * Outward-supplies register export (#1370) — the monthly GSTR-1 working file.
 *
 * Runs on the 3rd of each month for the previous IST calendar month, ahead of
 * the 11th filing deadline. Three things happen, in order:
 *
 *   1. A healer mints the consumer tax invoice for any SUCCEEDED payment in
 *      the period that never got one, because a mint is deliberately allowed
 *      to fail silently at checkout rather than roll back a confirmed booking.
 *   2. Every invoice and credit note issued in the period, B2B and B2C, is
 *      read and shaped into one register, and the CSV is written to disk for
 *      the workflow to upload as an artifact.
 *   3. The reported documents are stamped with `gstr1ExportedAt` so a re-run
 *      does not re-stamp them. The CSV is always a full-period snapshot, so
 *      the stamp is a reporting marker, never a filter on what gets exported.
 *
 * The output carries no PAN, no bank detail and no buyer address — only what
 * a GSTR-1 line needs.
 */

import fs from "node:fs";

import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import {
  buildOutwardRegister,
  buildOutwardRegisterCsv,
  type OutwardRegisterRow,
} from "@/lib/compliance/gst-outward-register";
import { mintConsumerInvoice } from "@/lib/payments/billing/consumer-invoice";
import {
  previousIstCalendarMonthStart,
  nextMonthStart,
  parseIsoDateOverride,
} from "@/lib/compliance/ist-period";

/** Statuses that mean the org invoice was never actually issued to a buyer, so
 *  it is not an outward supply for the period. */
const UNISSUED_ORG_INVOICE_STATUSES = ["DRAFT", "VOID", "CANCELLED"] as const;

function resolvePeriod(): { periodStart: Date; periodEnd: Date } {
  const startRaw = process.env.GST_REGISTER_PERIOD_START;
  const endRaw = process.env.GST_REGISTER_PERIOD_END;
  if (startRaw && endRaw) {
    const periodStart = parseIsoDateOverride(
      startRaw,
      "GST_REGISTER_PERIOD_START",
    );
    const periodEnd = parseIsoDateOverride(endRaw, "GST_REGISTER_PERIOD_END");
    if (periodEnd <= periodStart) {
      throw new RangeError(
        "GST_REGISTER_PERIOD_END must be after GST_REGISTER_PERIOD_START",
      );
    }
    return { periodStart, periodEnd };
  }
  if (startRaw || endRaw) {
    throw new TypeError(
      "GST_REGISTER_PERIOD_START and GST_REGISTER_PERIOD_END must be set together",
    );
  }
  // Default: the previous calendar month, reckoned in IST. Shared with the
  // GSTR-8 draft export so the two never drift apart on the boundary.
  const periodStart = previousIstCalendarMonthStart();
  return { periodStart, periodEnd: nextMonthStart(periodStart) };
}

/**
 * Mint the consumer invoice for every SUCCEEDED, non-deleted payment in the
 * period that still has none. Each mint runs in its own short transaction so
 * one unmintable payment cannot abort the rest of the sweep.
 */
async function ensureConsumerInvoicesForPeriod(
  periodStart: Date,
  periodEnd: Date,
): Promise<{ minted: number; skipped: number }> {
  const candidates = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      createdAt: { gte: periodStart, lt: periodEnd },
      consumerInvoice: null,
    },
    select: { id: true },
  });

  let minted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const result = await prisma.$transaction((tx) =>
      mintConsumerInvoice(tx, { paymentId: candidate.id }),
    );
    if (result.consumerInvoiceId) minted += 1;
    else skipped += 1;
  }
  return { minted, skipped };
}

async function collectRows(
  periodStart: Date,
  periodEnd: Date,
): Promise<OutwardRegisterRow[]> {
  const [consumerInvoices, orgInvoices, consumerCreditNotes, orgCreditNotes] =
    await Promise.all([
      prisma.consumerInvoice.findMany({
        where: { issuedAt: { gte: periodStart, lt: periodEnd } },
        select: {
          invoiceNumber: true,
          issuedAt: true,
          placeOfSupply: true,
          taxableValuePaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          sacCode: true,
          paymentId: true,
          needsBuyerAddress: true,
        },
        orderBy: { issuedAt: "asc" },
      }),
      prisma.organizationInvoice.findMany({
        where: {
          issuedAt: { gte: periodStart, lt: periodEnd },
          status: { notIn: [...UNISSUED_ORG_INVOICE_STATUSES] },
        },
        select: {
          invoiceNumber: true,
          issuedAt: true,
          placeOfSupply: true,
          gstin: true,
          subtotalPaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          hsnCode: true,
          paymentId: true,
        },
        orderBy: { issuedAt: "asc" },
      }),
      prisma.consumerCreditNote.findMany({
        where: { issuedAt: { gte: periodStart, lt: periodEnd } },
        select: {
          creditNoteNumber: true,
          issuedAt: true,
          taxableValuePaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          consumerInvoice: {
            select: {
              invoiceNumber: true,
              placeOfSupply: true,
              sacCode: true,
              paymentId: true,
              needsBuyerAddress: true,
            },
          },
        },
        orderBy: { issuedAt: "asc" },
      }),
      prisma.creditNote.findMany({
        where: {
          status: "ISSUED",
          issuedAt: { gte: periodStart, lt: periodEnd },
        },
        select: {
          creditNoteNumber: true,
          issuedAt: true,
          subtotalPaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          invoice: {
            select: {
              invoiceNumber: true,
              placeOfSupply: true,
              gstin: true,
              hsnCode: true,
              paymentId: true,
            },
          },
        },
        orderBy: { issuedAt: "asc" },
      }),
    ]);

  const rows: OutwardRegisterRow[] = [];

  for (const inv of consumerInvoices) {
    rows.push({
      docType: "INVOICE",
      docNumber: inv.invoiceNumber,
      docDate: inv.issuedAt,
      buyerType: "B2C",
      buyerGstin: null,
      placeOfSupply: inv.placeOfSupply,
      taxablePaise: inv.taxableValuePaise,
      cgstPaise: inv.cgstPaise,
      sgstPaise: inv.sgstPaise,
      igstPaise: inv.igstPaise,
      totalPaise: inv.totalPaise,
      sacCode: inv.sacCode,
      originalInvoiceNumber: null,
      paymentId: inv.paymentId,
      needsBuyerAddress: inv.needsBuyerAddress,
    });
  }

  for (const inv of orgInvoices) {
    rows.push({
      docType: "INVOICE",
      docNumber: inv.invoiceNumber,
      // An issued invoice always carries `issuedAt`; the column is nullable
      // only because DRAFT rows exist, and those are filtered out above.
      docDate: inv.issuedAt ?? new Date(0),
      buyerType: "B2B",
      buyerGstin: inv.gstin,
      placeOfSupply: inv.placeOfSupply,
      taxablePaise: inv.subtotalPaise,
      cgstPaise: inv.cgstPaise,
      sgstPaise: inv.sgstPaise,
      igstPaise: inv.igstPaise,
      totalPaise: inv.totalPaise,
      sacCode: inv.hsnCode,
      originalInvoiceNumber: null,
      paymentId: inv.paymentId,
      needsBuyerAddress: false,
    });
  }

  for (const note of consumerCreditNotes) {
    rows.push({
      docType: "CREDIT_NOTE",
      docNumber: note.creditNoteNumber,
      docDate: note.issuedAt,
      buyerType: "B2C",
      buyerGstin: null,
      placeOfSupply: note.consumerInvoice.placeOfSupply,
      taxablePaise: note.taxableValuePaise,
      cgstPaise: note.cgstPaise,
      sgstPaise: note.sgstPaise,
      igstPaise: note.igstPaise,
      totalPaise: note.totalPaise,
      sacCode: note.consumerInvoice.sacCode,
      originalInvoiceNumber: note.consumerInvoice.invoiceNumber,
      paymentId: note.consumerInvoice.paymentId,
      needsBuyerAddress: note.consumerInvoice.needsBuyerAddress,
    });
  }

  for (const note of orgCreditNotes) {
    rows.push({
      docType: "CREDIT_NOTE",
      docNumber: note.creditNoteNumber,
      docDate: note.issuedAt ?? new Date(0),
      buyerType: "B2B",
      buyerGstin: note.invoice?.gstin ?? null,
      placeOfSupply: note.invoice?.placeOfSupply ?? null,
      taxablePaise: note.subtotalPaise,
      cgstPaise: note.cgstPaise,
      sgstPaise: note.sgstPaise,
      igstPaise: note.igstPaise,
      totalPaise: note.totalPaise,
      sacCode: note.invoice?.hsnCode ?? "999293",
      originalInvoiceNumber: note.invoice?.invoiceNumber ?? null,
      paymentId: note.invoice?.paymentId ?? null,
      needsBuyerAddress: false,
    });
  }

  return rows;
}

export interface GstOutwardRegisterExportResult {
  success: boolean;
  period: string;
  csvPath: string | null;
  mintedByHealer: number;
  skippedByHealer: number;
  documentCount: number;
  warnings: number;
}

/**
 * The whole export, callable from either entry point (#1370).
 *
 * The GitHub Actions wrapper below and the CRON_SECRET HTTP twin at
 * `app/api/cleanup/gst-outward-register-export` share this one body, so the
 * healer, the stamp transaction and — critically — the fail-closed lock cannot
 * drift between them.
 *
 * @param opts.writeCsv The Actions run writes the file for the artifact upload.
 *   The HTTP twin has nowhere to put it (a serverless filesystem is read-only
 *   and nothing would collect it), so it healstamps and reports without writing.
 */
export async function runGstOutwardRegisterExport(
  opts: { writeCsv?: boolean } = {},
): Promise<GstOutwardRegisterExportResult> {
  const writeCsv = opts.writeCsv ?? true;
  // Fail-CLOSED, unlike the read-only compliance drafts. The healer inside
  // allocates numbers from a gapless statutory series, and two concurrent
  // runs would both probe a payment as un-invoiced, both take a number, and
  // one would lose the unique — leaving a permanent gap in the series. Not
  // producing the register is recoverable; a gap is not.
  return await withCronLock(
    "gst-outward-register-export",
    { failMode: "closed" },
    async () => {
      const { periodStart, periodEnd } = resolvePeriod();

      const healed = await ensureConsumerInvoicesForPeriod(
        periodStart,
        periodEnd,
      );
      if (healed.minted > 0) {
        console.warn(
          `[gst-register] WARN minted ${healed.minted} consumer invoice(s) that checkout did not — ` +
            `investigate the mint path if this count stays non-zero.`,
        );
        Sentry.logger.warn("job:gst-register-healed-invoices", {
          minted: healed.minted,
        });
      }

      const rows = await collectRows(periodStart, periodEnd);
      const register = buildOutwardRegister(rows, periodStart, periodEnd);

      let outPath: string | null = null;
      if (writeCsv) {
        outPath =
          process.env.GST_REGISTER_CSV_OUT ?? "gst-outward-register.csv";
        fs.writeFileSync(
          outPath,
          buildOutwardRegisterCsv(register.rows),
          "utf8",
        );
      }

      for (const warning of register.warnings) {
        console.warn(`[gst-register] WARN ${warning}`);
      }
      if (register.warnings.length > 0) {
        Sentry.logger.warn("job:gst-register-warnings", {
          period: register.periodLabel,
          count: register.warnings.length,
        });
      }

      // Stamp what was reported, in one transaction, guarded on the stamp being
      // null — so a second run in the same month reports the same documents
      // again without moving anyone's first-reported timestamp.
      const stampedAt = new Date();
      const periodWindow = { gte: periodStart, lt: periodEnd };
      await prisma.$transaction([
        prisma.consumerInvoice.updateMany({
          where: { issuedAt: periodWindow, gstr1ExportedAt: null },
          data: { gstr1ExportedAt: stampedAt },
        }),
        prisma.organizationInvoice.updateMany({
          where: {
            issuedAt: periodWindow,
            status: { notIn: [...UNISSUED_ORG_INVOICE_STATUSES] },
            gstr1ExportedAt: null,
          },
          data: { gstr1ExportedAt: stampedAt },
        }),
        prisma.consumerCreditNote.updateMany({
          where: { issuedAt: periodWindow, gstr1ExportedAt: null },
          data: { gstr1ExportedAt: stampedAt },
        }),
        prisma.creditNote.updateMany({
          where: {
            status: "ISSUED",
            issuedAt: periodWindow,
            gstr1ExportedAt: null,
          },
          data: { gstr1ExportedAt: stampedAt },
        }),
      ]);

      // One summary line, no PII: counts and totals only.
      console.log(
        JSON.stringify({
          event: "gst_outward_register_exported",
          period: register.periodLabel,
          csvPath: outPath,
          mintedByHealer: healed.minted,
          skippedByHealer: healed.skipped,
          ...register.totals,
          warnings: register.warnings.length,
        }),
      );

      return {
        success: true,
        period: register.periodLabel,
        csvPath: outPath,
        mintedByHealer: healed.minted,
        skippedByHealer: healed.skipped,
        documentCount: register.totals.documentCount,
        warnings: register.warnings.length,
      };
    },
  );
}

// Direct execution is the GitHub Actions entry point; the HTTP twin imports the
// core above, so this must never run on import.
if (require.main === module) {
  runJob("gst-outward-register-export", async () => {
    await abortIfMaintenance("gst-outward-register-export");
    await runGstOutwardRegisterExport();
  });
}
