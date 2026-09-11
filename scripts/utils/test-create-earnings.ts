/**
 * Test Script: Create Earnings for Testing
 *
 * This script simulates payment completion and creates ConsultantEarning entries
 * without requiring actual Razorpay webhooks. Useful for local development and testing.
 *
 * Usage:
 *   npx tsx scripts/test-create-earnings.ts [options]
 *
 * Options:
 *   --payment-id <id>       Create earnings for a specific payment
 *   --appointment-id <id>   Create payment + earnings for a specific appointment
 *   --all-pending           Create earnings for all SUCCEEDED payments without earnings
 *   --release               Immediately release earnings (bypass hold period)
 *   --dry-run               Show what would be created without making changes
 *
 * Examples:
 *   npx tsx scripts/test-create-earnings.ts --all-pending
 *   npx tsx scripts/test-create-earnings.ts --payment-id pay_xxx --release
 *   npx tsx scripts/test-create-earnings.ts --appointment-id app_xxx
 */

import prisma from "../../lib/prisma";
import { EarningStatus, PaymentStatus, AppointmentsType } from "@prisma/client";
import { PAYOUT_CONSTANTS } from "../../lib/payments/payouts/constants";

// ============================================
// Types
// ============================================

interface CreateEarningsResult {
  success: boolean;
  earningsId?: string;
  paymentId: string;
  consultantProfileId?: string;
  grossAmount: number;
  consultantSharePaise: number;
  platformFeePaise: number;
  status: EarningStatus;
  error?: string;
}

interface ScriptOptions {
  paymentId?: string;
  appointmentId?: string;
  allPending: boolean;
  release: boolean;
  dryRun: boolean;
}

// ============================================
// Helper Functions
// ============================================

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const options: ScriptOptions = {
    allPending: false,
    release: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--payment-id":
        options.paymentId = args[++i];
        break;
      case "--appointment-id":
        options.appointmentId = args[++i];
        break;
      case "--all-pending":
        options.allPending = true;
        break;
      case "--release":
        options.release = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
    }
  }

  return options;
}

function getAppointmentTypeKey(
  type: AppointmentsType,
): "CONSULTATION" | "WEBINAR" | "SUBSCRIPTION" | "CLASS" {
  switch (type) {
    case "CONSULTATION":
      return "CONSULTATION";
    case "WEBINAR":
      return "WEBINAR";
    case "SUBSCRIPTION":
      return "SUBSCRIPTION";
    case "CLASS":
      return "CLASS";
    default:
      return "CONSULTATION";
  }
}

// ============================================
// Core Functions
// ============================================

async function createEarningsForPayment(
  paymentId: string,
  options: { release: boolean; dryRun: boolean },
): Promise<CreateEarningsResult> {
  // Get payment with appointment details
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                include: { consultantProfile: true },
              },
            },
          },
        },
      },
      earnings: true,
    },
  });

  if (!payment) {
    return {
      success: false,
      paymentId,
      grossAmount: 0,
      consultantSharePaise: 0,
      platformFeePaise: 0,
      status: EarningStatus.PENDING,
      error: `Payment not found: ${paymentId}`,
    };
  }

  if (payment.earnings && payment.earnings.length > 0) {
    const firstEarning = payment.earnings[0];
    return {
      success: false,
      paymentId,
      earningsId: firstEarning.id,
      grossAmount: firstEarning.grossAmount,
      consultantSharePaise: firstEarning.consultantSharePaise,
      platformFeePaise: firstEarning.platformFeePaise,
      status: firstEarning.status,
      error: `Earnings already exist for payment ${paymentId}`,
    };
  }

  if (!payment.appointment) {
    return {
      success: false,
      paymentId,
      grossAmount: payment.amount,
      consultantSharePaise: 0,
      platformFeePaise: 0,
      status: EarningStatus.PENDING,
      error: `No appointment linked to payment ${paymentId}`,
    };
  }

  // Get consultant profile from appointment type
  const consultantProfile =
    payment.appointment.consultation?.consultationPlan?.consultantProfile ||
    payment.appointment.subscription?.subscriptionPlan?.consultantProfile ||
    payment.appointment.webinar?.webinarPlan?.consultantProfile ||
    payment.appointment.class?.classPlan?.consultantProfile;

  if (!consultantProfile) {
    return {
      success: false,
      paymentId,
      grossAmount: payment.amount,
      consultantSharePaise: 0,
      platformFeePaise: 0,
      status: EarningStatus.PENDING,
      error: `No consultant profile found for payment ${paymentId}`,
    };
  }

  // Calculate amounts
  const grossAmount = payment.amount;
  const platformFeePaise = Math.round(
    (grossAmount * PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE) / 100,
  );
  const consultantSharePaise = grossAmount - platformFeePaise;

  // Calculate hold period
  const appointmentTypeKey = getAppointmentTypeKey(
    payment.appointment.appointmentType,
  );
  const holdHours = PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentTypeKey];
  const holdUntil = options.release
    ? new Date() // Immediate release
    : new Date(Date.now() + holdHours * 60 * 60 * 1000);

  const status = options.release ? EarningStatus.READY : EarningStatus.PENDING;

  if (options.dryRun) {
    console.log(`[DRY RUN] Would create earnings:`);
    console.log(`  Payment: ${paymentId}`);
    console.log(`  Consultant: ${consultantProfile.id}`);
    console.log(`  Gross: ₹${(grossAmount / 100).toFixed(2)}`);
    console.log(`  Platform Fee: ₹${(platformFeePaise / 100).toFixed(2)}`);
    console.log(`  Consultant Share: ₹${(consultantSharePaise / 100).toFixed(2)}`);
    console.log(`  Status: ${status}`);
    console.log(`  Hold Until: ${holdUntil.toISOString()}`);

    return {
      success: true,
      paymentId,
      consultantProfileId: consultantProfile.id,
      grossAmount,
      consultantSharePaise,
      platformFeePaise,
      status,
    };
  }

  // Create earnings record
  const earnings = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: consultantProfile.id,
      paymentId: payment.id,
      grossAmount,
      platformFeePaise,
      consultantSharePaise,
      status,
      holdUntil,
    },
  });

  return {
    success: true,
    earningsId: earnings.id,
    paymentId,
    consultantProfileId: consultantProfile.id,
    grossAmount,
    consultantSharePaise,
    platformFeePaise,
    status,
  };
}

