/**
 * Test: Multi-Atom TTL Re-Arm Gives Every Atom One Deadline
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: A four-hour booking (eight atoms) is forced to stall part-way
 * through acquisition by a short-lived lock on one of its middle atoms.
 * Expected: Once the last atom lands, every atom carries the same fresh
 * deadline, and contenders on both the first and the last atom are refused.
 *
 * Atoms are taken one at a time, so the earliest ones spend the whole
 * acquisition burning their TTL — worst case ~57.6s of backoff against a ~59.4s
 * budget, which lets atom 1 expire before the caller's critical section even
 * starts. #1170 re-arms every atom to a shared deadline after the last one is
 * held. The stall below reproduces that erosion deterministically; the TTL
 * spread is measured well away from any expiry boundary.
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
} from "../../utilities/test-helpers.js";
import {
  assertionResult,
  atomIsos,
  atomKeys,
  atomKeyTtlMs,
  attemptIntervalLock,
  createBarrier,
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

// 30s covers a contender's full retry backoff (~7s) several times over, so the
// TTL assertions never sit near an expiry edge.
const INTERVAL_TTL_MS = 30000;

// The blocker expires inside the interval's retry budget, so acquisition stalls
// and then completes on its own — no sleeps, no timing luck.
const BLOCKER_TTL_MS = 2500;
const MIN_STALL_MS = 2000;

// With the re-arm, the first and last atom deadlines are set microseconds
// apart; without it they differ by the whole stall (~3s). The allowance covers
// a real-Redis run, where the re-arm itself costs one round trip per atom.
const MAX_TTL_SPREAD_MS = 1500;

// A re-armed atom keeps its budget minus the 1% clock-drift discount (29700ms
// of the 30000 above), so this floor sits just under it. Deliberately a fixed
// number rather than a mirror of the lock's own arithmetic: an expectation
// recomputed from the implementation agrees with whatever the implementation
// does, and a drift discount large enough to break this floor is a change to
// the lock's safety margin that should fail a test.
const MIN_REARMED_TTL_MS = 28000;

async function runTest() {
  const long = utcInterval("10:00", "14:00");
  const blocker = utcInterval("11:30", "12:00");
  const firstAtom = utcInterval("10:00", "10:30");
  const lastAtom = utcInterval("13:30", "14:00");
  const consultantId = generateConsultantId();

  const config: TestConfig = {
    testName: "Multi-Atom TTL Re-Arm Gives Every Atom One Deadline",
    category: "10-interval-lock-semantics",
    concurrentUsers: 3,
    slotTime: long.start.toISOString(),
    consultantId,
    // The long booking + 3 structural assertions; both contenders conflict.
    expectedSuccesses: 4,
    expectedConflicts: 2,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Consultant ID": consultantId,
    Interval: `${long.label} (${atomIsos(long).length} atoms)`,
    "Blocked Atom": `${blocker.start.toISOString()} (TTL ${BLOCKER_TTL_MS}ms)`,
    "Interval TTL": `${INTERVAL_TTL_MS}ms`,
    "Expected Outcome": "acquisition stalls then completes, all atoms share one deadline",
  });

  const startTime = Date.now();
  const results: BookingResult[] = [];

  // Held, never released: it lapses on its own TTL mid-acquisition, which is
  // exactly the erosion the re-arm exists to undo. Releasing it later would be
  // a no-op anyway — the value check fails once the long booking owns the key.
  await lockSlotInterval(
    consultantId,
    blocker.start,
    blocker.end,
    BLOCKER_TTL_MS,
  );

  const acquisitionStartedAt = Date.now();
  const locks = await lockSlotInterval(
    consultantId,
    long.start,
    long.end,
    INTERVAL_TTL_MS,
  );
  const stallMs = Date.now() - acquisitionStartedAt;

  results.push({
    userId: "long-interval-booking",
    status: 201,
    duration: stallMs,
    timestamp: new Date().toISOString(),
    data: { interval: long.label, atoms: locks.length },
  });

  const keys = atomKeys(consultantId, long);
  const ttls = await Promise.all(keys.map(atomKeyTtlMs));
  const spread = Math.max(...ttls) - Math.min(...ttls);

  try {
    // Both ends of the interval must still be defended. The last atom was
    // acquired last, so only a genuine re-arm keeps the first one alongside it.
    const barrier = createBarrier(2);
    const contenders = await Promise.all([
      attemptIntervalLock({
        userId: "contender-on-first-atom",
        consultantProfileId: consultantId,
        interval: firstAtom,
        barrier,
      }),
      attemptIntervalLock({
        userId: "contender-on-last-atom",
        consultantProfileId: consultantId,
        interval: lastAtom,
        barrier,
      }),
    ]);
    results.push(...contenders);
  } finally {
    await unlockSlotInterval(locks);
  }

  results.push(
    assertionResult(
      "acquisition-really-stalled",
      stallMs >= MIN_STALL_MS,
      `acquisition took ${stallMs}ms (>= ${MIN_STALL_MS}ms of TTL erosion)`,
    ),
    assertionResult(
      "atoms-share-one-deadline",
      spread < MAX_TTL_SPREAD_MS,
      `TTL spread across ${keys.length} atoms was ${spread}ms (< ${MAX_TTL_SPREAD_MS}ms)`,
    ),
    assertionResult(
      "every-atom-carries-a-fresh-ttl",
      Math.min(...ttls) >= MIN_REARMED_TTL_MS,
      `lowest atom TTL ${Math.min(...ttls)}ms (>= ${MIN_REARMED_TTL_MS}ms)`,
    ),
  );

  const duration = Date.now() - startTime;
  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-multi-atom-ttl-rearm");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
