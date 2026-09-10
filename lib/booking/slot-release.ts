import prisma from "@/lib/prisma";
import { transitionSlotCompletion } from "@/lib/booking/transitions";

/**
 * Slot transitions from the sweeps run in bounded transactions. The helper
 * writes the status and then one history row per moved slot, so a whole
 * cohort in one transaction (up to 5,000 rows for the tentative cleanup)
 * would outlive Prisma's default 5 s timeout, roll back, and report zero;
 * the holds would then sit there for every later run to fail on again.
 */
export const SLOT_TRANSITION_CHUNK = 200;
export const SLOT_TRANSITION_TX_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

type SlotTransitionArgs = Parameters<typeof transitionSlotCompletion>[1];

export function chunk<T>(
  items: readonly T[],
  size: number = SLOT_TRANSITION_CHUNK,
): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Runs `transitionSlotCompletion` once per chunk of ids, each chunk in its own
 * transaction, and returns the total moved. `build` must re-state every guard
 * the cohort read used (rule 1: the WHERE is the state machine) and scope the
 * status through `fromIn`, never through `where.completionStatus`.
 */
export async function transitionSlotsInChunks(
  ids: readonly string[],
  build: (idChunk: string[]) => SlotTransitionArgs,
  size: number = SLOT_TRANSITION_CHUNK,
): Promise<number> {
  let moved = 0;
  for (const idChunk of chunk(ids, size)) {
    moved += await prisma.$transaction(
      (tx) => transitionSlotCompletion(tx, build(idChunk)),
      SLOT_TRANSITION_TX_OPTIONS,
    );
  }
  return moved;
}
