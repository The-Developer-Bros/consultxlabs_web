import type { Tx } from "@/lib/prisma";
/**
 * Per-org invoice numbering — CGST Rule 46 sequential rule.
 *
 * Allocations are atomic per (organizationId, fiscalYear): an
 * INSERT … ON CONFLICT DO UPDATE … RETURNING pattern against the
 * `org_invoice_counters` table reserves the next `nextSeq` even under
 * concurrent invoice creation. The @@unique on (organizationId,
 * invoiceNumber) is the belt; this counter is the suspenders so the
 * belt never has to retry.
 *
 * Format: `<PREFIX>-<FY>-<SEQ>` where SEQ is a 4-digit zero-padded
 * monotonic integer. PREFIX falls back to Organization.slug when
 * Organization.invoiceNumberPrefix is null.
 *
 * Indian fiscal year runs April–March. An invoice issued in April 2026
 * lands in FY 2026; one issued in March 2026 lands in FY 2025.
 */

import type { Prisma } from "@prisma/client";

/**
 * CGST Rule 46(b): a tax-invoice number may not exceed sixteen characters.
 * Rule 53 imposes the same limit on credit notes. #789 — the prior code
 * concatenated the org prefix without bound, so `<PREFIX>-CN-<FY>-<SEQ>`
 * overflowed sixteen characters for any prefix longer than three (e.g.
 * `WIPRO-CN-2026-0001` = 18 chars, a live Rule 53 breach).
 */
export const GST_DOC_NUMBER_MAX_LEN = 16;

/**
 * Cap an org prefix so the whole document number fits within
 * {@link GST_DOC_NUMBER_MAX_LEN}. `nonPrefixLength` is the length of every
 * character the format contributes around the prefix (separators, the fiscal
 * year, and the zero-padded sequence), so the budget shrinks automatically if
 * a sequence ever grows past four digits. The truncation is deterministic, and
 * within-org uniqueness still rests on the sequence, so a shortened prefix
 * never collides with another number for the same organization.
 */
export function fitPrefixToRule46(
  prefix: string,
  nonPrefixLength: number,
): string {
  const budget = GST_DOC_NUMBER_MAX_LEN - nonPrefixLength;
  // The non-prefix segments already fit comfortably for both our formats, so
  // the budget is always positive. If it were ever zero or negative we drop the
  // prefix entirely rather than keep one character, which would push the total
  // back over the 16-character cap (#789 review).
  return budget >= 1 ? prefix.slice(0, budget) : "";
}

export function indianFiscalYear(d: Date): number {
  // #776 — the Indian FY (Apr–Mar) is reckoned in IST, not UTC. An invoice issued
  // just after midnight IST on Apr 1 (before 05:30 IST) is still Mar 31 in UTC;
  // computing the FY in UTC would file it under the previous FY and desync the
  // invoice number's FY from its IST issue date (CGST Rule 46 sequential breach).
  // Shift into IST (UTC+5:30) before extracting year/month.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth(); // Jan=0, Apr=3
  return m >= 3 ? y : y - 1;
}

/**
 * Atomically reserve the next sequence number for (orgId, fiscalYear).
 * Caller must be inside a Prisma $transaction.
 */
export async function allocateOrgInvoiceSeq(
  tx: Tx,
  organizationId: string,
  fiscalYear: number,
): Promise<number> {
  // ORM upsert (no raw SQL), same atomic pattern as allocateOrgCreditNoteSeq:
  // create seeds nextSeq=2 and allocates seq 1; the update path increments and we
  // return the pre-increment value (nextSeq-1). The increment is a single DB-level
  // op and the compound @@id/ON CONFLICT serialises concurrent allocations.
  const counter = await tx.orgInvoiceCounter.upsert({
    where: { organizationId_fiscalYear: { organizationId, fiscalYear } },
    create: { organizationId, fiscalYear, nextSeq: 2 },
    update: { nextSeq: { increment: 1 } },
    select: { nextSeq: true },
  });
  return counter.nextSeq - 1;
}

export interface OrgInvoiceNumberInput {
  id: string;
  slug: string;
  invoiceNumberPrefix: string | null;
}

export async function generateOrgInvoiceNumber(
  tx: Tx,
  org: OrgInvoiceNumberInput,
  issuedAt: Date,
): Promise<{ invoiceNumber: string; fiscalYear: number; seq: number }> {
  const fiscalYear = indianFiscalYear(issuedAt);
  const seq = await allocateOrgInvoiceSeq(tx, org.id, fiscalYear);
  const padded = seq.toString().padStart(4, "0");
  // `<PREFIX>-<FY>-<SEQ>`: two separators + the fiscal year + the sequence sit
  // around the prefix.
  const nonPrefixLength = 2 + String(fiscalYear).length + padded.length;
  const prefix = fitPrefixToRule46(
    (org.invoiceNumberPrefix ?? org.slug).toUpperCase(),
    nonPrefixLength,
  );
  return {
    invoiceNumber: `${prefix}-${fiscalYear}-${padded}`,
    fiscalYear,
    seq,
  };
}

// ============================================================================
// Platform (B2C) invoice numbering — #1365
// ============================================================================

/**
 * The platform-wide invoice prefix for consumer tax invoices. One series
 * serves every B2C buyer, so unlike the org series there is no per-tenant
 * prefix to fall back to; `PLATFORM_INVOICE_PREFIX` lets finance rename the
 * series without a deploy, and "FAM" is the default.
 */
function platformPrefix(nonPrefixLength: number): string {
  return fitPrefixToRule46(
    (process.env.PLATFORM_INVOICE_PREFIX ?? "FAM").toUpperCase(),
    nonPrefixLength,
  );
}

/**
 * Atomically reserve the next platform invoice sequence for a fiscal year.
 * Same shape as {@link allocateOrgInvoiceSeq}: the create path seeds
 * `nextSeq = 2` and allocates 1, the update path increments and allocates the
 * pre-increment value. Caller must be inside a Prisma $transaction.
 */
export async function allocatePlatformInvoiceSeq(
  tx: Tx,
  fiscalYear: number,
): Promise<number> {
  const counter = await tx.platformInvoiceCounter.upsert({
    where: { fiscalYear },
    create: { fiscalYear, nextSeq: 2 },
    update: { nextSeq: { increment: 1 } },
    select: { nextSeq: true },
  });
  return counter.nextSeq - 1;
}

/**
 * Generate the next consumer tax-invoice number: `<PREFIX>-<FY>-<SEQ5>`.
 *
 * Five sequence digits (99,999 invoices per fiscal year) because one series
 * covers every consumer supply on the platform, not one buyer's. Two
 * separators plus the four-digit fiscal year plus five digits is eleven
 * characters, leaving five for the prefix inside the Rule 46(b) sixteen.
 */
export async function generateConsumerInvoiceNumber(
  tx: Tx,
  issuedAt: Date,
): Promise<{ invoiceNumber: string; fiscalYear: number; seq: number }> {
  const fiscalYear = indianFiscalYear(issuedAt);
  const seq = await allocatePlatformInvoiceSeq(tx, fiscalYear);
  const padded = seq.toString().padStart(5, "0");
  const nonPrefixLength = 2 + String(fiscalYear).length + padded.length;
  return {
    invoiceNumber: `${platformPrefix(nonPrefixLength)}-${fiscalYear}-${padded}`,
    fiscalYear,
    seq,
  };
}
