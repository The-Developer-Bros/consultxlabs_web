/**
 * Core Test Helper Utilities for Race Condition Test Suite
 * Provides shared functions for executing, analyzing, and reporting test results
 */

import {
  lockSlotBooking,
  unlockSlotBooking,
  type ApprovalLock,
} from "../../../../utils/appointmentlock.js";
// #1169 PR 1 — lockSlotBooking is interval-granular now; these scripts lock a
// single 30-minute atom, so the interval is [start, start+30m). Exported so
// every race script shares one copy (#1170 review).
export const thirtyAfter = (iso: string): string => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) {
    // Stay total on unparseable input: the interval lock layer refuses
    // zero-atom intervals itself (fail closed), and the invalid-time scenario
    // asserts that refusal — a throw here would crash the whole runner
    // instead of exercising it.
    return `${iso}+30m`;
  }
  return new Date(t + 30 * 60 * 1000).toISOString();
};

import type {
  BookingResult,
  TestReport,
  TestConfig,
  SummaryReport,
} from "./types";

/**
 * Global slot booking registry to simulate database state across concurrent requests
 * Key format: "consultantId:slotTime"
 * Value: userId who successfully booked the slot
 */
const bookedSlots = new Map<string, string>();

/**
 * Reset the booking registry (call between tests)
 */
export function resetBookingRegistry(): void {
  bookedSlots.clear();
}

/**
 * Simulate a single booking attempt using the distributed locking mechanism
 * This mirrors the actual booking endpoint behavior including validation
 */
