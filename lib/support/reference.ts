/**
 * #705 — human-readable support ticket references.
 *
 * `SupportTicket.id` is a uuid: unusable in an email subject and impossible to
 * read back over a phone line. The two staff surfaces had each invented their
 * own truncation (one took the first 8 characters, the other the last, so they
 * disagreed about the same ticket) and users were shown no identifier at all.
 *
 * Year-scoped rather than a single lifetime series: a plain counter publishes
 * the all-time ticket count to anyone who files two tickets and subtracts —
 * the German tank problem, which is exactly how the Allies estimated German
 * production from sequential part serial numbers. Resetting each January caps
 * the leak at the current year.
 */

import type { Tx } from "@/lib/prisma";

export const TICKET_REFERENCE_PREFIX = "FAM";

export function formatTicketReference(year: number, seq: number): string {
  return `${TICKET_REFERENCE_PREFIX}-${year}-${String(seq).padStart(6, "0")}`;
}

/**
 * Reserve the next reference. MUST run inside the same transaction that creates
 * the ticket, so a rolled-back ticket never leaves a live reference behind.
 *
 * The upsert compiles to INSERT … ON CONFLICT DO UPDATE … RETURNING: the create
 * path is arbitrated by the primary key (one winner, the losers take the update
 * path) and the update path is an in-place increment holding a row lock, so
 * concurrent allocators queue and each returns a distinct pre-increment value.
 * There is no read-modify-write in application space. `referenceNumber` is also
 * `@unique`, which turns any residual duplicate into a P2002 to retry rather
 * than two tickets quietly sharing a number.
 *
 * Gaps are fine here — a rolled-back ticket burns a number and nothing depends
 * on the series being unbroken. That is the difference from a GST invoice
 * series, where CGST Rule 46 would not allow it.
 */
export async function allocateTicketReference(
  tx: Tx,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const counter = await tx.supportTicketCounter.upsert({
    where: { year },
    create: { year, nextSeq: 2 }, // seeds the row AND allocates seq 1
    update: { nextSeq: { increment: 1 } },
    select: { nextSeq: true },
  });
  return formatTicketReference(year, counter.nextSeq - 1);
}
