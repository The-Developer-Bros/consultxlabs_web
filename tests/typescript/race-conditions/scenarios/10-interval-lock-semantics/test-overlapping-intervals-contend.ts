/**
 * Test: Overlapping Intervals Contend
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: One booking holds 10:00-12:00 while a second booking concurrently
 * asks for 11:00-11:30, which sits strictly inside it.
 * Expected: Exactly one of the two acquires; the other gets a SlotLockError.
 *
 * This is the exact class of bug the interval keys were built to close (#1169).
 * A lock keyed on the raw start instant gives these two bookings different keys,
 * so both used to sail through to payment for the same consultant-minute. Keying
 * one lock per 30-minute atom means any overlap collides on the atoms it shares.
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
import type { TestConfig } from "../../utilities/types.js";

async function runTest() {
  const wide = utcInterval("10:00", "12:00");
  const inner = utcInterval("11:00", "11:30");
  const consultantId = generateConsultantId();

  const config: TestConfig = {
    testName: "Overlapping Intervals Contend",
    category: "10-interval-lock-semantics",
    concurrentUsers: 2,
    slotTime: wide.start.toISOString(),
    consultantId,
    // 1 winner + 1 structural assertion; the loser is the conflict.
    expectedSuccesses: 2,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Consultant ID": consultantId,
    "Interval A": `${wide.label} (atoms: ${atomIsos(wide).length})`,
    "Interval B": `${inner.label} (atoms: ${atomIsos(inner).length})`,
    "Shared Atoms": sharedAtoms(wide, inner).length,
    "Expected Outcome": "1 acquires, 1 contends",
  });

  const startTime = Date.now();

  // Both hold until both have settled — an early release would let the loser
  // acquire on its next retry and make the outcome a coin flip.
  const barrier = createBarrier(2);
  const results = await Promise.all([
    attemptIntervalLock({
      userId: generateUserId(1),
      consultantProfileId: consultantId,
      interval: wide,
      barrier,
    }),
    attemptIntervalLock({
      userId: generateUserId(2),
      consultantProfileId: consultantId,
      interval: inner,
      barrier,
    }),
  ]);

  const innerAtoms = new Set(atomIsos(inner));
  const wideAtoms = atomIsos(wide);
  results.push(
    assertionResult(
      "inner-is-subset-of-wide",
      [...innerAtoms].every((iso) => wideAtoms.includes(iso)),
      `${inner.label} covers ${[...innerAtoms].length} atom(s), all inside ${wide.label}`,
    ),
  );

  const duration = Date.now() - startTime;
  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-overlapping-intervals-contend");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
