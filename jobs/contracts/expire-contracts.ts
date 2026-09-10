/**
 * Cron: transition `Contract.status` from `ACTIVE` to `EXPIRED` for any
 * contract whose `effectiveTo` has passed.
 *
 * Schedule: daily at 03:10 UTC / 08:40 IST (`.github/workflows/expire-contracts.yml`, #709 minute map).
 * Quiet slot — does not race with the 00:00 / 01:00 / 02:00 cron clusters.
 *
 * Soft enforcement: contract expiry does NOT take the org offline. The
 * `requireOrgAccess` helper continues to honour the org regardless of
 * contract status — the only effect is:
 *   1. New `OrganizationInvoice` rolls only generate while the contract
 *      is `ACTIVE` (per `jobs/billing/generate-subscription-invoices.ts`).
 *   2. Active `ProgramAssignment` rows are soft-closed (periodEnd = now)
 *      so members stop drawing from program caps, but in-flight bookings
 *      complete normally.
 *   3. The org dashboard renders an "Expired" banner so operators
 *      renew the contract.
 *
 * Idempotent: only flips rows still in `ACTIVE`. Re-running on the same
 * day is a no-op.
 *
 * Usage:
 *   npx tsx jobs/contracts/expire-contracts.ts
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

interface ExpireStats {
  scanned: number;
  expired: number;
  assignmentsClosed: number;
}

export async function runExpireContracts(): Promise<ExpireStats> {
  const stats: ExpireStats = { scanned: 0, expired: 0, assignmentsClosed: 0 };
  const now = new Date();

  // Find every contract still ACTIVE whose effectiveTo is in the past.
  // `effectiveTo` is optional — null means open-ended, which never
  // expires automatically.
  const due = await prisma.contract.findMany({
    where: {
      status: "ACTIVE",
      effectiveTo: { lte: now, not: null },
    },
    select: { id: true, organizationId: true, effectiveTo: true },
  });
  stats.scanned = due.length;

  for (const c of due) {
    // #1132 — 01-concurrency-and-idempotency.md states each nightly lifecycle
    // cron runs Serializable; no isolation level was passed, so this ran at
    // READ COMMITTED. The CAS claim below is the real correctness guard, but
    // the documented behaviour should be true of the code.
    //
    // Raising the isolation level introduces P2034: a concurrent write can
    // abort the transaction, and an unretried abort would throw out of the
    // whole loop and leave every later contract unprocessed until tomorrow.
    // withSerializableRetry retries ONLY P2034, so business rejections still
    // propagate. `claimed` is returned rather than mutating stats inside the
    // callback — a retried callback would otherwise double-count.
    const claimed = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Conditional update — claim the row only if still ACTIVE so two
          // cron replicas don't double-process. Doubles as the distributed
          // lock; loser sees `claim.count === 0` and skips.
          const claim = await tx.contract.updateMany({
            where: { id: c.id, status: "ACTIVE" },
            data: { status: "EXPIRED" },
          });
          if (claim.count === 0)
            return { expired: false, assignmentsClosed: 0 };
          let assignmentsClosed = 0;

          // Soft-close active ProgramAssignments scoped to the contract.
          // `Program.contractId → Contract`, then ProgramAssignment.programId
          // resolves up to the contract. We close the period at `now` rather
          // than deleting so engagementsUsed history + UsageLedgerEntry rows
          // stay queryable for reconciliation.
          const programs = await tx.program.findMany({
            where: { contractId: c.id },
            select: { id: true },
          });
          if (programs.length > 0) {
            const programIds = programs.map((p) => p.id);
            // #779 §A — a contract expiry takes its ACTIVE programs (→ EXPIRED)
            // and their still-ACTIVE assignments (→ CLOSED) with it, so the
            // lifecycle is explicit rather than inferred from periodEnd alone.
            await tx.program.updateMany({
              where: { contractId: c.id, status: "ACTIVE" },
              data: { status: "EXPIRED" },
            });
            // #1132 review — `status: "ACTIVE"` was missing (pre-existing), so
            // an already-CLOSED assignment whose periodEnd is still in the
            // future had its end date rewritten and was counted again in
            // `assignmentsClosed`. The comment above always said "still-ACTIVE
            // assignments"; the query did not say it.
            const closed = await tx.programAssignment.updateMany({
              where: {
                programId: { in: programIds },
                status: "ACTIVE",
                periodEnd: { gte: now },
              },
              data: { periodEnd: now, status: "CLOSED" },
            });
            assignmentsClosed += closed.count;
          }

          await tx.orgAuditLog.create({
            data: {
              organizationId: c.organizationId,
              actorMembershipId: null,
              targetMembershipId: null,
              category: "CONTRACT",
              action: AUDIT_ACTIONS.CONTRACT.CONTRACT_EXPIRED,
              description: `Contract ${c.id} auto-expired (effectiveTo=${c.effectiveTo?.toISOString()})`,
              details: {
                contractId: c.id,
                effectiveTo: c.effectiveTo?.toISOString() ?? null,
              },
            },
          });

          return { expired: true, assignmentsClosed };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (claimed.expired) stats.expired += 1;
    stats.assignmentsClosed += claimed.assignmentsClosed;
  }

  return stats;
}

async function main() {
  await abortIfMaintenance("expire-contracts");
  Sentry.logger.info("job:expire-contracts started");
  console.log(`[expire-contracts] Starting at ${new Date().toISOString()}`);
  // fail-closed since #1169 lists it as financial: expiry withdraws the
  // sponsorship the checkout resolver reads.
  const stats = await withCronLock(
    "expire-contracts",
    { failMode: "closed" },
    () => runExpireContracts(),
  );
  console.log(
    `[expire-contracts] Done. scanned=${stats.scanned} expired=${stats.expired} assignmentsClosed=${stats.assignmentsClosed}`,
  );
  Sentry.logger.info("job:expire-contracts finished", {
    scanned: stats.scanned,
    expired: stats.expired,
    assignmentsClosed: stats.assignmentsClosed,
  });
}

// Only run when invoked directly (allows the function to be imported and
// unit-tested without spinning up the cron entry-point).
if (require.main === module) {
  runJob("expire-contracts", () => main().finally(() => prisma.$disconnect()));
}
