/**
 * Test: Invalid Time Format
 * Category: 04 - Validation Scenarios
 *
 * Scenario: Attempt to book with malformed time strings
 * Expected: The interval lock layer REFUSES unparseable times (fail closed)
 *
 * Since #1170, slot lock keys are not opaque strings: times are parsed into
 * 30-minute atoms, and an unparseable time yields zero atoms, which
 * lockSlotInterval refuses rather than proceeding without mutual exclusion.
 * The harness maps that refusal to a 409, the same shape the API layer
 * returns. In production, validation rejects such input before the lock layer
 * is ever reached; this test pins the lock layer's own backstop.
 *
 * Inputs exercised:
 * - "not-a-date"
 * - "" (empty)
 * - "2024-13-45T99:99:99" (malformed ISO)
 *
 * Expected: 0 successes, 3 refusals (no lock key is ever constructed)
 */

import {
  simulateBookingAttempt,
  generateTestReport,
  logTestStart,
  logTestResult,
  saveJsonReport,
  saveMarkdownReport,
  generateMarkdownReport,
  resetBookingRegistry,
} from "../../utilities/test-helpers.js";
import {
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
    testName: "Invalid Time Format",
    category: "04-validation-scenarios",
    concurrentUsers: 3,
    slotTime: "various-invalid",
    consultantId: "",
    // Unparseable times produce zero 30-minute atoms, and lockSlotInterval
    // refuses a zero-atom interval (fail closed) — the harness reports the
    // refusal as a 409, so all 3 attempts must land in the conflict column.
    expectedSuccesses: 0,
    expectedConflicts: 3,
    expectedErrors: 0,
  };

  const consultantId = generateConsultantId();
  config.consultantId = consultantId;

  logTestStart(config.testName, {
    Category: config.category,
    "Test Cases": "Invalid date string, empty, malformed ISO",
    "Consultant ID": consultantId,
    "Expected Outcome":
      "All 3 refused (unparseable time = zero lock atoms, fail closed)",
  });

  const startTime = Date.now();

  const results: BookingResult[] = await Promise.all([
    simulateBookingAttempt("not-a-date", consultantId, generateUserId(1)),
    simulateBookingAttempt("", consultantId, generateUserId(2)),
    simulateBookingAttempt(
      "2024-13-45T99:99:99",
      consultantId,
      generateUserId(3),
    ),
  ]);

  const duration = Date.now() - startTime;

  const report = generateTestReport(config, results, duration);
  logTestResult(report);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await saveJsonReport(
    report,
    `04-validation-scenarios/test-invalid-time-format-${timestamp}.json`,
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
    `test-invalid-time-format-${timestamp}.md`,
  );

  process.exit(report.passed ? 0 : 1);
}

runTest().catch((error) => {
  console.error("\n❌ Test execution failed:");
  console.error(error);
  process.exit(1);
});
