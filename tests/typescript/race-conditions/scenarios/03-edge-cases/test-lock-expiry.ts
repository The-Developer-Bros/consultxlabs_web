/**
 * Test: Lock Expiry Simulation
 * Category: 03 - Edge Cases
 *
 * Scenario: User acquires lock but holds it for extended time, testing TTL behavior
 * Expected: Lock should auto-expire after TTL, allowing next user to proceed
 *
 * This test validates that locks don't permanently block slots if a
 * request hangs or times out.
 *
 * Test Flow:
 * 1. User 1 acquires lock with 2s TTL but simulates a hang (doesn't book or release)
 * 2. Wait 2.5s for lock to auto-expire
 * 3. User 2 should be able to acquire lock and book successfully
 *
 * Expected: 1 success (User 2 books after lock expires)
 * Note: User 1's hung request is tracked separately, not as a booking attempt
 */

import {
  generateTestReport,
  logTestStart,
  logTestResult,
  saveJsonReport,
  saveMarkdownReport,
  generateMarkdownReport,
  resetBookingRegistry,
} from "../../utilities/test-helpers.js";
import { thirtyAfter } from "../../utilities/test-helpers.js";
import {
  lockSlotBooking,
  unlockSlotBooking,
  type ApprovalLock,
} from "../../../../../utils/appointmentlock.js";

import {
  generateTestSlot,
  generateConsultantId,
  generateUserId,
} from "../../utilities/fixtures.js";
import type {
  TestConfig,
  SummaryReport,
  BookingResult,
} from "../../utilities/types.js";

async function runTest() {
  resetBookingRegistry();

  const config: TestConfig = {
    testName: "Lock Expiry Simulation",
    category: "03-edge-cases",
    concurrentUsers: 1, // Only User 2 actually attempts to book (after lock expiry)
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1, // User 2 succeeds after lock expires
    expectedConflicts: 0,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 10, 0);
  const consultantId = generateConsultantId();
  const user1 = generateUserId(1);
  const user2 = generateUserId(2);

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Lock TTL": "2000ms (short for testing)",
    "Expected Outcome": "User 1 holds lock until expiry, User 2 succeeds after",
  });

  const startTime = Date.now();
  const results: BookingResult[] = [];

  try {
    // User 1: Acquire lock with short TTL and DON'T release it (simulating hung request)
    const lock1Start = Date.now();
    const lock1 = await lockSlotBooking(consultantId, slot.start, thirtyAfter(slot.start), 2000); // 2s TTL

    // Simulate processing but DON'T unlock (testing auto-expiry)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // User 1 simulates a hung request - they acquire the lock but never complete booking
    // This is NOT a successful booking, just a lock acquisition for testing expiry
    console.log(
      `   🔒 User 1 acquired lock (will hold until expiry to simulate hang)`,
    );
    console.log(
      `   ⏱️  Lock TTL: 2000ms, held for: ${Date.now() - lock1Start}ms`,
    );
    // Note: We don't push User 1's result as a booking attempt since they never booked

    // Wait for lock to expire
    console.log("   ⏳ Waiting 2.5s for lock to expire...");
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // User 2: Try to acquire lock after expiry
    const lock2Start = Date.now();
    let lock2: ApprovalLock[] | null = null;

    try {
      lock2 = await lockSlotBooking(consultantId, slot.start, thirtyAfter(slot.start), 15000);
      await new Promise((resolve) => setTimeout(resolve, 100));

      results.push({
        userId: user2,
        status: 201,
        duration: Date.now() - lock2Start,
        timestamp: new Date().toISOString(),
        data: { message: "Lock acquired successfully after expiry" },
      });
    } catch (error) {
      results.push({
        userId: user2,
        status: 409,
        duration: Date.now() - lock2Start,
        timestamp: new Date().toISOString(),
        error:
          error instanceof Error ? error.message : "Failed to acquire lock",
      });
    } finally {
      if (lock2) await unlockSlotBooking(lock2);
    }

    // Note: lock1 deliberately not released to test expiry
  } catch (error) {
    results.push({
      userId: user1,
      status: 500,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unexpected error",
    });
  }

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `03-edge-cases/test-lock-expiry-${timestamp}.json`,
  );

  const summaryReport: SummaryReport = {
    totalTests: 1,
    passedTests: report.passed ? 1 : 0,
    failedTests: report.passed ? 0 : 1,
    totalDuration: duration,
    categories: [
      {
        category: config.category,
        totalTests: 1,
        passedTests: report.passed ? 1 : 0,
        failedTests: report.passed ? 0 : 1,
        duration: duration,
        tests: [report],
      },
    ],
    timestamp: report.timestamp,
    mode: "sequential",
  };

  const markdownContent = generateMarkdownReport(summaryReport);
  await saveMarkdownReport(markdownContent, `test-lock-expiry-${timestamp}.md`);

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
