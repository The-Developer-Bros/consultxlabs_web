/**
 * Auto-Complete Appointments Job (GitHub Actions Wrapper)
 *
 * Thin wrapper around scripts/auto-complete-appointments.ts
 * Adds GitHub Actions-specific outputs and error handling.
 *
 * Runs hourly via scheduled workflow.
 */

import {
  autoCompleteAppointments,
  disconnectDatabase,
  type AutoCompleteResult,
} from "../../scripts/appointments/auto-complete-appointments";
import fs from "fs";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

/**
 * Output results to GitHub Actions
 */
function outputToGitHubActions(result: AutoCompleteResult): void {
  if (!process.env.GITHUB_ACTIONS) return;

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const outputs = [
      `webinars_completed=${result.webinarsCompleted}`,
      `classes_completed=${result.classesCompleted}`,
      `consultations_completed=${result.consultationsCompleted}`,
      `subscriptions_completed=${result.subscriptionsCompleted}`,
      `success=${result.success}`,
    ].join("\n");

    fs.appendFileSync(outputFile, outputs + "\n");
  }

  const total =
    result.webinarsCompleted +
    result.classesCompleted +
    result.consultationsCompleted +
    result.subscriptionsCompleted;
  if (total > 0) {
    console.log(
      `::notice::Auto-completed ${total} appointments (${result.webinarsCompleted} webinars, ${result.classesCompleted} classes, ${result.consultationsCompleted} consultations, ${result.subscriptionsCompleted} subscriptions)`,
    );
  }

  if (!result.success) {
    console.log(
      `::warning::Auto-complete had errors: ${result.errors.join("; ")}`,
    );
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  await abortIfMaintenance("auto-complete-appointments");
  Sentry.logger.info("job:auto-complete-appointments started");
  console.log("⏰ Starting auto-complete appointments job...");
  console.log(`Timestamp: ${new Date().toISOString()}`);

  try {
    const result = await autoCompleteAppointments();

    console.log("\n📊 Job Results:");
    console.log(`   Webinars Completed: ${result.webinarsCompleted}`);
    console.log(`   Classes Completed: ${result.classesCompleted}`);
    console.log(`   Consultations Completed: ${result.consultationsCompleted}`);
    console.log(`   Subscriptions Completed: ${result.subscriptionsCompleted}`);
    console.log(`   Success: ${result.success}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️ Errors:");
      result.errors.forEach((e) => console.log(`   - ${e}`));
    }

    outputToGitHubActions(result);

    Sentry.logger.info("job:auto-complete-appointments finished", {
      webinarsCompleted: result.webinarsCompleted,
      classesCompleted: result.classesCompleted,
      consultationsCompleted: result.consultationsCompleted,
      subscriptionsCompleted: result.subscriptionsCompleted,
    });

    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

runJob("auto-complete-appointments", main);
