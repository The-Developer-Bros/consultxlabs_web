/**
 * Test: Crossed Acquisition Order Is Deadlock-Free
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: 10:00-11:30 and 10:30-12:00 are booked concurrently. Their atom
 * sets overlap but their FIRST atoms differ, so a naive implementation could
 * have each side holding the atom the other needs next.
 * Expected: Every round settles with exactly one winner, and once the winner
 * releases, the loser can acquire.
 *
 * Atoms are acquired in ascending order (#1169), which is a total order over
 * one consultant's day, so no cycle can form: 10:30 is always taken before
 * 11:00, by everyone. The four rounds run on four separate consultants so the
 * suite pays one retry-backoff window (~7s) rather than four.
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  attemptIntervalLock,
  createBarrier,
  logAssertions,
  saveScenarioReports,
  sharedAtoms,
  utcInterval,
  type TestInterval,
} from "../../utilities/interval-helpers.js";
import { generateConsultantId } from "../../utilities/fixtures.js";
import type { BookingResult, TestConfig } from "../../utilities/types.js";

const ROUNDS = 4;

// A round is one contention window (~7s of retry backoff). Anything near this
// ceiling means the two sides are waiting on each other, not backing off.
const DEADLOCK_CEILING_MS = 15000;

interface RoundOutcome {
  round: number;
  durationMs: number;
  results: BookingResult[];
  loserInterval: TestInterval | null;
  winners: number;
}

async function runRound(round: number): Promise<RoundOutcome> {
  const consultantId = generateConsultantId(round);
  const early = utcInterval("10:00", "11:30");
  const late = utcInterval("10:30", "12:00");

  const barrier = createBarrier(2);
  // Deferred on purpose: calling attemptIntervalLock builds a promise that is
  // already running, so an array of calls fixes the start order at the literal
  // and no later reordering can change it.
  const startEarly = () =>
    attemptIntervalLock({
      userId: `round-${round}-early`,
      consultantProfileId: consultantId,
      interval: early,
      barrier,
    });
  const startLate = () =>
    attemptIntervalLock({
      userId: `round-${round}-late`,
      consultantProfileId: consultantId,
      interval: late,
      barrier,
    });

  // Alternate which side starts first — the crossed order is the whole point.
  // The winner does not alternate with it, and that is not a flaw in the test:
  // 10:30 is the late side's FIRST atom and the early side's SECOND, so the
  // early side is still acquiring 10:00 when the late side takes the atom they
  // share. Which is why every assertion here counts winners instead of naming one.
  const startedAt = Date.now();
  const starters =
    round % 2 === 0 ? [startEarly, startLate] : [startLate, startEarly];
  const results = await Promise.all(starters.map((start) => start()));
  const durationMs = Date.now() - startedAt;

  const loser = results.find((result) => result.status === 409);
  const loserInterval = loser
    ? (loser.userId.endsWith("-early") ? early : late)
    : null;

  // Every lock from this round is released by now, so the loser's interval must
  // be free — a rollback that leaked an atom would show up right here. No loser
  // at all means both overlapping intervals were granted, which is the failure
  // this scenario exists to catch, so say so rather than probing an arbitrary side.
  const reacquire = loserInterval
    ? await attemptIntervalLock({
        userId: `round-${round}-loser-retry`,
        consultantProfileId: consultantId,
        interval: loserInterval,
      })
    : assertionResult(
        `round-${round}-had-a-refusal`,
        false,
        `round ${round}: no attempt was refused — both overlapping intervals acquired`,
      );

  return {
    round,
    durationMs,
    results: [...results, reacquire],
    loserInterval,
    winners: results.filter((result) => result.status === 201).length,
  };
}

async function runTest() {
  const early = utcInterval("10:00", "11:30");
  const late = utcInterval("10:30", "12:00");

  const config: TestConfig = {
    testName: "Crossed Acquisition Order Is Deadlock-Free",
    category: "10-interval-lock-semantics",
    concurrentUsers: ROUNDS * 2,
    slotTime: early.start.toISOString(),
    consultantId: "test-consultant-001..004",
    // Per round: 1 winner + 1 loser-retry + 1 assertion; plus 1 global ceiling.
    expectedSuccesses: ROUNDS * 3 + 1,
    expectedConflicts: ROUNDS,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    Rounds: ROUNDS,
    "Interval A": early.label,
    "Interval B": late.label,
    "Shared Atoms": sharedAtoms(early, late).join(", "),
    Consultants: "one per round (rounds run in parallel)",
    "Expected Outcome": `${ROUNDS} winners, ${ROUNDS} conflicts, every loser retry succeeds`,
  });

  const startTime = Date.now();
  const rounds = await Promise.all(
    Array.from({ length: ROUNDS }, (_, index) => runRound(index + 1)),
  );
  const duration = Date.now() - startTime;

  const results = rounds.flatMap((round) => round.results);

  rounds.forEach((round) => {
    results.push(
      assertionResult(
        `round-${round.round}-single-winner`,
        round.winners === 1,
        `round ${round.round}: ${round.winners} winner(s), loser ${round.loserInterval?.label ?? "none"} re-acquired in ${round.durationMs}ms`,
      ),
    );
  });

  const slowestRound = Math.max(...rounds.map((round) => round.durationMs));
  results.push(
    assertionResult(
      "no-round-hit-the-deadlock-ceiling",
      slowestRound < DEADLOCK_CEILING_MS,
      `slowest round ${slowestRound}ms < ${DEADLOCK_CEILING_MS}ms`,
    ),
  );

  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-crossed-acquisition-order");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
