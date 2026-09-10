/**
 * Release PENDING_TRUST earnings — invoice-fraud guard release valve (#687).
 *
 * Promotes both OrganizationEarnings AND ConsultantEarnings rows (#687 E-02)
 * from PENDING_TRUST → PENDING when the sponsoring org has either:
 *   1. transitioned to status=ACTIVE (admin verification), or
 *   2. paid at least one OrganizationInvoice.
 *
 * Once promoted, the existing release-from-hold path takes over (cron
 * flips PENDING → READY when holdUntil lapses, and the regular payout
 * pipeline runs). This cron only handles the trust gate, not the hold.
 *
 * Schedule: hourly. Cheap walk — there's only ever a handful of rows in
 * PENDING_TRUST since the gate disengages quickly for legit orgs.
 *
 * Designed to be safe to run alongside the existing
 * `release-earnings.ts` cron — they touch disjoint rows (PENDING_TRUST
 * here, PENDING with `holdUntil <= now` there).
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime (e.g. `npx tsx jobs/cleanup/release-pending-trust-earnings.ts`).
// Without dotenv/config, DATABASE_URL is undefined and PrismaClient throws
// on the first query. GitHub Actions workflows load env via repo secrets
// and would still work, but local + emergency manual runs fail — see
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import prisma from "@/lib/prisma";
import { EarningStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

export interface ReleasePendingTrustResult {
  scanned: number;
  released: number;
  errors: string[];
}

// #476 — fail-closed: the CAS updateMany below is the correctness layer; this
// lock is entry-level mutual exclusion for schedule overlap / manual re-runs.
export async function runReleasePendingTrustEarnings(): Promise<ReleasePendingTrustResult> {
  return withCronLock(
    "release-pending-trust-earnings",
    { failMode: "closed" },
    () => runReleasePendingTrustEarningsUnlocked(),
  );
}

async function runReleasePendingTrustEarningsUnlocked(): Promise<ReleasePendingTrustResult> {
  Sentry.logger.info("job:release-pending-trust-earnings started");
  const result: ReleasePendingTrustResult = {
    scanned: 0,
    released: 0,
    errors: [],
  };

  // Step 1: orgs that are now ACTIVE (admin verified them).
  const verifiedOrgIds = (
    await prisma.organization.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    })
  ).map((o) => o.id);

  // Step 2: orgs that have at least one PAID invoice (paid first
  // invoice — that's enough trust to release prior accruals).
  const paidInvoiceOrgs = await prisma.organizationInvoice.findMany({
    where: { status: "PAID" },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });
  const paidOrgIds = paidInvoiceOrgs.map((p) => p.organizationId);

  const unlockedOrgIds = Array.from(
    new Set([...verifiedOrgIds, ...paidOrgIds]),
  );

  if (unlockedOrgIds.length === 0) {
    return result;
  }

  // Org rows carry organizationId directly. Consultant rows (#687 E-02) do
  // NOT — the sponsor lives on the Payment, so join through it. Both are
  // parked/released as one booking, so an unlocked sponsor promotes both.
  const [orgCandidates, consultantCandidates] = await Promise.all([
    prisma.organizationEarnings.findMany({
      where: {
        status: EarningStatus.PENDING_TRUST,
        organizationId: { in: unlockedOrgIds },
      },
      select: { id: true },
    }),
    prisma.consultantEarnings.findMany({
      where: {
        status: EarningStatus.PENDING_TRUST,
        payment: { organizationId: { in: unlockedOrgIds } },
      },
      select: { id: true },
    }),
  ]);
  result.scanned = orgCandidates.length + consultantCandidates.length;

  if (result.scanned === 0) {
    return result;
  }

  // CAS on status inside each updateMany so a concurrent refund/hold that
  // moved a row out of PENDING_TRUST between the scan and the write is not
  // clobbered back to PENDING.
  try {
    if (orgCandidates.length > 0) {
      const orgUpdate = await prisma.organizationEarnings.updateMany({
        where: {
          id: { in: orgCandidates.map((c) => c.id) },
          status: EarningStatus.PENDING_TRUST,
        },
        data: { status: EarningStatus.PENDING },
      });
      result.released += orgUpdate.count;
    }
    if (consultantCandidates.length > 0) {
      const consultantUpdate = await prisma.consultantEarnings.updateMany({
        where: {
          id: { in: consultantCandidates.map((c) => c.id) },
          status: EarningStatus.PENDING_TRUST,
        },
        data: { status: EarningStatus.PENDING },
      });
      result.released += consultantUpdate.count;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "release-pending-trust-earnings" },
    });
  }

  console.log(
    `[release-pending-trust-earnings] scanned=${result.scanned} released=${result.released} errors=${result.errors.length}`,
  );
  Sentry.logger.info("job:release-pending-trust-earnings finished", {
    scanned: result.scanned,
    released: result.released,
    errors: result.errors.length,
  });
  return result;
}

// CLI entry — `npx tsx jobs/cleanup/release-pending-trust-earnings.ts`
if (require.main === module) {
  runJob("release-pending-trust-earnings", async () => {
    await abortIfMaintenance("release-pending-trust-earnings");
    try {
      const r = await runReleasePendingTrustEarnings();
      if (r.errors.length > 0) process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  });
}
