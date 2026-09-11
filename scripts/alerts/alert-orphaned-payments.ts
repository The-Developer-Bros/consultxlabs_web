/**
 * Orphaned Payments Alert - Core Logic
 *
 * Finds payments where status = SUCCEEDED but no appointment exists.
 * These are CRITICAL cases where a customer was charged but got nothing.
 *
 * This catches cases where:
 * - App crash after payment succeeded but before appointment created
 * - Webhook processed payment but appointment creation failed
 * - Race condition between payment and appointment creation
 *
 * This module exports the core alert function.
 * It is imported by:
 * - jobs/alert-orphaned-payments.ts (GitHub Actions)
 * - app/api/cleanup/alert-orphaned-payments/route.ts (API endpoint)
 *
 * Schedule: Every 6 hours
 */

import prisma from "../../lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// Only check payments within the last 7 days
const ALERT_WINDOW_DAYS = 7;

export interface OrphanedPaymentsAlertResult {
  success: boolean;
  totalOrphaned: number;
  criticalCount: number;
  totalAmount: number;
  orphanedPayments: Array<{
    id: string;
    paymentIntent: string | null;
    amount: number;
    currency: string;
    gateway: string;
    userEmail: string | null;
    createdAt: Date;
  }>;
  errors: string[];
  timestamp: string;
}

/**
 * Find succeeded payments without appointments and alert
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function alertOrphanedPayments(): Promise<OrphanedPaymentsAlertResult> {
  return withCronLock("alert-orphaned-payments", { failMode: "open" }, () =>
    alertOrphanedPaymentsUnlocked(),
  );
}

async function alertOrphanedPaymentsUnlocked(): Promise<OrphanedPaymentsAlertResult> {
  const errors: string[] = [];
  let criticalCount = 0;
  let totalAmount = 0;

  const sevenDaysAgo = new Date(
    Date.now() - ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  // Find all succeeded payments without appointments
  const orphanedPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      appointmentId: null,
      createdAt: { gte: sevenDaysAgo },
    },
    include: {
      user: {
        select: { email: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  console.log(
    `Found ${orphanedPayments.length} orphaned payments (SUCCEEDED but no appointment)`,
  );

  // Format for logging and return
  const formattedOrphaned = orphanedPayments.map((payment) => {
    totalAmount += payment.amount;
    criticalCount++;

    // Log each orphaned payment as CRITICAL
    console.error(`CRITICAL: Orphaned payment ${payment.id}`);
    console.error(
      `   User: ${payment.user?.name || "Unknown"} (${payment.user?.email || "no email"})`,
    );
    console.error(
      `   Amount: ${payment.currency} ${(payment.amount / 100).toFixed(2)}`,
    );
    console.error(`   Gateway: ${payment.paymentGateway}`);
    console.error(`   Payment Intent: ${payment.paymentIntent}`);
    console.error(`   Created: ${payment.createdAt.toISOString()}`);
    console.error(`   ACTION REQUIRED: Manual recovery needed!`);
    console.error("");

    return {
      id: payment.id,
      paymentIntent: payment.paymentIntent,
      amount: payment.amount,
      currency: payment.currency,
      gateway: payment.paymentGateway,
      userEmail: payment.user?.email || null,
      createdAt: payment.createdAt,
    };
  });

  // Summary
  if (orphanedPayments.length > 0) {
    console.log("\n========================================");
    console.log("CRITICAL ALERT: ORPHANED PAYMENTS FOUND");
    console.log("========================================");
    console.log(`Total orphaned: ${orphanedPayments.length}`);
    console.log(`Total amount: ${(totalAmount / 100).toFixed(2)}`);
    console.log("These customers were charged but have no appointment!");
    console.log("Manual recovery is required for each case.");
    console.log("========================================\n");
  } else {
    console.log("No orphaned payments found - all payments have appointments.");
  }

  return {
    success: true, // Job itself succeeded, even if orphans found
    totalOrphaned: orphanedPayments.length,
    criticalCount,
    totalAmount,
    orphanedPayments: formattedOrphaned,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
