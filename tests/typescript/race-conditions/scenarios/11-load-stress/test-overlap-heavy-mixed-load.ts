/**
 * Test: Overlap-Heavy Mixed Load
 * Category: 11 - Load and Stress
 *
 * Scenario: 30 consultees spread across 10 one-hour intervals that start every
 * 12 minutes inside a single three-hour window, so most pairs overlap and most
 * starts sit off the half-hour grid.
 * Expected: Whoever wins, no two bookings share a 30-minute atom, and nothing
 * errors.
 *
 * How many bookings fit depends on which requests land first, so a winner count
 * would be a coin flip dressed as an assertion. The invariant is the real
 * contract (#1169): overlapping bookings are mutually exclusive, and the atom
 * grid decides what "overlapping" means — so the check derives shared atoms from
 * slotAtomStarts rather than from the requested clock times.
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  atomIsos,
  attemptIntervalBooking,
  logAssertions,
  resetIntervalRegistry,
  saveScenarioReports,
  utcIntervalFromMinutes,
  type TestInterval,
} from "../../utilities/interval-helpers.js";
import {
  generateConsultantId,
  generateUserId,
} from "../../utilities/fixtures.js";
import type { TestConfig } from "../../utilities/types.js";

const TEST_NAME = "Overlap-Heavy Mixed Load";
const CATEGORY = "11-load-stress";

const WINDOW_START_MINUTES = 10 * 60;
const WINDOW_END_MINUTES = 13 * 60;
const INTERVAL_COUNT = 10;
const INTERVAL_MINUTES = 60;
const INTERVAL_STEP_MINUTES = 12;
const USERS_PER_INTERVAL = 3;

interface Assignment {
  userId: string;
  interval: TestInterval;
}

async function runTest() {
  resetIntervalRegistry();

  const consultantId = generateConsultantId();
  const window = utcIntervalFromMinutes(WINDOW_START_MINUTES, WINDOW_END_MINUTES);
  const intervals = Array.from({ length: INTERVAL_COUNT }, (_, index) => {
    const start = WINDOW_START_MINUTES + index * INTERVAL_STEP_MINUTES;
    return utcIntervalFromMinutes(start, start + INTERVAL_MINUTES);
  });

  // Round-robin so the launch order interleaves intervals instead of running
  // one interval's three contenders back to back.
  const assignments: Assignment[] = Array.from(
    { length: INTERVAL_COUNT * USERS_PER_INTERVAL },
    (_, index) => ({
      userId: generateUserId(index + 1),
      interval: intervals[index % INTERVAL_COUNT],
    }),
  );

  logTestStart(TEST_NAME, {
    Category: CATEGORY,
    "Concurrent Users": assignments.length,
    "Consultant ID": consultantId,
    Window: `${window.label} (${atomIsos(window).length} atoms)`,
    Intervals: `${INTERVAL_COUNT} × ${INTERVAL_MINUTES}min, every ${INTERVAL_STEP_MINUTES}min`,
    "Expected Outcome": "winner count is not pinned; no two winners share an atom",
  });

  const startTime = Date.now();

  const results = await Promise.all(
    assignments.map((assignment) =>
      attemptIntervalBooking({
        userId: assignment.userId,
        consultantProfileId: consultantId,
        interval: assignment.interval,
      }),
    ),
  );

  const duration = Date.now() - startTime;

  const winningUsers = new Set(
    results.filter((result) => result.status === 201).map((r) => r.userId),
  );
  const winners = assignments.filter((assignment) =>
    winningUsers.has(assignment.userId),
  );

  const claimedBy = new Map<string, string>();
  const collisions: string[] = [];
  winners.forEach((winner) => {
    atomIsos(winner.interval).forEach((iso) => {
      const owner = claimedBy.get(iso);
      if (owner) {
        collisions.push(`${iso}: ${owner} and ${winner.userId}`);
        return;
      }
      claimedBy.set(iso, winner.userId);
    });
  });

  results.push(
    assertionResult(
      "no-two-bookings-share-an-atom",
      collisions.length === 0,
      collisions.length === 0
        ? `${winners.length} booking(s) over ${claimedBy.size} distinct atom(s)`
        : `shared atoms: ${collisions.join("; ")}`,
    ),
    assertionResult(
      "the-window-was-not-deadlocked",
      winners.length > 0,
      `${winners.length} of ${assignments.length} requests booked`,
    ),
  );

  const conflicts = results.filter((result) => result.status === 409).length;

  const config: TestConfig = {
    testName: TEST_NAME,
    category: CATEGORY,
    concurrentUsers: assignments.length,
    slotTime: window.start.toISOString(),
    consultantId,
    // Derived, not pinned: the split between winners and losers is ordering
    // dependent. The two assertions above carry the actual contract, and any
    // unexpected failure still lands in `errors` and fails the run.
    expectedSuccesses: winners.length + 2,
    expectedConflicts: conflicts,
    expectedErrors: 0,
  };

  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  console.log(`\n📊 Mixed Load Metrics:`);
  console.log(`   Total Duration: ${duration}ms`);
  console.log(`   Bookings: ${winners.length} / ${assignments.length}`);
  console.log(`   Atoms Claimed: ${claimedBy.size} / ${atomIsos(window).length}`);
  console.log(`   P95 Latency: ${report.summary.p95Duration}ms`);

  await saveScenarioReports(report, "test-overlap-heavy-mixed-load");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
