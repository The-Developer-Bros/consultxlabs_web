/**
 * Test: Network Timeout Simulation
 * Category: 03 - Edge Cases
 *
 * Scenario: Simulate slow network requests that take longer than typical
 * Expected: Lock mechanism should handle delayed requests correctly
 *
 * This test validates that the system handles network latency variations
 * and doesn't fail under slow network conditions.
 *
 * Test Flow:
 * 1. Two users try to book the same slot with different network delays
 * 2. User 1 has 500ms network delay, User 2 has 1000ms
 * 3. Despite delays, only one should successfully book
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

/**
 * Shared booking registry to track slots booked during this test
 * This simulates the database state across concurrent requests
 */
const bookedSlots = new Map<string, string>();

async function runTest() {
  resetBookingRegistry();
  bookedSlots.clear(); // Clear local registry too

  const config: TestConfig = {
    testName: "Network Timeout Simulation",
    category: "03-edge-cases",
    concurrentUsers: 2,
    slotTime: "",
    consultantId: "",
    expectedSuccesses: 1,
    expectedConflicts: 1,
    expectedErrors: 0,
  };

  const slot = generateTestSlot(7, 13, 30);
  const consultantId = generateConsultantId();

  config.slotTime = slot.start;
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Concurrent Users": config.concurrentUsers,
    "Slot Time": new Date(slot.start).toLocaleString(),
    "Consultant ID": consultantId,
    "Network Delay": "500-1000ms simulated latency",
    "Expected Outcome": `${config.expectedSuccesses} success, ${config.expectedConflicts} conflicts`,
  });

  const startTime = Date.now();

  /**
   * Simulate a slow network request with network delay before lock acquisition
   * Uses the shared bookedSlots Map to track booking state across concurrent requests
   */
  const simulateSlowRequest = async (
    userId: string,
    networkDelay: number,
  ): Promise<BookingResult> => {
    const requestStart = Date.now();
    let lock: ApprovalLock[] | null = null;

    try {
      // Simulate network delay before lock acquisition
      await new Promise((resolve) => setTimeout(resolve, networkDelay));

      lock = await lockSlotBooking(consultantId, slot.start, thirtyAfter(slot.start), 15000);

      // Check if slot already booked using SHARED registry
      const slotKey = `${consultantId}:${slot.start}`;

      if (bookedSlots.has(slotKey)) {
        return {
          userId,
          status: 409,
          duration: Date.now() - requestStart,
          timestamp: new Date().toISOString(),
          error: "Slot already booked",
        };
      }

      // Simulate processing time (database write)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Mark slot as booked in shared registry
      bookedSlots.set(slotKey, userId);

      return {
        userId,
        status: 201,
        duration: Date.now() - requestStart,
        timestamp: new Date().toISOString(),
        data: { message: "Booking created successfully" },
      };
    } catch (error) {
      return {
        userId,
        status: 409,
        duration: Date.now() - requestStart,
        timestamp: new Date().toISOString(),
        error:
          error instanceof Error ? error.message : "Failed to acquire lock",
      };
    } finally {
      if (lock) await unlockSlotBooking(lock);
    }
  };

  const results: BookingResult[] = await Promise.all([
    simulateSlowRequest(generateUserId(1), 500), // 500ms network delay
    simulateSlowRequest(generateUserId(2), 1000), // 1000ms network delay
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `03-edge-cases/test-network-timeout-simulation-${timestamp}.json`,
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
  await saveMarkdownReport(
    markdownContent,
    `test-network-timeout-simulation-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