async function findPendingPayments(): Promise<string[]> {
  const payments = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      earnings: { none: {} },
      appointment: { isNot: null },
    },
    select: { id: true },
  });

  return payments.map((p) => p.id);
}

async function getPaymentForAppointment(
  appointmentId: string,
): Promise<string | null> {
  const payment = await prisma.payment.findFirst({
    where: { appointmentId },
    select: { id: true },
  });

  return payment?.id || null;
}

// ============================================
// Main
// ============================================

async function main(): Promise<void> {
  const options = parseArgs();

  console.log("🧪 Test Create Earnings Script");
  console.log("================================\n");

  if (options.dryRun) {
    console.log("⚠️  DRY RUN MODE - No changes will be made\n");
  }

  if (options.release) {
    console.log("⚡ RELEASE MODE - Earnings will be immediately READY\n");
  }

  let paymentIds: string[] = [];

  // Determine which payments to process
  if (options.paymentId) {
    paymentIds = [options.paymentId];
    console.log(`Processing single payment: ${options.paymentId}`);
  } else if (options.appointmentId) {
    const paymentId = await getPaymentForAppointment(options.appointmentId);
    if (paymentId) {
      paymentIds = [paymentId];
      console.log(
        `Processing payment for appointment: ${options.appointmentId}`,
      );
    } else {
      console.error(
        `❌ No payment found for appointment: ${options.appointmentId}`,
      );
      process.exit(1);
    }
  } else if (options.allPending) {
    paymentIds = await findPendingPayments();
    console.log(
      `Found ${paymentIds.length} SUCCEEDED payments without earnings`,
    );
  } else {
    console.log("Usage:");
    console.log(
      "  npx tsx scripts/test-create-earnings.ts --all-pending [--release] [--dry-run]",
    );
    console.log(
      "  npx tsx scripts/test-create-earnings.ts --payment-id <id> [--release] [--dry-run]",
    );
    console.log(
      "  npx tsx scripts/test-create-earnings.ts --appointment-id <id> [--release] [--dry-run]",
    );
    process.exit(0);
  }

  if (paymentIds.length === 0) {
    console.log("\n✅ No payments to process");
    return;
  }

  console.log(`\nProcessing ${paymentIds.length} payment(s)...\n`);

  const results: CreateEarningsResult[] = [];

  for (const paymentId of paymentIds) {
    const result = await createEarningsForPayment(paymentId, {
      release: options.release,
      dryRun: options.dryRun,
    });

    results.push(result);

    if (result.success) {
      console.log(`✅ ${paymentId}: Created earnings`);
      console.log(
        `   Amount: ₹${(result.grossAmount / 100).toFixed(2)} → Consultant: ₹${(result.consultantSharePaise / 100).toFixed(2)}`,
      );
    } else {
      console.log(`⚠️  ${paymentId}: ${result.error}`);
    }
  }

  // Summary
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  console.log("\n================================");
  console.log("📊 Summary:");
  console.log(`   Total Processed: ${results.length}`);
  console.log(`   Successful: ${successful.length}`);
  console.log(`   Failed/Skipped: ${failed.length}`);

  if (successful.length > 0) {
    const totalConsultantShare = successful.reduce(
      (sum, r) => sum + r.consultantSharePaise,
      0,
    );
    const totalPlatformFee = successful.reduce(
      (sum, r) => sum + r.platformFeePaise,
      0,
    );
    console.log(
      `   Total Consultant Earnings: ₹${(totalConsultantShare / 100).toFixed(2)}`,
    );
    console.log(
      `   Total Platform Fees: ₹${(totalPlatformFee / 100).toFixed(2)}`,
    );
  }
}

main()
  .catch((error) => {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
