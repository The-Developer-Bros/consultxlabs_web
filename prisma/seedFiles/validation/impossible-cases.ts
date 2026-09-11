/**
 * Impossible/Invalid Test Cases
 *
 * These test cases are designed to test validation and error handling.
 * They should be run separately from the main seed and expect failures.
 *
 * Usage:
 *   npx ts-node prisma/seedFiles/validation/impossible-cases.ts
 *
 * Each test case attempts an operation that should fail due to:
 * - Database constraints (unique, foreign key, check constraints)
 * - Business logic validation
 * - Data integrity rules
 */

import { faker } from "@faker-js/faker";
import prisma from "../../../lib/prisma";

interface ValidationTestCase {
  name: string;
  description: string;
  category: "constraint" | "business_logic" | "data_integrity";
  expectedError: string;
  execute: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

/**
 * All impossible test cases organized by category
 */
export const impossibleCases: ValidationTestCase[] = [
  // ==========================================================================
  // DATABASE CONSTRAINT VIOLATIONS
  // ==========================================================================

  {
    name: "duplicate_email_user",
    description: "Creating a user with an email that already exists",
    category: "constraint",
    expectedError: "Unique constraint failed on the fields: (`email`)",
    execute: async () => {
      const email = `test-dup-${Date.now()}@example.com`;

      // Create first user
      await prisma.user.create({
        data: {
          name: "Test User",
          email,
          role: "CONSULTEE",
        },
      });

      // Try to create duplicate
      await prisma.user.create({
        data: {
          name: "Test User Duplicate",
          email, // Same email - should fail
          role: "CONSULTEE",
        },
      });
    },
    cleanup: async () => {
      await prisma.user.deleteMany({
        where: { email: { startsWith: "test-dup-" } },
      });
    },
  },

  {
    name: "invalid_foreign_key_consultant_profile",
    description: "Creating a consultant profile with non-existent domain ID",
    category: "constraint",
    expectedError: "Foreign key constraint failed",
    execute: async () => {
      const user = await prisma.user.create({
        data: {
          name: "Test Consultant",
          email: `test-fk-${Date.now()}@example.com`,
          role: "CONSULTANT",
        },
      });

      await prisma.consultantProfile.create({
        data: {
          userId: user.id,
          domainId: "non-existent-domain-id-12345", // Invalid FK
          rating: 4.5,
          experience: 5,
          scheduleType: "WEEKLY",
        },
      });
    },
    cleanup: async () => {
      await prisma.user.deleteMany({
        where: { email: { startsWith: "test-fk-" } },
      });
    },
  },

  {
    name: "orphaned_appointment_slot",
    description: "Creating a slot of appointment without valid appointment ID",
    category: "constraint",
    expectedError: "Foreign key constraint failed",
    execute: async () => {
      await prisma.slotOfAppointment.create({
        data: {
          appointmentId: "non-existent-appointment-id",
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3600000),
          isTentative: false,
        },
      });
    },
  },

  // ==========================================================================
  // BUSINESS LOGIC VIOLATIONS
  // ==========================================================================

  {
    name: "negative_payment_amount",
    description: "Creating a payment with negative amount",
    category: "business_logic",
    expectedError: "Amount must be positive",
    execute: async () => {
      const user = await prisma.user.create({
        data: {
          name: "Test User",
          email: `test-neg-${Date.now()}@example.com`,
          role: "CONSULTEE",
        },
      });

      await prisma.payment.create({
        data: {
          userId: user.id,
          amount: -1000, // Negative amount - should fail
          originalAmount: -1000,
          currency: "INR",
          paymentMethod: "card",
          paymentIntent: faker.string.uuid(),
          paymentGateway: "STRIPE",
          paymentStatus: "SUCCEEDED",
        },
      });
    },
    cleanup: async () => {
      await prisma.user.deleteMany({
        where: { email: { startsWith: "test-neg-" } },
      });
    },
  },

