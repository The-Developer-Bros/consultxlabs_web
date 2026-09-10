/**
 * Test: Unaligned Interval Floors To The Atom Grid
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: One booking holds 10:15-10:45, which starts off the half-hour grid,
 * while a second booking concurrently asks for the aligned 10:30-11:00.
 * Expected: They share the 10:30 atom, so exactly one acquires.
 *
 * slotAtomStarts floors the start to the half-hour grid (#1169). Without the
 * floor, an unaligned booking would key atoms nothing else keys, and it would
 * overlap every aligned booking around it without ever contending.
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

async function runTest() {
  const unaligned = utcInterval("10:15", "10:45");
  const aligned = utcInterval("10:30", "11:00");
  const consultantId = generateConsultantId();

  const expectedUnalignedAtoms = [
    utcInterval("10:00", "10:30").start.toISOString(),
    utcInterval("10:30", "11:00").start.toISOString(),
  ];

  const config: TestConfig = {
    testName: "Unaligned Interval Floors To The Atom Grid",
    category: "10-interval-lock-semantics",
    concurrentUsers: 2,
    slotTime: unaligned.start.toISOString(),
    consultantId,
    // 1 winner + 3 structural assertions; the loser is the conflict.
    expectedSuccesses: 4,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Consultant ID": consultantId,
    "Interval A (unaligned)": unaligned.label,
    "Interval B (aligned)": aligned.label,
    "A's Atoms": atomIsos(unaligned).join(", "),
    "Shared Atoms": sharedAtoms(unaligned, aligned).join(", "),
    "Expected Outcome": "1 acquires, 1 contends on the 10:30 atom",
  });

  const startTime = Date.now();

  const barrier = createBarrier(2);
  const results: BookingResult[] = await Promise.all([
    attemptIntervalLock({
      userId: generateUserId(1),
      consultantProfileId: consultantId,
      interval: unaligned,
      barrier,
    }),
    attemptIntervalLock({
      userId: generateUserId(2),
      consultantProfileId: consultantId,
      interval: aligned,
      barrier,
    }),
  ]);

  const unalignedAtoms = atomIsos(unaligned);
  const shared = sharedAtoms(unaligned, aligned);
  const loser = results.find((result) => result.status === 409);

  results.push(
    assertionResult(
      "unaligned-start-floors-to-10-00",
      unalignedAtoms.length === 2 &&
        unalignedAtoms.every((iso, index) => iso === expectedUnalignedAtoms[index]),
      `${unaligned.label} covers [${unalignedAtoms.join(", ")}]`,
    ),
    assertionResult(
      "exactly-one-shared-atom",
      shared.length === 1 && shared[0] === expectedUnalignedAtoms[1],
      `shared atoms: [${shared.join(", ")}]`,
    ),
    assertionResult(
      "contention-names-the-shared-atom",
      loser?.error?.includes(expectedUnalignedAtoms[1]) === true,
      loser?.error ?? "no contender failed",
    ),
  );

  const duration = Date.now() - startTime;
  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-unaligned-interval-floors-to-grid");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
