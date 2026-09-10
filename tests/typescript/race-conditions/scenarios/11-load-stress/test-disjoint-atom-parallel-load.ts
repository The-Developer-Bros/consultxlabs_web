/**
 * Test: Disjoint-Atom Parallel Load
 * Category: 11 - Load and Stress
 *
 * Scenario: 40 consultees book 40 different 30-minute slots on the SAME
 * consultant, all at once.
 * Expected: 40 bookings, 0 conflicts, and a wall clock nowhere near what
 * serialised bookings would cost.
 *
 * Atom keys are per-slot, not per-consultant, so a consultant's day stays
 * parallel (#1169). This is the guard against "fix the double-booking by
 * locking the whole consultant": that passes every correctness test in this
 * suite and quietly turns a busy calendar into a queue.
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  attemptIntervalBooking,
  logAssertions,
  resetIntervalRegistry,
  saveScenarioReports,
  utcIntervalFromMinutes,
} from "../../utilities/interval-helpers.js";
import {
  generateConsultantId,
  generateUserId,
} from "../../utilities/fixtures.js";
import type { TestConfig } from "../../utilities/types.js";

const CONCURRENT_USERS = 40;
const ATOM_MINUTES = 30;

// Generous on purpose: 40 independent bookings take well under a second here,
// while 40 serialised ones would cost at least a retry backoff apiece. The
// ceiling only has to catch accidental serialisation, not measure it.
const WALL_CLOCK_CEILING_MS = 10000;

async function runTest() {
  resetIntervalRegistry();

  const consultantId = generateConsultantId();
  const slots = Array.from({ length: CONCURRENT_USERS }, (_, index) =>
    utcIntervalFromMinutes(index * ATOM_MINUTES, (index + 1) * ATOM_MINUTES),
  );
  const span = utcIntervalFromMinutes(0, CONCURRENT_USERS * ATOM_MINUTES);

  const config: TestConfig = {
    testName: "Disjoint-Atom Parallel Load",
    category: "11-load-stress",
    concurrentUsers: CONCURRENT_USERS,
    slotTime: span.label,
    consultantId,
    // 40 bookings + 1 structural assertion.
    expectedSuccesses: CONCURRENT_USERS + 1,
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": CONCURRENT_USERS,
    "Consultant ID": consultantId,
    Slots: `${CONCURRENT_USERS} adjacent ${ATOM_MINUTES}-minute atoms (${span.label})`,
    "Wall-Clock Ceiling": `${WALL_CLOCK_CEILING_MS}ms`,
    "Expected Outcome": `${CONCURRENT_USERS} bookings, 0 conflicts`,
  });

  const startTime = Date.now();

  const results = await Promise.all(
    slots.map((slot, index) =>
      attemptIntervalBooking({
        userId: generateUserId(index + 1),
        consultantProfileId: consultantId,
        interval: slot,
      }),
    ),
  );

  const duration = Date.now() - startTime;

  results.push(
    assertionResult(
      "no-accidental-serialisation",
      duration < WALL_CLOCK_CEILING_MS,
      `${CONCURRENT_USERS} disjoint bookings finished in ${duration}ms (< ${WALL_CLOCK_CEILING_MS}ms)`,
    ),
  );

  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  console.log(`\n📊 Parallel Load Metrics:`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(
    `   Throughput: ${(CONCURRENT_USERS / (duration / 1000)).toFixed(1)} req/s`,
  );
  console.log(`   Avg Latency: ${report.summary.averageDuration}ms`);
  console.log(`   P95 Latency: ${report.summary.p95Duration}ms`);

  await saveScenarioReports(report, "test-disjoint-atom-parallel-load");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
