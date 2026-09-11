/**
 * Org Audit Log Retention Cron — Core Logic
 *
 * Implements the dual-window retention policy required by Indian tax
 * + DPDP compliance:
 *
 *   KEEP_7Y  — INVOICE, PAYOUT, WALLET, CONTRACT, CONSENT
 *              (financial + compliance evidence; 5-7y per IT Act §44AA
 *              + DPDP §12 evidence-of-erasure rule)
 *
 *   KEEP_2Y  — MEMBER, SETTINGS, CATALOG, SYSTEM, PROGRAM, WEBHOOK
 *              (operational records that lose forensic value past 24m)
 *
 * Why a delete cron rather than a TTL column
 * ------------------------------------------
 * Postgres doesn't have native row-level TTL. We could use partitioning
 * by month, but the volume (audit rows are tiny — a few hundred KB
 * per org per year) doesn't justify that complexity. A nightly
 * cron sweep is plenty.
 *
 * One summary `AUDIT_PRUNED` row is written per org per run so the
 * audit-log itself records the pruning event (deletes-of-deletes
 * stay visible to the operator for at least 2y).
 *
 * Schedule: 03:15 UTC daily (15 min after the Stream retention sweep).
 */

import prisma from "../../lib/prisma";
import type { OrgAuditCategory } from "@prisma/client";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

const KEEP_7Y_CATEGORIES: OrgAuditCategory[] = [
  "INVOICE",
  "PAYOUT",
  "WALLET",
  "CONTRACT",
  "CONSENT",
];

const KEEP_2Y_CATEGORIES: OrgAuditCategory[] = [
  "MEMBER",
  "SETTINGS",
  "CATALOG",
  "SYSTEM",
  "PROGRAM",
  "WEBHOOK",
];

export interface AuditPruneResult {
  scanned: number;
  deleted7y: number;
  deleted2y: number;
  cutoff7y: string;
  cutoff2y: string;
  perOrgSummaries: number;
  success: boolean;
  errors: string[];
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function pruneAuditLogs(): Promise<AuditPruneResult> {
  return withCronLock("prune-audit-logs", { failMode: "open" }, () =>
    pruneAuditLogsUnlocked(),
  );
}

async function pruneAuditLogsUnlocked(): Promise<AuditPruneResult> {
  const now = Date.now();
  const ms7y = 7 * 365 * 24 * 60 * 60 * 1000;
  const ms2y = 2 * 365 * 24 * 60 * 60 * 1000;
  const cutoff7y = new Date(now - ms7y);
  const cutoff2y = new Date(now - ms2y);

  const result: AuditPruneResult = {
    scanned: 0,
    deleted7y: 0,
    deleted2y: 0,
    cutoff7y: cutoff7y.toISOString(),
    cutoff2y: cutoff2y.toISOString(),
    perOrgSummaries: 0,
    success: true,
    errors: [],
  };

  // Cheap pre-scan: which orgs have rows past either cutoff? Skip orgs
  // with zero matches so the per-org loop doesn't waste a transaction.
  const candidates = await prisma.orgAuditLog.groupBy({
    by: ["organizationId"],
    where: {
      OR: [
        {
          category: { in: KEEP_7Y_CATEGORIES },
          createdAt: { lt: cutoff7y },
        },
        {
          category: { in: KEEP_2Y_CATEGORIES },
          createdAt: { lt: cutoff2y },
        },
      ],
    },
    _count: { _all: true },
  });

  result.scanned = candidates.reduce(
    (sum, c) => sum + (c._count._all ?? 0),
    0,
  );

  for (const { organizationId } of candidates) {
    try {
      const { deleted7y, deleted2y } = await prisma.$transaction(
        async (tx) => {
          const d7 = await tx.orgAuditLog.deleteMany({
            where: {
              organizationId,
              category: { in: KEEP_7Y_CATEGORIES },
              createdAt: { lt: cutoff7y },
            },
          });
          const d2 = await tx.orgAuditLog.deleteMany({
            where: {
              organizationId,
              category: { in: KEEP_2Y_CATEGORIES },
              createdAt: { lt: cutoff2y },
            },
          });
          // Summary row outlives both deletes (it's SYSTEM, 2y window)
          // — when the next prune fires, this row stays as long as
          // it's within the 2y window, then gets pruned too.
          if (d7.count + d2.count > 0) {
            await tx.orgAuditLog.create({
              data: {
                organizationId,
                category: "SYSTEM",
                action: AUDIT_ACTIONS.SYSTEM.AUDIT_PRUNED,
                description: `Pruned ${d7.count + d2.count} audit rows past retention`,
                details: {
                  deleted7y: d7.count,
                  deleted2y: d2.count,
                  cutoff7y: cutoff7y.toISOString(),
                  cutoff2y: cutoff2y.toISOString(),
                },
              },
            });
            result.perOrgSummaries += 1;
          }
          return { deleted7y: d7.count, deleted2y: d2.count };
        },
      );
      result.deleted7y += deleted7y;
      result.deleted2y += deleted2y;
    } catch (err) {
      result.success = false;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`org=${organizationId}: ${msg}`);
    }
  }

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
