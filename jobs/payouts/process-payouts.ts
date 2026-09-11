/**
 * Process Payouts Job (GitHub Actions Version)
 *
 * #850/#620 — drives the canonical `lib/payments/payouts` service (the
 * standalone scripts/payouts copy is deleted). Compared to the old script
 * path this job now applies TDS withholding (194-O via compliance/tds) and
 * takes the `lock:payout_processing` Redis lock — both deliberate (#850).
 *
 * Adds GitHub Actions-specific outputs and error handling.
 * Runs weekly on Mondays at 9:00 PM UTC (2:30 AM IST next day).
 */

import prisma from "../../lib/prisma";
import { PayoutStatus } from "@prisma/client";
import {
  PAYOUT_CONSTANTS,
  processApprovedPayouts,
  processPendingOrgPayouts,
  type PayoutResult,
} from "../../lib/payments/payouts";

import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

interface JobSummary {
  processed: number;
  succeeded: number;
  failed: number;
  /** Org-payout advancement errors — kept separate from `failed` (which
   * counts consultant disbursements) so success=false is always explained
   * by failed>0 or org_errors>0, never a bare flag. */
  orgErrors: number;
  success: boolean;
  errors: string[];
}

/**
 * Map the service's PayoutResult[] onto the job's historical summary shape.
 * Skipped payouts (claimed by a concurrent run, #776) belong to that run —
 * they count neither as processed nor failed here.
 */
function summarize(results: PayoutResult[]): JobSummary {
  const counted = results.filter((r) => !r.skipped);
  const succeeded = counted.filter((r) => r.success).length;
  const failed = counted.length - succeeded;
  return {
    processed: counted.length,
    succeeded,
    failed,
    orgErrors: 0,
    success: failed === 0,
    errors: counted
      .filter((r) => !r.success && r.error)
      .map((r) => `Payout ${r.payoutId}: ${r.error}`),
  };
}

/**
 * Output results to GitHub Actions using environment files
 */
function outputToGitHubActions(result: JobSummary): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `processed=${result.processed}`,
      `succeeded=${result.succeeded}`,
      `failed=${result.failed}`,
      `org_errors=${result.orgErrors}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  if (!result.success) {
    const allErrors = result.errors.join("; ");
    console.log(
      `::error::Process payouts job completed with errors: ${allErrors}`,
    );
  }
}

/**
 * Entry point for GitHub Actions
 */
async function main(): Promise<void> {
  await abortIfMaintenance("process-payouts");
  Sentry.logger.info("job:process-payouts started");
  const startTime = Date.now();
  console.log(
    `🚀 Starting payout processing job at ${new Date().toISOString()}`,
  );

  try {
    // Consultant payouts via the canonical service (TDS + Redis lock + CAS).
    const results = await processApprovedPayouts();
    const result = summarize(results);

    // Silent-skip guard: the service returns [] when the Redis lock is held
    // OR Redis is down (acquireLock → null). A green run that disbursed
    // nothing while APPROVED payouts are waiting is how a money job dies
    // quietly — surface it as a failure instead.
    if (results.length === 0) {
      const waiting = await prisma.consultantPayout.count({
        where: {
          status: PayoutStatus.APPROVED,
          retryCount: { lt: PAYOUT_CONSTANTS.MAX_RETRY_ATTEMPTS },
        },
      });
      if (waiting > 0) {
        console.log(
          `::error::Payout run processed nothing but ${waiting} APPROVED payout(s) are waiting — Redis lock held or Redis down. Investigate before the next weekly run.`,
        );
        result.success = false;
        result.errors.push(
          `${waiting} APPROVED payouts waiting; processing lock unavailable`,
        );
      }
    }

    // Org payouts (PENDING → PROCESSING advancement; gateway submission is
    // flag-gated in the service). Non-fatal: org-payout errors are reported
    // but never block consultant disbursement reporting.
    const orgResult = await processPendingOrgPayouts();
    console.log(
      `\n🏢 Org payouts: scanned ${orgResult.scanned}, advanced ${orgResult.advanced}, errors ${orgResult.errors.length}`,
    );
    if (orgResult.errors.length > 0) {
      orgResult.errors.forEach((e) => console.warn(`   ⚠️ ${e}`));
      result.errors.push(...orgResult.errors);
      result.orgErrors = orgResult.errors.length;
      result.success = false;
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Summary
    console.log(`\n📊 Processing Summary:`);
    console.log(`   📤 Processed: ${result.processed}`);
    console.log(`   ✅ Succeeded: ${result.succeeded}`);
    console.log(`   ❌ Failed: ${result.failed}`);

    // Output to GitHub Actions
    outputToGitHubActions(result);

    if (result.success) {
      Sentry.logger.info("job:process-payouts finished", { processed: result.processed, succeeded: result.succeeded, failed: result.failed, orgErrors: result.orgErrors });
      console.log("🎉 Payout processing job completed successfully");
    } else {
      console.error("❌ Payout processing job completed with errors");
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run the job
runJob("process-payouts", main);