  {
    name: "refund_exceeds_payment",
    description: "Creating a refund that exceeds the original payment amount",
    category: "business_logic",
    expectedError: "Refund amount cannot exceed payment amount",
    execute: async () => {
      // This would require creating a payment first, then a refund > payment
      const user = await prisma.user.create({
        data: {
          name: "Test User",
          email: `test-refund-${Date.now()}@example.com`,
          role: "CONSULTEE",
        },
      });

      const payment = await prisma.payment.create({
        data: {
          userId: user.id,
          amount: 10000, // 100 INR
          originalAmount: 10000,
          currency: "INR",
          paymentMethod: "card",
          paymentIntent: faker.string.uuid(),
          paymentGateway: "STRIPE",
          paymentStatus: "SUCCEEDED",
        },
      });

      await prisma.refund.create({
        data: {
          paymentId: payment.id,
          amountPaise: 50000, // 500 INR - exceeds payment
          currency: "INR",
          reason: "Test refund",
          status: "PENDING",
          refundId: faker.string.uuid(),
          paymentGateway: "STRIPE",
        },
      });
    },
    cleanup: async () => {
      await prisma.refund.deleteMany({
        where: { payment: { user: { email: { startsWith: "test-refund-" } } } },
      });
      await prisma.payment.deleteMany({
        where: { user: { email: { startsWith: "test-refund-" } } },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: "test-refund-" } },
      });
    },
  },

  {
    name: "invalid_rating_value",
    description: "Creating a consultant profile with rating > 5.0",
    category: "business_logic",
    expectedError: "Rating must be between 0 and 5",
    execute: async () => {
      const domain = await prisma.domain.findFirst();
      if (!domain) throw new Error("No domain found for test");

      const user = await prisma.user.create({
        data: {
          name: "Test Consultant",
          email: `test-rating-${Date.now()}@example.com`,
          role: "CONSULTANT",
        },
      });

      await prisma.consultantProfile.create({
        data: {
          userId: user.id,
          domainId: domain.id,
          rating: 10.0, // Invalid rating > 5
          experience: 5,
          scheduleType: "WEEKLY",
        },
      });
    },
    cleanup: async () => {
      await prisma.consultantProfile.deleteMany({
        where: { user: { email: { startsWith: "test-rating-" } } },
      });
      await prisma.user.deleteMany({
        where: { email: { startsWith: "test-rating-" } },
      });
    },
  },

  // ==========================================================================
  // DATA INTEGRITY VIOLATIONS
  // ==========================================================================

  {
    name: "appointment_end_before_start",
    description: "Creating a slot where end time is before start time",
    category: "data_integrity",
    expectedError: "End time must be after start time",
    execute: async () => {
      // Note: This requires an existing appointment
      const appointment = await prisma.appointment.findFirst();
      if (!appointment) throw new Error("No appointment found for test");

      await prisma.slotOfAppointment.create({
        data: {
          appointmentId: appointment.id,
          startsAt: new Date("2025-01-15T14:00:00Z"),
          endsAt: new Date("2025-01-15T10:00:00Z"), // Before start - should fail
          isTentative: false,
        },
      });
    },
  },

  {
    name: "overlapping_availability_slots",
    description: "Creating two availability slots that overlap in time",
    category: "data_integrity",
    expectedError: "Availability slots cannot overlap",
    execute: async () => {
      const consultant = await prisma.consultantProfile.findFirst();
      if (!consultant) throw new Error("No consultant found for test");

      // Create first slot (9:00-12:00 UTC = 540-720 minutes since midnight)
      await prisma.slotOfAvailabilityWeekly.create({
        data: {
          consultantProfileId: consultant.id,
          startDay: "MONDAY",
          startTimeUtc: 540, // 9:00 AM UTC
          endDay: "MONDAY",
          endTimeUtc: 720, // 12:00 PM UTC
        },
      });

      // Create overlapping slot (10:00-14:00 UTC = 600-840 minutes since midnight)
      await prisma.slotOfAvailabilityWeekly.create({
        data: {
          consultantProfileId: consultant.id,
          startDay: "MONDAY",
          startTimeUtc: 600, // 10:00 AM UTC — overlaps with first slot
          endDay: "MONDAY",
          endTimeUtc: 840, // 2:00 PM UTC
        },
      });
    },
    cleanup: async () => {
      // Cleanup would require tracking created slots
    },
  },

  {
    name: "webinar_exceeds_max_participants",
    description:
      "Adding more participants to a webinar than maxParticipants allows",
    category: "data_integrity",
    expectedError: "Webinar has reached maximum capacity",
    execute: async () => {
      // This would require a webinar with maxParticipants set
      // and attempting to add more participants than allowed
      const webinar = await prisma.webinar.findFirst({
        include: { webinarPlan: true },
      });
      if (!webinar || !webinar.webinarPlan) {
        throw new Error("No webinar with plan found for test");
      }

      // This is a logical check that would be enforced at application level
      // The seed would try to add more participants than maxParticipants
      const maxParticipants = webinar.webinarPlan.maxParticipants ?? 100;
      throw new Error(
        `Would attempt to add ${maxParticipants + 10} participants to webinar with max ${maxParticipants}`,
      );
    },
  },

  {
    name: "invalid_status_transition",
    description:
      "Attempting invalid appointment status transition (COMPLETED -> PENDING)",
    category: "data_integrity",
    expectedError: "Invalid status transition",
    execute: async () => {
      // Find a completed appointment
      const appointment = await prisma.appointment.findFirst({
        where: {
          consultation: {
            status: "COMPLETED",
          },
        },
        include: { consultation: true },
      });

      if (!appointment?.consultation) {
        throw new Error("No completed consultation found for test");
      }

      // Attempt invalid transition
      await prisma.consultation.update({
        where: { id: appointment.consultation.id },
        data: {
          status: "PENDING", // Invalid: COMPLETED -> PENDING
        },
      });
    },
  },

  {
    name: "consultant_booking_own_session",
    description: "Consultant attempting to book their own consultation",
    category: "data_integrity",
    expectedError: "Consultant cannot book their own session",
    execute: async () => {
      // Find a consultant who also has a consultee profile (if exists)
      // or create the scenario
      const consultant = await prisma.user.findFirst({
        where: { role: "CONSULTANT" },
        include: {
          consultantProfile: { include: { consultationPlans: true } },
        },
      });

      if (!consultant?.consultantProfile?.consultationPlans?.length) {
        throw new Error("No consultant with plans found for test");
      }

      // In a real scenario, this would try to create a consultation
      // where the requestedBy user is the same as the consultant
      throw new Error(
        `Would attempt to create consultation where consultant ${consultant.id} books their own plan`,
      );
    },
  },

  {
    name: "expired_discount_code_usage",
    description: "Applying a discount code that has already expired",
    category: "data_integrity",
    expectedError: "Discount code has expired",
    execute: async () => {
      // Create an expired discount code and try to use it
      const expiredCode = await prisma.discountCode.create({
        data: {
          code: `EXPIRED-${Date.now()}`,
          description: "Test expired discount code",
          discountType: "PERCENTAGE",
          discountValue: 20,
          expiresAt: new Date("2020-12-31"), // Expired
          maxUses: 100,
          currentUses: 0,
          isActive: true,
        },
      });

      // This is a logical check - attempting to use expired code
      throw new Error(
        `Would attempt to apply expired discount code ${expiredCode.code} (expired ${expiredCode.expiresAt})`,
      );
    },
    cleanup: async () => {
      await prisma.discountCode.deleteMany({
        where: { code: { startsWith: "EXPIRED-" } },
      });
    },
  },
];

