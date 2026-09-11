#!/usr/bin/env node

/**
 * Race Condition Fix Test Script
 *
 * This script tests the slot booking race condition fix by:
 * 1. Testing the distributed locking mechanism directly
 * 2. Verifying only one lock can be acquired at a time
 * 3. Testing lock release and re-acquisition
 *
 * Usage:
 * - npm run scripts:test-race-fix
 * - npx ts-node scripts/test-race-condition-fix.ts
 */

import {
  ApprovalLock,
  lockSlotBooking,
  unlockSlotBooking,
} from "@/utils/appointmentlock";
import { thirtyAfter } from "./race-conditions/utilities/test-helpers.js";


async function testConcurrentLockAcquisition() {
  console.log("\n🧪 TESTING SLOT BOOKING RACE CONDITION FIX");
  console.log("=" + "=".repeat(60) + "\n");

  const consultantId = "test-consultant-123";
  const slotTime = new Date("2025-12-01T10:30:00.000Z").toISOString();

  console.log("📋 Test Configuration:");
  console.log(`   Consultant ID: ${consultantId}`);
  console.log(`   Slot Time: ${slotTime}`);
  console.log(`   Concurrent Attempts: 3`);
  console.log("\n" + "-".repeat(62) + "\n");

  console.log("⚡ TEST 1: Lock Prevents Concurrent Access\n");
  console.log(
    "   Simulating: User A acquires lock, Users B & C try concurrently\n",
  );

  const startTime = Date.now();
  const locks: (ApprovalLock[] | null)[] = [];

  // Step 1: User A successfully acquires the lock (simulating booking in progress)
  console.log("   [User A] Attempting to acquire lock...");
  const lockA = await lockSlotBooking(consultantId, slotTime, thirtyAfter(slotTime), 20000); // 20s TTL
  locks.push(lockA);
  console.log(
    "   [User A] ✅ Lock acquired! Simulating booking process (2s)...\n",
  );

  // Step 2: While User A holds the lock, Users B & C try to acquire (should fail quickly)
  const attemptBPromise = lockSlotBooking(consultantId, slotTime, thirtyAfter(slotTime), 2000) // Short TTL for quick failure
    .then((lock) => {
      locks.push(lock);
      return {
        user: "User B",
        status: "SUCCESS ✅ (BUG!)",
        message: "Lock acquired while User A holds it!",
      };
    })
    .catch((error) => {
      locks.push(null);
      return {
        user: "User B",
        status: "BLOCKED ⚠️",
        message: "Correctly blocked by User A's lock",
      };
    });

  const attemptCPromise = lockSlotBooking(consultantId, slotTime, thirtyAfter(slotTime), 2000) // Short TTL for quick failure
    .then((lock) => {
      locks.push(lock);
      return {
        user: "User C",
        status: "SUCCESS ✅ (BUG!)",
        message: "Lock acquired while User A holds it!",
      };
    })
    .catch((error) => {
      locks.push(null);
      return {
        user: "User C",
        status: "BLOCKED ⚠️",
        message: "Correctly blocked by User A's lock",
      };
    });

  // Wait for Users B & C attempts (they should fail)
  const bcResults = await Promise.all([attemptBPromise, attemptCPromise]);

  // Step 3: User A completes booking and releases lock
  await new Promise((resolve) => setTimeout(resolve, 2000)); // Simulate 2s booking process
  await unlockSlotBooking(lockA);
  console.log("   [User A] Booking completed, lock released\n");

  const totalDuration = Date.now() - startTime;

  // Display results
  console.log("   📊 RESULTS:\n");
  const resultsTable = [
    {
      user: "User A",
      status: "SUCCESS ✅",
      message: "Lock acquired, booking completed",
    },
    ...bcResults,
  ];
  console.table(resultsTable);

  // Clean up any remaining locks
  for (const lock of locks.slice(1)) {
    // Skip first lock (already released)
    if (lock) {
      await unlockSlotBooking(lock);
    }
  }

  // Analyze results
  const successes = resultsTable.filter(
    (r) => r.status.includes("SUCCESS") && !r.status.includes("BUG"),
  ).length;
  const blocked = bcResults.filter((r) => r.status.includes("BLOCKED")).length;

  console.log("\n   " + "-".repeat(58));
  console.log("\n   📈 SUMMARY:\n");
  console.log(`      Total Users: 3`);
  console.log(`      ✅ User A Succeeded:  YES`);
  console.log(`      ⚠️  Users B & C Blocked: ${blocked}/2`);
  console.log(`      ⏱️  Total Time:  ${totalDuration}ms`);

  const test1Passed = blocked === 2;

  if (test1Passed) {
    console.log("\n   ✅ TEST 1 PASSED! User A held lock, B & C were blocked.");
    console.log("      Race condition protection is working!");
  } else {
    console.log(
      "\n   ❌ TEST 1 FAILED! Users B or C acquired lock while A held it!",
    );
    console.log(`      ${2 - blocked} user(s) bypassed the lock (expected: 0)`);
    return false;
  }

  // TEST 2: Lock release and re-acquisition
  console.log("\n" + "=".repeat(62));
  console.log("\n⚡ TEST 2: Lock Release and Re-acquisition\n");

  const lock1 = await lockSlotBooking(consultantId, slotTime, thirtyAfter(slotTime), 5000);
  console.log("   ✅ First lock acquired");

  await unlockSlotBooking(lock1);
  console.log("   🔓 First lock released");

  const lock2 = await lockSlotBooking(consultantId, slotTime, thirtyAfter(slotTime), 5000);
  console.log("   ✅ Second lock acquired (after release)");

  await unlockSlotBooking(lock2);
  console.log("   🔓 Second lock released");

  console.log(
    "\n   ✅ TEST 2 PASSED! Lock release and re-acquisition works.\n",
  );

  // TEST 3: Different slots can be locked simultaneously
  console.log("=".repeat(62));
  console.log("\n⚡ TEST 3: Concurrent Locks on Different Slots\n");

  const slot1 = new Date("2025-12-01T10:00:00.000Z").toISOString();
  const slot2 = new Date("2025-12-01T11:00:00.000Z").toISOString();

  const [lock3, lock4] = await Promise.all([
    lockSlotBooking(consultantId, slot1, thirtyAfter(slot1), 5000),
    lockSlotBooking(consultantId, slot2, thirtyAfter(slot2), 5000),
  ]);

  console.log("   ✅ Lock acquired for slot 10:00");
  console.log("   ✅ Lock acquired for slot 11:00");
  console.log("   ✅ Both locks acquired simultaneously (different slots)");

  await Promise.all([unlockSlotBooking(lock3), unlockSlotBooking(lock4)]);

  console.log("   🔓 Both locks released");
  console.log(
    "\n   ✅ TEST 3 PASSED! Different slots can be locked concurrently.\n",
  );

  return true;
}

async function main() {
  try {
    const allTestsPassed = await testConcurrentLockAcquisition();

    console.log("=".repeat(62));
    console.log("\n🎯 FINAL VERDICT:\n");

    if (allTestsPassed) {
      console.log("   ✅ ALL TESTS PASSED!");
      console.log("   ✅ Race condition fix is working correctly.");
      console.log("   ✅ Distributed locking prevents double-booking.");
      console.log(
        "\n   The slot booking system now properly prevents concurrent",
      );
      console.log(
        "   bookings of the same time slot using Redis-based distributed locks.",
      );
    } else {
      console.log("   ❌ SOME TESTS FAILED!");
      console.log("   ❌ Race condition protection may not be working.");
    }

    console.log("\n" + "=".repeat(62) + "\n");

    process.exit(allTestsPassed ? 0 : 1);
  } catch (error) {
    console.error("\n❌ Test script failed with error:\n");
    console.error(error);
    console.log("\n" + "=".repeat(62) + "\n");
    process.exit(1);
  }
}

// Run the tests
main();
