import type { Tx } from "@/lib/prisma";
/**
 * BillingSubscription.activeSeatCount writer.
 *
 * `activeSeatCount` is the per-contract aggregate of LICENSED_SEAT
 * ProgramAssignments currently in-period. It is read by the
 * subscription-invoice cron (`jobs/billing/generate-subscription-invoices.ts`)
 * to compute `× N seats` line items on PER_SEAT subscriptions.
 *
 * Atomicity: same conditional-UPDATE pattern as `walletDebit` —
 * a raw SQL `UPDATE ... SET activeSeatCount = activeSeatCount + delta`
 * gated on `activeSeatCount + delta >= 0` so we cannot underflow under
 * concurrent decrement. If two callers race a +1, both succeed; if two
 * race a -1 against a count of 1, exactly one wins (the other throws).
 *
 * Why per-contract and not per-program: `BillingSubscription` is keyed by
 * `contractId @unique`. A contract may bundle multiple LICENSED_SEAT
 * programs (e.g. an org with both a Manager seat-pool and a Learner
 * seat-pool on one master contract). The invoice line-item is the sum
 * across all such programs in that contract — so the write must aggregate
 * at the subscription level, not the program level.
 *
 * Callers must pass the `programId` so we can resolve the right
 * subscription. Non-LICENSED_SEAT programs are no-ops (we still resolve
 * the subscription to validate the program/contract pair, but skip the
 * UPDATE — keeping the call site uniform between program types).
 */

import type { Prisma } from "@prisma/client";

export class SeatCountUnderflowError extends Error {
  constructor(public billingSubscriptionId: string) {
    super(
      `Cannot decrement activeSeatCount below zero on subscription ${billingSubscriptionId}`,
    );
    this.name = "SeatCountUnderflowError";
  }
}

/**
 * Adjust `BillingSubscription.activeSeatCount` by `delta` (signed) for the
 * subscription that owns this LICENSED_SEAT program. Idempotency is the
 * caller's responsibility — the helper just applies the delta. Call once
 * per assignment lifecycle event.
 *
 * No-op if the program is not LICENSED_SEAT or has no associated
 * subscription (e.g. CREDIT_POOL programs, or unbundled contracts).
 */
export async function adjustActiveSeatCount(
  tx: Tx,
  params: {
    programId: string;
    delta: number; // +1 on assignment, -1 on un-assignment
  },
): Promise<{ applied: boolean; balanceAfter: number | null }> {
  if (params.delta === 0) return { applied: false, balanceAfter: null };

  const program = await tx.program.findUnique({
    where: { id: params.programId },
    select: {
      type: true,
      contract: {
        select: {
          subscription: { select: { id: true, activeSeatCount: true } },
        },
      },
    },
  });

  if (!program || program.type !== "LICENSED_SEAT") {
    return { applied: false, balanceAfter: null };
  }
  const sub = program.contract.subscription;
  if (!sub) {
    return { applied: false, balanceAfter: null };
  }

  // Atomic conditional update via the ORM (no raw SQL): same overdraft-guard
  // pattern as walletDebit. For a decrement, updateMany only matches when the
  // current count is large enough to stay non-negative (count >= -delta), so
  // concurrent releases can't underflow.
  if (params.delta < 0) {
    const updated = await tx.billingSubscription.updateMany({
      where: { id: sub.id, activeSeatCount: { gte: -params.delta } },
      data: { activeSeatCount: { increment: params.delta } },
    });
    if (updated.count === 0) {
      throw new SeatCountUnderflowError(sub.id);
    }
  } else {
    await tx.billingSubscription.update({
      where: { id: sub.id },
      data: { activeSeatCount: { increment: params.delta } },
    });
  }

  const after = await tx.billingSubscription.findUniqueOrThrow({
    where: { id: sub.id },
    select: { activeSeatCount: true },
  });
  return { applied: true, balanceAfter: after.activeSeatCount };
}

/**
 * E2E-audit P1 fix — seat-count release for member-lifecycle cascades.
 *
 * The assignment-cancel paths on the assignment routes already decrement the
 * billed seat, but the MEMBER-level cascades (removal via DELETE/PATCH,
 * SCIM deprovision, DPDP erasure) terminated live ProgramAssignments without
 * releasing their seats — a deprovisioned member stayed fully counted against
 * `activeSeatCount` while any future PER_SEAT enablement would bill them.
 * Call AFTER the assignments have been stamped CANCELLED; pass the same
 * membership ids whose assignments were just terminated. Best-effort per
 * program: non-LICENSED_SEAT programs and unlicensed contracts no-op inside
 * `adjustActiveSeatCount`.
 */
export async function releaseSeatsForTerminatedAssignments(
  tx: Tx,
  membershipIds: string[],
): Promise<number> {
  if (membershipIds.length === 0) return 0;

  const now = new Date();
  const terminated = await tx.programAssignment.findMany({
    where: {
      membershipId: { in: membershipIds },
      periodEnd: { gte: now },
      status: "CANCELLED",
    },
    select: { programId: true },
  });

  const seen = new Set<string>();
  for (const assignment of terminated) {
    if (seen.has(assignment.programId)) continue;
    seen.add(assignment.programId);
    try {
      await adjustActiveSeatCount(tx, {
        programId: assignment.programId,
        delta: -1,
      });
    } catch (err) {
      // A concurrent double-release losing the underflow guard is a benign
      // outcome (the count is already correct); anything else propagates.
      if (!(err instanceof SeatCountUnderflowError)) throw err;
    }
  }
  return seen.size;
}
