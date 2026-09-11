/**
 * Test: Release Then Re-Acquire Leaves No Zombie Keys
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: Acquire 10:00-11:30, release it, and immediately acquire the same
 * interval again — then acquire an overlapping one.
 * Expected: Every atom key is gone after the release, and both re-acquisitions
 * succeed without waiting.
 *
 * unlockSlotInterval releases in reverse and never throws (#1169). A release
 * that missed an atom would leave the slot unbookable until its TTL lapsed,
 * which is invisible in production until a consultant reports a dead hour.
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  atomIsos,
  atomKeyExists,
  atomKeys,
  attemptIntervalLock,
  logAssertions,
  saveScenarioReports,
  utcInterval,
} from "../../utilities/interval-helpers.js";
import {
  lockSlotInterval,
  unlockSlotInterval,
} from "../../../../../utils/appointmentlock.js";
import { generateConsultantId } from "../../utilities/fixtures.js";
import type { BookingResult, TestConfig } from "../../utilities/types.js";

// Same ceiling as the adjacent-intervals scenario: a contended acquisition
// costs ~7s of backoff, so anything this fast never waited.
const NO_WAIT_CEILING_MS = 3000;

async function runTest() {
  const interval = utcInterval("10:00", "11:30");
  const overlapping = utcInterval("11:00", "12:00");
  const consultantId = generateConsultantId();
  const keys = atomKeys(consultantId, interval);

  const config: TestConfig = {
    testName: "Release Then Re-Acquire Leaves No Zombie Keys",
    category: "10-interval-lock-semantics",
    concurrentUsers: 1,
    slotTime: interval.start.toISOString(),
    consultantId,
    // 2 re-acquisitions + 3 structural assertions.
    expectedSuccesses: 5,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Consultant ID": consultantId,
    Interval: `${interval.label} → [${atomIsos(interval).join(", ")}]`,
    "Overlapping Interval": overlapping.label,
    "Expected Outcome": "all atom keys cleared, both re-acquisitions succeed",
  });

  const startTime = Date.now();
  const results: BookingResult[] = [];

  const locks = await lockSlotInterval(
    consultantId,
    interval.start,
    interval.end,
    60000,
  );
  const heldWhileLocked = await Promise.all(keys.map(atomKeyExists));

  await unlockSlotInterval(locks);
  const heldAfterRelease = await Promise.all(keys.map(atomKeyExists));

  results.push(
    assertionResult(
      "all-atoms-held-while-locked",
      heldWhileLocked.every(Boolean),
      `${heldWhileLocked.filter(Boolean).length}/${keys.length} atom keys present while held`,
    ),
    assertionResult(
      "no-atom-survives-the-release",
      heldAfterRelease.every((held) => !held),
      `${heldAfterRelease.filter(Boolean).length}/${keys.length} atom keys still present after release`,
    ),
  );

  const reacquisitions = [
    await attemptIntervalLock({
      userId: "same-interval-rebooking",
      consultantProfileId: consultantId,
      interval,
    }),
    await attemptIntervalLock({
      userId: "overlapping-interval-rebooking",
      consultantProfileId: consultantId,
      interval: overlapping,
    }),
  ];
  const slowest = Math.max(...reacquisitions.map((result) => result.duration));

  results.push(
    ...reacquisitions,
    assertionResult(
      "re-acquisition-never-waited",
      slowest < NO_WAIT_CEILING_MS,
      `slowest re-acquisition ${slowest}ms < ${NO_WAIT_CEILING_MS}ms`,
    ),
  );

  const duration = Date.now() - startTime;
  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-release-then-reacquire");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