export async function simulateBookingAttempt(
  slotTime: string,
  consultantId: string,
  userId: string,
): Promise<BookingResult> {
  const startTime = Date.now();
  let lock: ApprovalLock[] | null = null;

  try {
    // Acquire lock for this specific slot (15s TTL, matching production)
    lock = await lockSlotBooking(consultantId, slotTime, thirtyAfter(slotTime), 15000);

    // Simulate validation check (like SlotValidationService does)
    const slotKey = `${consultantId}:${slotTime}`;
    const existingBooking = bookedSlots.get(slotKey);

    if (existingBooking) {
      // Slot already booked - this simulates the validation layer catching it
      const duration = Date.now() - startTime;
      return {
        userId,
        status: 409, // Conflict
        duration,
        timestamp: new Date().toISOString(),
        error: "Slot is already booked",
      };
    }

    // Simulate booking creation (database write)
    await new Promise((resolve) => setTimeout(resolve, 100)); // 100ms simulated DB write

    // Mark slot as booked
    bookedSlots.set(slotKey, userId);

    const duration = Date.now() - startTime;

    return {
      userId,
      status: 201, // Created
      duration,
      timestamp: new Date().toISOString(),
      data: {
        message: "Booking created successfully",
        lockAcquired: true,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    return {
      userId,
      status: 409, // Conflict
      duration,
      timestamp: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message
          : "Failed to acquire lock - slot being booked",
    };
  } finally {
    // Always release lock (critical for preventing zombie locks)
    if (lock) {
      await unlockSlotBooking(lock);
    }
  }
}

/**
 * Execute concurrent booking attempts for the same slot
 * This is the core testing function that simulates race conditions
 */
export async function executeConcurrentBookings(
  slotTime: string,
  consultantId: string,
  concurrentUsers: number,
): Promise<BookingResult[]> {
  // Generate user IDs
  const userIds = Array.from(
    { length: concurrentUsers },
    (_, i) => `user-${i + 1}`,
  );

  // Execute all booking attempts in parallel (simulates concurrent requests)
  const bookingPromises = userIds.map((userId) =>
    simulateBookingAttempt(slotTime, consultantId, userId),
  );

  return await Promise.all(bookingPromises);
}

/**
 * Analyze booking results and generate summary statistics
 */
export function analyzeResults(results: BookingResult[]): {
  successes: number;
  conflicts: number;
  errors: number;
  averageDuration: number;
  p95Duration: number;
  p99Duration: number;
  durations: number[];
} {
  const successes = results.filter((r) => r.status === 201).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  const errors = results.filter(
    (r) => r.status !== 201 && r.status !== 409,
  ).length;

  const durations = results.map((r) => r.duration).sort((a, b) => a - b);
  const averageDuration =
    durations.reduce((sum, d) => sum + d, 0) / durations.length;

  // Calculate percentiles
  const p95Index = Math.floor(durations.length * 0.95);
  const p99Index = Math.floor(durations.length * 0.99);
  const p95Duration = durations[p95Index] || 0;
  const p99Duration = durations[p99Index] || 0;

  return {
    successes,
    conflicts,
    errors,
    averageDuration: Math.round(averageDuration),
    p95Duration,
    p99Duration,
    durations,
  };
}

/**
 * Validate test results against expectations
 */
export function validateExpectations(
  results: BookingResult[],
  expectedSuccesses: number,
  expectedConflicts: number,
  expectedErrors: number = 0,
): boolean {
  const analysis = analyzeResults(results);

  return (
    analysis.successes === expectedSuccesses &&
    analysis.conflicts === expectedConflicts &&
    analysis.errors === expectedErrors
  );
}

/**
 * Generate a complete test report
 */
export function generateTestReport(
  config: TestConfig,
  results: BookingResult[],
  duration: number,
): TestReport {
  const analysis = analyzeResults(results);
  const passed = validateExpectations(
    results,
    config.expectedSuccesses,
    config.expectedConflicts,
    config.expectedErrors || 0,
  );

  return {
    testName: config.testName,
    category: config.category,
    passed,
    duration,
    results,
    summary: {
      totalRequests: results.length,
      successes: analysis.successes,
      conflicts: analysis.conflicts,
      errors: analysis.errors,
      averageDuration: analysis.averageDuration,
      p95Duration: analysis.p95Duration,
      p99Duration: analysis.p99Duration,
    },
    expectations: {
      expectedSuccesses: config.expectedSuccesses,
      expectedConflicts: config.expectedConflicts,
      expectedErrors: config.expectedErrors || 0,
      actualSuccesses: analysis.successes,
      actualConflicts: analysis.conflicts,
      actualErrors: analysis.errors,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Log test start with configuration
 */
export function logTestStart(testName: string, config: any): void {
  console.log("\n🧪 RACE CONDITION TEST: " + testName);
  console.log("=".repeat(60));
  console.log("\n📋 Configuration:");
  Object.entries(config).forEach(([key, value]) => {
    console.log(`   ${key}: ${value}`);
  });
  console.log("\n" + "-".repeat(60) + "\n");
}

/**
 * Log test results with formatted output
 */
export function logTestResult(report: TestReport): void {
  console.log("\n📊 RESULTS:\n");

  // Display results table
  const tableData = report.results.map((r) => ({
    user: r.userId,
    status: r.status,
    duration_ms: r.duration,
    outcome:
      r.status === 201
        ? "SUCCESS ✅"
        : r.status === 409
          ? "CONFLICT ⚠️"
          : "ERROR ❌",
  }));

  console.table(tableData);

  // Display summary
  console.log("\n" + "-".repeat(60));
  console.log("\n📈 SUMMARY:\n");
  console.log(`   Total Requests: ${report.summary.totalRequests}`);
  console.log(`   ✅ Successes: ${report.summary.successes}`);
  console.log(`   ⚠️  Conflicts: ${report.summary.conflicts}`);
  console.log(`   ❌ Errors: ${report.summary.errors}`);
  console.log(`   ⏱️  Avg Duration: ${report.summary.averageDuration}ms`);
  if (report.summary.p95Duration) {
    console.log(`   📊 P95 Duration: ${report.summary.p95Duration}ms`);
  }
  if (report.summary.p99Duration) {
    console.log(`   📊 P99 Duration: ${report.summary.p99Duration}ms`);
  }

  // Display verdict
  console.log("\n" + "=".repeat(60));
  if (report.passed) {
    console.log("\n✅ TEST PASSED!");
    console.log(
      `   Expected: ${report.expectations.expectedSuccesses} success, ${report.expectations.expectedConflicts} conflicts`,
    );
    console.log(
      `   Actual: ${report.expectations.actualSuccesses} success, ${report.expectations.actualConflicts} conflicts`,
    );
    console.log("   Race condition protection working correctly!");
  } else {
    console.log("\n❌ TEST FAILED!");
    console.log(
      `   Expected: ${report.expectations.expectedSuccesses} success, ${report.expectations.expectedConflicts} conflicts, ${report.expectations.expectedErrors} errors`,
    );
    console.log(
      `   Actual: ${report.expectations.actualSuccesses} success, ${report.expectations.actualConflicts} conflicts, ${report.expectations.actualErrors} errors`,
    );
    console.log("   Race condition protection may not be working correctly!");
  }
  console.log("\n" + "=".repeat(60) + "\n");
}

/**
 * Generate markdown report for test results
 */
export function generateMarkdownReport(report: SummaryReport): string {
  const lines: string[] = [];

  lines.push("# Race Condition Test Suite Report");
  lines.push(`**Date:** ${new Date(report.timestamp).toLocaleDateString()}`);
  lines.push(`**Mode:** ${report.mode}`);
  lines.push(
    `**Duration:** ${Math.floor(report.totalDuration / 1000 / 60)}m ${Math.floor((report.totalDuration / 1000) % 60)}s`,
  );
  lines.push("");

  lines.push("## Summary");
  lines.push(`- **Total Tests:** ${report.totalTests}`);
  lines.push(`- **Passed:** ${report.passedTests} ✅`);
  lines.push(`- **Failed:** ${report.failedTests} ❌`);
  lines.push(
    `- **Success Rate:** ${Math.round((report.passedTests / report.totalTests) * 100)}%`,
  );
  lines.push("");

  lines.push("## Category Results");
  lines.push("");

  report.categories.forEach((category, index) => {
    lines.push(
      `### ${index + 1}. ${category.category} (${category.passedTests}/${category.totalTests} passed)`,
    );
    lines.push("| Test | Status | Duration | Details |");
    lines.push("|------|--------|----------|---------|");

    category.tests.forEach((test) => {
      const status = test.passed ? "✅" : "❌";
      const duration = `${(test.duration / 1000).toFixed(1)}s`;
      const details = `${test.summary.successes} success, ${test.summary.conflicts} conflicts`;
      lines.push(`| ${test.testName} | ${status} | ${duration} | ${details} |`);
    });

    lines.push("");
  });

  lines.push("## Verdict");
  if (report.failedTests === 0) {
    lines.push("✅ **ALL TESTS PASSED**");
    lines.push("Race condition fix is working correctly across all scenarios.");
  } else {
    lines.push("❌ **SOME TESTS FAILED**");
    lines.push(
      `${report.failedTests} test(s) failed. Please review the failures above.`,
    );
  }

  return lines.join("\n");
}

/**
 * Save JSON report to file
 */
export async function saveJsonReport(
  report: any,
  filename: string,
): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const filepath = path.join(
    process.cwd(),
    "tests/typescript/race-conditions/results",
    filename,
  );
  // Ensure directory exists
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`📄 JSON report saved: ${filepath}`);
}

/**
 * Save Markdown report to file
 */
export async function saveMarkdownReport(
  content: string,
  filename: string,
): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const filepath = path.join(
    process.cwd(),
    "tests/typescript/race-conditions/results/reports",
    filename,
  );
  // Ensure directory exists
  const dir = path.dirname(filepath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filepath, content, "utf-8");
  console.log(`📄 Markdown report saved: ${filepath}`);
}
