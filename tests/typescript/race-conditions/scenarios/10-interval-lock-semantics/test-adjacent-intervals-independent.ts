/**
 * Test: Adjacent Intervals Do Not Contend
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: Two bookings run back to back — 10:00-10:30 and 10:30-11:00 — and
 * are attempted at the same moment.
 * Expected: Both acquire. Nobody waits.
 *
 * Atoms are half-open [start, end), so a booking that ENDS at 10:30 never keys
 * the 10:30 atom (#1169). The over-locking failure mode is as costly as the
 * under-locking one: it would serialise a consultant's whole day.
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  atomIsos,
  attemptIntervalLock,
  createBarrier,
  logAssertions,
  saveScenarioReports,
  sharedAtoms,
  utcInterval,
} from "../../utilities/interval-helpers.js";
import { generateConsultantId, generateUserId } from "../../utilities/fixtures.js";
import type { BookingResult, TestConfig } from "../../utilities/types.js";

// A contended acquisition burns the full retry backoff (~7s), so a run this
// far under it also proves neither attempt ever waited on the other.
const NO_WAIT_CEILING_MS = 3000;

async function runTest() {
  const earlier = utcInterval("10:00", "10:30");
  const later = utcInterval("10:30", "11:00");
  const consultantId = generateConsultantId();

  const config: TestConfig = {
    testName: "Adjacent Intervals Do Not Contend",
    category: "10-interval-lock-semantics",
    concurrentUsers: 2,
    slotTime: earlier.start.toISOString(),
    consultantId,
    // 2 winners + 2 structural assertions.
    expectedSuccesses: 4,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Consultant ID": consultantId,
    "Interval A": `${earlier.label} → [${atomIsos(earlier).join(", ")}]`,
    "Interval B": `${later.label} → [${atomIsos(later).join(", ")}]`,
    "Shared Atoms": sharedAtoms(earlier, later).length,
    "Expected Outcome": "2 acquire, 0 contend",
  });

  const startTime = Date.now();

  const barrier = createBarrier(2);
  const results: BookingResult[] = await Promise.all([
    attemptIntervalLock({
      userId: generateUserId(1),
      consultantProfileId: consultantId,
      interval: earlier,
      barrier,
    }),
    attemptIntervalLock({
      userId: generateUserId(2),
      consultantProfileId: consultantId,
      interval: later,
      barrier,
    }),
  ]);

  const duration = Date.now() - startTime;
  const slowest = Math.max(...results.map((result) => result.duration));

  results.push(
    assertionResult(
      "no-shared-atoms",
      sharedAtoms(earlier, later).length === 0,
      `${earlier.label} and ${later.label} share 0 atoms (half-open intervals)`,
    ),
    assertionResult(
      "neither-attempt-waited",
      slowest < NO_WAIT_CEILING_MS,
      `slowest acquisition ${slowest}ms < ${NO_WAIT_CEILING_MS}ms`,
    ),
  );

  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-adjacent-intervals-independent");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
