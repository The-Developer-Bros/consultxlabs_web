/**
 * Test: Single-Atom Storm
 * Category: 11 - Load and Stress
 *
 * Scenario: 50 consultees hit the same 30-minute slot at the same instant.
 * Expected: Exactly 1 booking, 49 conflicts, 0 errors, and no atom key left
 * behind once the storm drains.
 *
 * The drop-hour case: one slot, everybody at once. Whether a loser is refused
 * by the lock (retries exhausted) or by the booking check it ran under the lock,
 * it must end up with a 409 — never a second booking and never a 500 (#1169).
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  atomKeyExists,
  atomKeys,
  attemptIntervalBooking,
  logAssertions,
  resetIntervalRegistry,
  saveScenarioReports,
  utcInterval,
} from "../../utilities/interval-helpers.js";
import {
  generateConsultantId,
  generateUserId,
} from "../../utilities/fixtures.js";
import type { TestConfig } from "../../utilities/types.js";

const CONCURRENT_USERS = 50;

async function runTest() {
  resetIntervalRegistry();

  const slot = utcInterval("10:00", "10:30");
  const consultantId = generateConsultantId();

  const config: TestConfig = {
    testName: "Single-Atom Storm",
    category: "11-load-stress",
    concurrentUsers: CONCURRENT_USERS,
    slotTime: slot.start.toISOString(),
    consultantId,
    // 1 booking + 1 structural assertion.
    expectedSuccesses: 2,
    expectedConflicts: CONCURRENT_USERS - 1,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": CONCURRENT_USERS,
    "Consultant ID": consultantId,
    Slot: `${slot.label} (1 atom)`,
    "Expected Outcome": `1 booking, ${CONCURRENT_USERS - 1} conflicts`,
  });

  const startTime = Date.now();

  const results = await Promise.all(
    Array.from({ length: CONCURRENT_USERS }, (_, index) =>
      attemptIntervalBooking({
        userId: generateUserId(index + 1),
        consultantProfileId: consultantId,
        interval: slot,
      }),
    ),
  );

  const duration = Date.now() - startTime;

  const [atomKey] = atomKeys(consultantId, slot);
  results.push(
    assertionResult(
      "storm-left-no-zombie-key",
      !(await atomKeyExists(atomKey)),
      `${atomKey} released after ${CONCURRENT_USERS} attempts`,
    ),
  );

  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  console.log(`\n📊 Storm Metrics:`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(
    `   Throughput: ${(CONCURRENT_USERS / (duration / 1000)).toFixed(1)} req/s`,
  );
  console.log(`   Avg Latency: ${report.summary.averageDuration}ms`);
  console.log(`   P95 Latency: ${report.summary.p95Duration}ms`);
  console.log(`   P99 Latency: ${report.summary.p99Duration}ms`);

  await saveScenarioReports(report, "test-single-atom-storm");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
