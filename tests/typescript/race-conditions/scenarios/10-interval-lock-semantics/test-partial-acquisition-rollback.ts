/**
 * Test: Partial Acquisition Rolls Back Every Atom
 * Category: 10 - Interval Lock Semantics
 *
 * Scenario: Only the 11:00 atom is held. A 10:00-12:00 booking then walks the
 * grid, takes 10:00 and 10:30, and dies on 11:00.
 * Expected: It fails, and 10:00, 10:30 and 11:30 are all free immediately after.
 *
 * Interval acquisition is all-or-nothing with a reverse rollback (#1169). A
 * failed booking that kept its partial atoms would blank out an hour of a
 * consultant's day for a full TTL while nothing was ever booked.
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

async function runTest() {
  const full = utcInterval("10:00", "12:00");
  const blocked = utcInterval("11:00", "11:30");
  const head = utcInterval("10:00", "11:00");
  const tail = utcInterval("11:30", "12:00");
  const consultantId = generateConsultantId();

  const config: TestConfig = {
    testName: "Partial Acquisition Rolls Back Every Atom",
    category: "10-interval-lock-semantics",
    concurrentUsers: 1,
    slotTime: full.start.toISOString(),
    consultantId,
    // head + tail re-acquisitions + 3 structural assertions; the failed
    // 10:00-12:00 booking is the conflict.
    expectedSuccesses: 5,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  logTestStart(config.testName, {
    Category: config.category,
    "Consultant ID": consultantId,
    "Pre-held Atom": blocked.start.toISOString(),
    "Attempted Interval": `${full.label} → [${atomIsos(full).join(", ")}]`,
    "Expected Outcome": "attempt conflicts, 10:00 / 10:30 / 11:30 stay free",
  });

  const startTime = Date.now();
  const results: BookingResult[] = [];

  // A one-atom interval IS the single-key lock — same namespace, same format.
  const preHeld = await lockSlotInterval(
    consultantId,
    blocked.start,
    blocked.end,
    60000,
  );

  try {
    const attempt = await attemptIntervalLock({
      userId: "full-interval-booking",
      consultantProfileId: consultantId,
      interval: full,
    });
    results.push(attempt);

    const [headKey, secondKey] = atomKeys(consultantId, head);
    const [tailKey] = atomKeys(consultantId, tail);
    const [headHeld, secondHeld, tailHeld] = await Promise.all([
      atomKeyExists(headKey),
      atomKeyExists(secondKey),
      atomKeyExists(tailKey),
    ]);

    // The sharper proof is the re-booking, not the key probe: it shows the
    // rolled-back atoms are usable again, not merely absent from Redis.
    results.push(
      assertionResult(
        "conflict-names-the-held-atom",
        attempt.error?.includes(blocked.start.toISOString()) === true,
        attempt.error ?? "attempt did not fail",
      ),
      assertionResult(
        "acquired-atoms-were-released",
        !headHeld && !secondHeld,
        `10:00 held=${headHeld}, 10:30 held=${secondHeld} after rollback`,
      ),
      assertionResult(
        "unreached-atom-never-taken",
        !tailHeld,
        `11:30 held=${tailHeld} (acquisition never got past 11:00)`,
      ),
      await attemptIntervalLock({
        userId: "head-rebooking",
        consultantProfileId: consultantId,
        interval: head,
      }),
      await attemptIntervalLock({
        userId: "tail-rebooking",
        consultantProfileId: consultantId,
        interval: tail,
      }),
    );
  } finally {
    await unlockSlotInterval(preHeld);
  }

  const duration = Date.now() - startTime;
  const report = generateTestReport(config, results, duration);

  logTestResult(report);
  logAssertions(results);

  await saveScenarioReports(report, "test-partial-acquisition-rollback");

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
