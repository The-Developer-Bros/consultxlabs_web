import type { Tx } from "@/lib/prisma";
/**
 * Per-org credit-note numbering — CGST Rule 53 sequential rule (#776 / #778 §D).
 *
 * Keeps the credit-note series independent of the invoice series, as the GST
 * rules require. Reuses `indianFiscalYear` so a CN issued in March lands in the
 * prior FY, matching the invoice it adjusts.
 *
 * Gapless allocation uses a Prisma `upsert` whose UPDATE increments `nextSeq`
 * atomically (the increment is a single DB-level operation, and the create path
 * is guarded by the compound `@@id`/ON CONFLICT) — no raw SQL needed. We return
 * the pre-increment value (`nextSeq - 1`) as the allocated sequence.
 *
 * Format: `<PREFIX>-CN-<FY>-<SEQ>` — the `CN` segment distinguishes credit
 * notes from invoices (`<PREFIX>-<FY>-<SEQ>`) at a glance and in exports.
 */

import type { Prisma } from "@prisma/client";
import { indianFiscalYear, fitPrefixToRule46 } from "./invoice-numbering";

/**
 * Atomically reserve the next credit-note sequence for (orgId, fiscalYear).
 * Caller must be inside a Prisma $transaction.
 */
export async function allocateOrgCreditNoteSeq(
  tx: Tx,
  organizationId: string,
  fiscalYear: number,
): Promise<number> {
  // create seeds nextSeq=2 and allocates seq 1; update increments and allocates
  // the prior value — equivalent to INSERT…ON CONFLICT…RETURNING (nextSeq-1).
  const counter = await tx.orgCreditNoteCounter.upsert({
    where: { organizationId_fiscalYear: { organizationId, fiscalYear } },
    create: { organizationId, fiscalYear, nextSeq: 2 },
    update: { nextSeq: { increment: 1 } },
    select: { nextSeq: true },
  });
  return counter.nextSeq - 1;
}

export interface OrgCreditNoteNumberInput {
  id: string;
  slug: string;
  invoiceNumberPrefix: string | null;
}

export async function generateOrgCreditNoteNumber(
  tx: Tx,
  org: OrgCreditNoteNumberInput,
  issuedAt: Date,
): Promise<{ creditNoteNumber: string; fiscalYear: number; seq: number }> {
  const fiscalYear = indianFiscalYear(issuedAt);
  const seq = await allocateOrgCreditNoteSeq(tx, org.id, fiscalYear);
  const padded = seq.toString().padStart(4, "0");
  // `<PREFIX>-CN-<FY>-<SEQ>`: the `-CN-` infix plus a separator, the fiscal
  // year, and the sequence sit around the prefix, so the credit-note budget is
  // three characters tighter than the invoice budget. The prefix is capped
  // independently of the invoice; Rule 53 ties a credit note to its invoice by
  // the referenced invoice number in the line items, not by a shared prefix.
  const nonPrefixLength =
    "-CN-".length + String(fiscalYear).length + 1 + padded.length;
  const prefix = fitPrefixToRule46(
    (org.invoiceNumberPrefix ?? org.slug).toUpperCase(),
    nonPrefixLength,
  );
  return {
    creditNoteNumber: `${prefix}-CN-${fiscalYear}-${padded}`,
    fiscalYear,
    seq,
  };
}

// ============================================================================
// Platform (B2C) credit-note numbering — #1365
// ============================================================================

/**
 * Atomically reserve the next platform credit-note sequence for a fiscal year.
 * Rule 53 requires this series to run independently of the invoice series, so
 * it has its own counter table.
 */
export async function allocatePlatformCreditNoteSeq(
  tx: Tx,
  fiscalYear: number,
): Promise<number> {
  const counter = await tx.platformCreditNoteCounter.upsert({
    where: { fiscalYear },
    create: { fiscalYear, nextSeq: 2 },
    update: { nextSeq: { increment: 1 } },
    select: { nextSeq: true },
  });
  return counter.nextSeq - 1;
}

/**
 * Generate the next consumer credit-note number: `<PREFIX>-CN-<FY>-<SEQ4>`.
 *
 * The `-CN-` infix costs three characters against the same sixteen-character
 * Rule 53 cap, so the sequence is four digits: this series can issue 9,999
 * credit notes per fiscal year. That ceiling is well above the refund volume a
 * consumer book of this size produces, and raising it means shortening the
 * prefix, not widening the number.
 */
export async function generateConsumerCreditNoteNumber(
  tx: Tx,
  issuedAt: Date,
): Promise<{ creditNoteNumber: string; fiscalYear: number; seq: number }> {
  const fiscalYear = indianFiscalYear(issuedAt);
  const seq = await allocatePlatformCreditNoteSeq(tx, fiscalYear);
  const padded = seq.toString().padStart(4, "0");
  const nonPrefixLength =
    "-CN-".length + String(fiscalYear).length + 1 + padded.length;
  const prefix = fitPrefixToRule46(
    (process.env.PLATFORM_INVOICE_PREFIX ?? "FAM").toUpperCase(),
    nonPrefixLength,
  );
  return {
    creditNoteNumber: `${prefix}-CN-${fiscalYear}-${padded}`,
    fiscalYear,
    seq,
  };
}
