/**
 * Ledger Reconciliation Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/reconcile/reconcile-ledgers.ts. The core
 * auditor is pure + read-only so the same function is invoked from:
 *   1. This GitHub Actions cron (scheduled nightly).
 *   2. The admin trigger route at
 *      `POST /api/admin/reconcile-ledgers` when ops wants an on-demand
 *      run (e.g. after a suspected webhook outage).
 *
 * Exit behaviour:
 *   0 — clean report (no discrepancies)
 *   1 — fatal error (auditor threw)
 *   2 — report written but had discrepancies (turns the workflow red so
 *       GitHub alerting can page ops)
 */

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { runReconcileLedgers } from "../../scripts/reconcile/reconcile-ledgers";
import prisma from "../../lib/prisma";
import {
  recordSystemEvent,
  recordSystemError,
} from "../../lib/enterprise/system-events";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import { freezeWalletSpend } from "../../lib/payments/wallet-freeze";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

async function main(): Promise<void> {
  await abortIfMaintenance("reconcile-ledgers");
  Sentry.logger.info("job:reconcile-ledgers started");
  console.log("🔎 Starting ledger reconciliation job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const report = await runReconcileLedgers({ scope: "full" });

    console.log("\n📊 Reconciliation Results:");
    console.log(`   Report id:   ${report.id}`);
    console.log(`   Scope:       ${report.scope}`);
    console.log(`   Clean:       ${report.ok}`);
    console.log(`   Duration:    ${report.durationMs}ms`);
    console.log(`   Orgs:        ${report.summary.orgsChecked}`);
    console.log(`   Accounts:    ${report.summary.accountsChecked}`);
    console.log(`   Assignments: ${report.summary.assignmentsChecked}`);
    console.log(
      `   Findings:    ${report.summary.discrepanciesCount}`,
    );

    if (process.env.GITHUB_ACTIONS && process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        [
          `report_id=${report.id}`,
          `clean=${report.ok}`,
          `findings=${report.summary.discrepanciesCount}`,
          `duration_ms=${report.durationMs}`,
        ].join("\n") + "\n",
      );
    }

    if (report.ok) {
      Sentry.logger.info("job:reconcile-ledgers finished", {
        orgsChecked: report.summary.orgsChecked,
        accountsChecked: report.summary.accountsChecked,
        assignmentsChecked: report.summary.assignmentsChecked,
        discrepanciesCount: report.summary.discrepanciesCount,
      });
    }

    if (!report.ok) {
      console.log("\n⚠️  Discrepancies:");
      for (const f of report.findings) {
        console.log(`   · ${f.kind}: ${JSON.stringify(f)}`);
      }
      console.log(
        `::error::Ledger reconciliation found ${report.summary.discrepanciesCount} discrepancies. Report id: ${report.id}`,
      );
      // #776 §K — surface drift to the telemetry sink, not just CI logs.
      await recordSystemEvent({
        category: "RECONCILE",
        severity: "ERROR",
        message: `Ledger reconciliation found ${report.summary.discrepanciesCount} discrepancies`,
        correlationId: report.id,
        context: {
          reportId: report.id,
          findingsCount: report.summary.discrepanciesCount,
          kinds: Array.from(new Set(report.findings.map((f) => f.kind))),
        },
      });
      Sentry.captureException(
        new Error(
          `Ledger reconciliation: ${report.summary.discrepanciesCount} discrepancies found`,
        ),
        {
          tags: { subsystem: "jobs", job: "reconcile-ledgers" },
          contexts: {
            ledger: {
              reportId: report.id,
              discrepancyCount: report.summary.discrepanciesCount,
            },
          },
        },
      );

      // #837 — a wallet cache/journal drift means the balance can't be trusted,
      // so freeze spend on each drifted account (scoped, not platform-wide) and
      // page P0. Only WALLET_BALANCE_DRIFT freezes; other finding kinds page via
      // the captureException above but don't gate spend.
      const walletDrift = report.findings.filter(
        (f) => f.kind === "WALLET_BALANCE_DRIFT" && f.billingAccountId,
      );
      for (const f of walletDrift) {
        const froze = await freezeWalletSpend({
          billingAccountId: f.billingAccountId!,
          organizationId: f.organizationId ?? null,
          reason: `ledger reconcile ${report.id}: wallet cache ${f.actualPaise}p ≠ journal ${f.expectedPaise}p (Δ${f.deltaPaise}p)`,
        });
        Sentry.captureException(
          new Error(
            `WALLET_BALANCE_DRIFT — wallet spend frozen for billing account ${f.billingAccountId}`,
          ),
          {
            level: "fatal",
            tags: { subsystem: "jobs", job: "reconcile-ledgers" },
            contexts: {
              wallet: {
                billingAccountId: f.billingAccountId,
                organizationId: f.organizationId ?? null,
                // JSON can't serialize BigInt; walletBalance is BigInt at runtime.
                expectedPaise: Number(f.expectedPaise),
                actualPaise: Number(f.actualPaise),
                deltaPaise: Number(f.deltaPaise),
                reportId: report.id,
                newlyFrozen: froze,
              },
            },
          },
        );
      }
      // #837/#1066 — the discrepancy alert + wallet-freeze P0 pages are queued,
      // not sent. Setting the code instead of exiting lets runJob's flush drain
      // them; process.exit() here would drop every one.
      process.exitCode = 2;
      return;
    }
  } catch (error) {
    // #776 §K — a crashed auditor means we're flying blind on money integrity,
    // so it goes to the telemetry sink as well. Everything generic (capture,
    // job tag, step annotation, exit code, lock-held skip) is runJob's. (#1066)
    if (!(error instanceof CronLockHeldError)) {
      await recordSystemError({
        category: "RECONCILE",
        summary: "Ledger reconciliation crashed",
        err: error,
      });
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// A wide drift queues one fatal event PER drifted wallet (see the loop above),
// so the default 5s drain can silently lose the P0 pages this job exists to
// raise. The workflow allows 30 minutes; 30s of it can go to the flush. (#1066)
runJob("reconcile-ledgers", main, { flushTimeoutMs: 30_000 });
