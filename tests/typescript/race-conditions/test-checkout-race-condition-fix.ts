/**
 * Test: Concurrent Checkout Race Condition Fix
 *
 * PURPOSE:
 * Verify that the tentative appointment creation inside distributed lock
 * prevents duplicate bookings when two users simultaneously checkout the same slot.
 *
 * BACKGROUND:
 * Previous implementation created payment with appointmentId=null during checkout,
 * then created appointment later via webhook. This allowed race conditions because
 * validation checked slotOfAppointment table but payments were invisible.
 *
 * FIX IMPLEMENTED:
 * Now creates tentative appointment (isTentative=true) INSIDE distributed lock,
 * so second user's validation sees the tentative booking and fails.
 *
 * TEST SCENARIO:
 * 1. User A and User B simultaneously click checkout for same consultation slot
 * 2. Both acquire lock with retry mechanism (one waits for other)
 * 3. First user creates tentative appointment + payment
 * 4. Second user's validation inside lock detects tentative booking and fails
 * 5. Verify: Only ONE tentative appointment exists in database
 * 6. Verify: Only ONE payment record exists
 */

import { handleCheckout } from "@/lib/payments/operations/checkout";
import prisma from "@/lib/prisma";
import { CheckoutInput } from "@/schemas/checkout";
import { PaymentStatus } from "@prisma/client";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_CONFIG = {
  // Update these IDs based on your database
  PLAN_ID: "clx123...", // Replace with actual consultation plan ID
  CONSULTANT_PROFILE_ID: "clx456...", // Replace with actual consultant profile ID
  USER_A_ID: "user_a_id", // Replace with actual user ID
  USER_B_ID: "user_b_id", // Replace with another user ID

  // Test slot time (ensure this is in the future and doesn't overlap with real bookings)
  SLOT_START: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
  SLOT_END: new Date(
    Date.now() + 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
  ).toISOString(), // Tomorrow + 1 hour
};

// ============================================================================
// Test Data
// ============================================================================

const createCheckoutInput = (userId: string): CheckoutInput => ({
  appointmentType: "CONSULTATION",
  planId: TEST_CONFIG.PLAN_ID,
  startsAt: TEST_CONFIG.SLOT_START,
  endsAt: TEST_CONFIG.SLOT_END,
  notes: `Test checkout for user ${userId}`,
  paymentGateway: "STRIPE",
});

// ============================================================================
// Test Execution
// ============================================================================

