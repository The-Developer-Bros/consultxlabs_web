/**
 * #705 — a strict per-thread order for SupportMessage.
 *
 * `createdAt` alone cannot order this table. The user's turn and the bot's
 * reply are written inside ONE transaction, and Postgres CURRENT_TIMESTAMP is
 * transaction START time, so both rows can carry a byte-identical timestamp;
 * `ORDER BY "createdAt"` then falls to whatever the planner returns and the
 * answer can render above the question. Adding `id` as a tiebreak only makes
 * that deterministic, not correct — the id is a random uuid, so it would put
 * the reply first about half the time.
 *
 * The counter lives on the thread row, which every message write already
 * touches to bump `lastMessageAt`, so the lock it takes is free and is exactly
 * the serialization point between a user typing on their phone and an agent
 * replying on desktop.
 */

import type { Prisma } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

/** Ordering every SupportMessage read must use. Legacy rows sit at seq 0 and
 *  sort first, which is chronologically right — they all predate the counter. */
export const MESSAGE_ORDER = [
  { seq: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
] satisfies Prisma.SupportMessageOrderByWithRelationInput[];

/**
 * Reserve `count` consecutive sequence numbers on a thread. Returns the value
 * BEFORE the block, so the reserved numbers are `base + 1 … base + count`.
 * Must run inside the transaction that writes the messages.
 */
export async function allocateMessageSeq(
  tx: Tx,
  threadId: string,
  count: number,
): Promise<number> {
  if (count <= 0) {
    const row = await tx.appointmentSupportThread.findUniqueOrThrow({
      where: { id: threadId },
      select: { messageSeq: true },
    });
    return row.messageSeq;
  }
  const { messageSeq } = await tx.appointmentSupportThread.update({
    where: { id: threadId },
    data: { messageSeq: { increment: count } },
    select: { messageSeq: true },
  });
  return messageSeq - count;
}