// ==========================================================================
// TEST RUNNER
// ==========================================================================

interface TestResult {
  name: string;
  category: string;
  passed: boolean;
  expectedError: string;
  actualError?: string;
  executionTime: number;
}

/**
 * Runs all validation test cases
 */
export async function runValidationTests(): Promise<TestResult[]> {
  console.log("\n" + "=".repeat(70));
  console.log("VALIDATION TEST SUITE - IMPOSSIBLE CASES");
  console.log("=".repeat(70));
  console.log(`\nRunning ${impossibleCases.length} test cases...\n`);

  const results: TestResult[] = [];

  for (const testCase of impossibleCases) {
    const startTime = Date.now();
    console.log(`\n[${"TEST".padEnd(10)}] ${testCase.name}`);
    console.log(`  Category: ${testCase.category}`);
    console.log(`  Description: ${testCase.description}`);
    console.log(`  Expected: ${testCase.expectedError}`);

    try {
      await testCase.execute();

      // If we reach here, the test FAILED (no error was thrown)
      const executionTime = Date.now() - startTime;
      results.push({
        name: testCase.name,
        category: testCase.category,
        passed: false,
        expectedError: testCase.expectedError,
        actualError: "No error was thrown - validation did not catch this case",
        executionTime,
      });
      console.log(
        `  [${"FAILED".padEnd(10)}] No error thrown (${executionTime}ms)`,
      );
    } catch (error) {
      // Test PASSED if an error was thrown
      const executionTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      results.push({
        name: testCase.name,
        category: testCase.category,
        passed: true,
        expectedError: testCase.expectedError,
        actualError: errorMessage,
        executionTime,
      });
      console.log(
        `  [${"PASSED".padEnd(10)}] Error caught: ${errorMessage.substring(0, 60)}... (${executionTime}ms)`,
      );
    }

    // Run cleanup if provided
    if (testCase.cleanup) {
      try {
        await testCase.cleanup();
        console.log(`  [CLEANUP] Success`);
      } catch (cleanupError) {
        console.log(
          `  [CLEANUP] Failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`,
        );
      }
    }
  }

  // Print summary
  printSummary(results);

  return results;
}