async function testConcurrentCheckout() {
  console.log("\n🧪 Starting Concurrent Checkout Race Condition Test\n");
  console.log("=".repeat(80));

  try {
    // Cleanup: Delete any existing test data
    console.log("\n🧹 Cleaning up test data...");
    await cleanupTestData();

    // Test: Concurrent checkout attempts
    console.log("\n🚀 Simulating concurrent checkout by User A and User B...");
    console.log(`Slot: ${TEST_CONFIG.SLOT_START} to ${TEST_CONFIG.SLOT_END}`);

    const checkoutA = handleCheckout(
      createCheckoutInput("A"),
      TEST_CONFIG.USER_A_ID,
      true, // isMockPayment = true for testing
    );

    const checkoutB = handleCheckout(
      createCheckoutInput("B"),
      TEST_CONFIG.USER_B_ID,
      true, // isMockPayment = true for testing
    );

    // Execute both checkouts concurrently
    const results = await Promise.allSettled([checkoutA, checkoutB]);

    console.log("\n📊 Checkout Results:");
    console.log("-".repeat(80));

    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failureCount = results.filter((r) => r.status === "rejected").length;

    results.forEach((result, index) => {
      const user = index === 0 ? "User A" : "User B";
      if (result.status === "fulfilled") {
        console.log(`✅ ${user}: SUCCESS`);
        console.log(`   Payment Intent: ${result.value.paymentIntent?.id ?? "N/A"}`);
      } else {
        console.log(`❌ ${user}: FAILED`);
        console.log(`   Error: ${result.reason.message}`);
      }
    });

    console.log("\n" + "-".repeat(80));
    console.log(`Summary: ${successCount} succeeded, ${failureCount} failed`);

    // Verify: Database state
    console.log("\n🔍 Verifying Database State:");
    console.log("-".repeat(80));

    const appointments = await prisma.appointment.findMany({
      where: {
        slotsOfAppointment: {
          some: {
            startsAt: new Date(TEST_CONFIG.SLOT_START),
          },
        },
      },
      include: {
        slotsOfAppointment: true,
        consultation: true,
      },
    });

    console.log(`📋 Appointments found: ${appointments.length}`);
    appointments.forEach((apt, idx) => {
      console.log(`   [${idx + 1}] ID: ${apt.id}`);
      console.log(`       Type: ${apt.appointmentType}`);
      console.log(`       Slots: ${apt.slotsOfAppointment.length}`);
      apt.slotsOfAppointment.forEach((slot) => {
        console.log(`         - ${slot.startsAt} to ${slot.endsAt}`);
        console.log(`           Tentative: ${slot.isTentative}`);
      });
    });

    const payments = await prisma.payment.findMany({
      where: {
        userId: { in: [TEST_CONFIG.USER_A_ID, TEST_CONFIG.USER_B_ID] },
        createdAt: { gte: new Date(Date.now() - 60 * 1000) }, // Last minute
      },
      include: {
        appointment: true,
      },
    });

    console.log(`\n💳 Payments found: ${payments.length}`);
    payments.forEach((payment, idx) => {
      console.log(`   [${idx + 1}] Intent: ${payment.paymentIntent}`);
      console.log(`       User: ${payment.userId}`);
      console.log(`       Status: ${payment.paymentStatus}`);
      console.log(`       Appointment: ${payment.appointmentId || "null"}`);
    });

    // Test Assertions
    console.log("\n✅ Test Assertions:");
    console.log("-".repeat(80));

    const assertions = [
      {
        condition: successCount === 1,
        message: `Exactly ONE checkout should succeed (actual: ${successCount})`,
      },
      {
        condition: failureCount === 1,
        message: `Exactly ONE checkout should fail (actual: ${failureCount})`,
      },
      {
        condition: appointments.length === 1,
        message: `Exactly ONE appointment should exist (actual: ${appointments.length})`,
      },
      {
        condition:
          appointments.length > 0 &&
          appointments[0].slotsOfAppointment.every(
            (s) => s.isTentative === false,
          ),
        message: `Appointment slots should be confirmed (isTentative=false)`,
      },
      {
        condition: payments.length === 1,
        message: `Exactly ONE payment should exist (actual: ${payments.length})`,
      },
      {
        condition:
          payments.length > 0 &&
          payments[0].paymentStatus === PaymentStatus.SUCCEEDED,
        message: `Payment status should be SUCCEEDED`,
      },
    ];

    let allPassed = true;
    assertions.forEach((assertion, idx) => {
      const status = assertion.condition ? "✅ PASS" : "❌ FAIL";
      console.log(`${idx + 1}. ${status}: ${assertion.message}`);
      if (!assertion.condition) allPassed = false;
    });

    console.log("\n" + "=".repeat(80));
    if (allPassed) {
      console.log(
        "🎉 ALL TESTS PASSED - Race condition fix is working correctly!",
      );
    } else {
      console.log("❌ SOME TESTS FAILED - Race condition fix needs review");
    }
    console.log("=".repeat(80) + "\n");

    // Cleanup
    console.log("\n🧹 Cleaning up test data...");
    await cleanupTestData();
    console.log("✅ Cleanup complete");

    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error("\n💥 Test execution failed:", error);
    await cleanupTestData();
    process.exit(1);
  }
}

async function cleanupTestData() {
  // Delete test payments
  await prisma.payment.deleteMany({
    where: {
      userId: { in: [TEST_CONFIG.USER_A_ID, TEST_CONFIG.USER_B_ID] },
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // Last hour
    },
  });

  // Delete test appointments for the slot
  const appointments = await prisma.appointment.findMany({
    where: {
      slotsOfAppointment: {
        some: {
          startsAt: new Date(TEST_CONFIG.SLOT_START),
        },
      },
    },
    include: {
      consultation: true,
    },
  });

  for (const appointment of appointments) {
    if (appointment.consultation) {
      await prisma.consultation.delete({
        where: { id: appointment.consultation.id },
      });
    }
    await prisma.slotOfAppointment.deleteMany({
      where: { appointmentId: appointment.id },
    });
    await prisma.appointment.delete({
      where: { id: appointment.id },
    });
  }
}

// ============================================================================
// Run Test
// ============================================================================

testConcurrentCheckout();
