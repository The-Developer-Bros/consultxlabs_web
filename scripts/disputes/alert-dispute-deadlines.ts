/**
 * Dispute Deadline Alerts - Core Logic
 *
 * Finds disputes requiring response with approaching deadlines (within 48h).
 * Logs urgent alerts for disputes that need immediate attention.
 *
 * This catches cases where:
 * - Dispute response deadline is approaching
 * - Admin needs to prepare/submit evidence
 * - Potential financial loss if deadline missed
 *
 * This module exports the core alert function.
 * It is imported by:
 * - jobs/alert-dispute-deadlines.ts (GitHub Actions)
 * - app/api/cleanup/alert-dispute-deadlines/route.ts (API endpoint)
 *
 * Schedule: Hourly
 */

import prisma from "../../lib/prisma";
import { DisputeStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// Alert for disputes due within this many hours
const ALERT_THRESHOLD_HOURS = 48;

export interface DisputeDeadlineAlertResult {
  success: boolean;
  urgentCount: number;
  criticalCount: number;
  disputes: DisputeAlert[];
  timestamp: string;
}

interface DisputeAlert {
  id: string;
  disputeId: string;
  status: DisputeStatus;
  amount: number;
  currency: string;
  reason: string;
  dueBy: Date;
  hoursRemaining: number;
  paymentId: string;
  gateway: string;
  customerEmail?: string;
}

/**
 * Find disputes with approaching deadlines and generate alerts
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function alertDisputeDeadlines(): Promise<DisputeDeadlineAlertResult> {
  return withCronLock("alert-dispute-deadlines", { failMode: "open" }, () =>
    alertDisputeDeadlinesUnlocked(),
  );
}

async function alertDisputeDeadlinesUnlocked(): Promise<DisputeDeadlineAlertResult> {
  const now = new Date();
  const alertThreshold = new Date(
    Date.now() + ALERT_THRESHOLD_HOURS * 60 * 60 * 1000,
  );

  // Find disputes requiring response with deadline within threshold
  const urgentDisputes = await prisma.dispute.findMany({
    where: {
      status: {
        in: [
          DisputeStatus.NEEDS_RESPONSE,
          DisputeStatus.WARNING_NEEDS_RESPONSE,
        ],
      },
      dueBy: {
        gte: now, // Not past due yet
        lte: alertThreshold, // Within alert threshold
      },
    },
    include: {
      payment: {
        include: {
          user: { select: { email: true, name: true } },
          appointment: { select: { id: true } },
        },
      },
    },
    orderBy: { dueBy: "asc" }, // Most urgent first
  });

  console.log(
    `Found ${urgentDisputes.length} disputes with deadlines within ${ALERT_THRESHOLD_HOURS} hours`,
  );

  const disputes: DisputeAlert[] = [];
  let criticalCount = 0;

  for (const dispute of urgentDisputes) {
    const hoursRemaining = Math.round(
      (dispute.dueBy!.getTime() - now.getTime()) / (1000 * 60 * 60),
    );

    const alert: DisputeAlert = {
      id: dispute.id,
      disputeId: dispute.disputeId,
      status: dispute.status,
      amount: dispute.amountPaise,
      currency: dispute.currency,
      reason: dispute.reason,
      dueBy: dispute.dueBy!,
      hoursRemaining,
      paymentId: dispute.paymentId,
      gateway: dispute.paymentGateway,
      customerEmail: dispute.payment.user?.email || undefined,
    };

    disputes.push(alert);

    // Log appropriate alert level
    if (hoursRemaining <= 12) {
      console.log(
        `\n🚨 CRITICAL: Dispute ${dispute.disputeId} due in ${hoursRemaining}h`,
      );
      criticalCount++;
    } else if (hoursRemaining <= 24) {
      console.log(
        `\n⚠️ URGENT: Dispute ${dispute.disputeId} due in ${hoursRemaining}h`,
      );
    } else {
      console.log(
        `\n📋 ALERT: Dispute ${dispute.disputeId} due in ${hoursRemaining}h`,
      );
    }

    console.log(`   Status: ${dispute.status}`);
    console.log(
      `   Amount: ${dispute.currency} ${(dispute.amountPaise / 100).toFixed(2)}`,
    );
    console.log(`   Reason: ${dispute.reason}`);
    console.log(`   Gateway: ${dispute.paymentGateway}`);
    console.log(`   Customer: ${dispute.payment.user?.email || "Unknown"}`);
    console.log(`   Due By: ${dispute.dueBy!.toISOString()}`);
    console.log(`   Time Remaining: ${hoursRemaining} hours`);
  }

  // Also check for past due disputes (should not happen but flag them)
  const pastDueDisputes = await prisma.dispute.findMany({
    where: {
      status: {
        in: [
          DisputeStatus.NEEDS_RESPONSE,
          DisputeStatus.WARNING_NEEDS_RESPONSE,
        ],
      },
      dueBy: {
        lt: now, // Past due
      },
    },
  });

  if (pastDueDisputes.length > 0) {
    console.log(
      `\n🚨🚨🚨 CRITICAL: ${pastDueDisputes.length} PAST DUE disputes found!`,
    );
    for (const dispute of pastDueDisputes) {
      console.log(
        `   - ${dispute.disputeId}: ${dispute.currency} ${(dispute.amountPaise / 100).toFixed(2)} (was due ${dispute.dueBy?.toISOString()})`,
      );
    }
    criticalCount += pastDueDisputes.length;
  }

  // Summary
  console.log("\n📊 Dispute Deadline Alert Summary:");
  console.log(
    `   Urgent disputes (within ${ALERT_THRESHOLD_HOURS}h): ${urgentDisputes.length}`,
  );
  console.log(`   Critical (within 12h or past due): ${criticalCount}`);
  console.log(`   Past due: ${pastDueDisputes.length}`);

  if (criticalCount > 0) {
    console.log("\n🚨 CRITICAL ACTION REQUIRED:");
    console.log(
      "   Some disputes need IMMEDIATE attention to avoid financial loss!",
    );
  }

  return {
    success: true,
    urgentCount: urgentDisputes.length,
    criticalCount,
    disputes,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