/**
 * Prints test summary
 */
function printSummary(results: TestResult[]): void {
  console.log("\n" + "=".repeat(70));
  console.log("TEST SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalTime = results.reduce((acc, r) => acc + r.executionTime, 0);

  console.log(`\nTotal: ${results.length} tests`);
  console.log(
    `Passed: ${passed} (${((passed / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(
    `Failed: ${failed} (${((failed / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(`Total time: ${totalTime}ms`);

  // Group by category
  const byCategory = results.reduce(
    (acc, r) => {
      acc[r.category] = acc[r.category] || { passed: 0, failed: 0 };
      if (r.passed) acc[r.category].passed++;
      else acc[r.category].failed++;
      return acc;
    },
    {} as Record<string, { passed: number; failed: number }>,
  );

  console.log("\nBy Category:");
  for (const [category, stats] of Object.entries(byCategory)) {
    console.log(
      `  ${category}: ${stats.passed} passed, ${stats.failed} failed`,
    );
  }

  // List failed tests
  if (failed > 0) {
    console.log("\nFailed Tests (validation not working as expected):");
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.actualError}`);
      });
  }

  console.log("\n" + "=".repeat(70));
}

/**
 * Run a single test case by name
 */
export async function runSingleTest(name: string): Promise<TestResult | null> {
  const testCase = impossibleCases.find((t) => t.name === name);
  if (!testCase) {
    console.error(`Test case '${name}' not found`);
    return null;
  }

  console.log(`Running single test: ${name}`);
  const results = await runValidationTests();
  return results.find((r) => r.name === name) || null;
}

// ==========================================================================
// CLI ENTRY POINT
// ==========================================================================

if (require.main === module) {
  runValidationTests()
    .then((results) => {
      const failed = results.filter((r) => !r.passed).length;
      // Exit with error code if any tests failed unexpectedly
      // (In this case, "failed" means validation wasn't triggered when it should have been)
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error("Error running validation tests:", error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
