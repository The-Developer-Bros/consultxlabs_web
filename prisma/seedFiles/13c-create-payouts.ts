import { faker } from "@faker-js/faker";
import { Currency, PaymentGateway, PayoutMethod } from "@prisma/client";
import prisma from "../../lib/prisma";
import {
  generateBatchId,
  generateIdempotencyKey,
  generateRazorpayPayoutId,
  generateStripePayoutId,
  generatePayoutFailureReason,
  weightedRandom,
  PAYOUT_STATUS_WEIGHTS,
  PAYOUT_PROVIDER_WEIGHTS,
} from "./utils";
import { sumPaise } from "../../lib/payments/utils/money";

/**
 * Determine payout method based on provider
 */
function getPayoutMethod(provider: PaymentGateway): PayoutMethod {
  if (provider === PaymentGateway.STRIPE) {
    return PayoutMethod.STRIPE_TRANSFER;
  }
  // For Razorpay, randomly choose between bank transfer and UPI
  return faker.datatype.boolean({ probability: 0.7 })
    ? PayoutMethod.BANK_TRANSFER
    : PayoutMethod.UPI;
}

/**
 * Generate provider-specific payout ID
 */
function generateProviderPayoutId(provider: PaymentGateway): string {
  if (provider === PaymentGateway.STRIPE) {
    return generateStripePayoutId();
  }
  return generateRazorpayPayoutId();
}

/**
 * Get currency based on provider
 */
function getCurrency(_provider: PaymentGateway): Currency {
  // Always INR. Payouts settle in INR whichever provider carries them —
  // processRazorpayPayout throws on anything else — so seeding USD payouts
  // for Stripe produced rows the real pipeline would reject, and inflated the
  // dashboards that sum payout amounts without grouping by currency.
  return Currency.INR;
}

/**
 * Group earnings by consultant
 */
function groupEarningsByConsultant(
  earnings: Array<{
    id: string;
    consultantProfileId: string;
    consultantSharePaise: number;
  }>,
): Map<string, typeof earnings> {
  const grouped = new Map<string, typeof earnings>();

  for (const earning of earnings) {
    const existing = grouped.get(earning.consultantProfileId) || [];
    existing.push(earning);
    grouped.set(earning.consultantProfileId, existing);
  }

  return grouped;
}

export async function createPayouts(): Promise<void> {
  console.log("Creating payouts...");

  // Get PAID earnings that are not yet linked to a payout
  const paidEarnings = await prisma.consultantEarnings.findMany({
    where: {
      status: "PAID",
      payoutId: null,
    },
    select: {
      id: true,
      consultantProfileId: true,
      consultantSharePaise: true,
    },
  });

  console.log(`Found ${paidEarnings.length} PAID earnings to process`);

  if (paidEarnings.length === 0) {
    console.log("No PAID earnings found without payouts");
    return;
  }

  // Group earnings by consultant
  const earningsByConsultant = groupEarningsByConsultant(paidEarnings);
  console.log(`Grouped into ${earningsByConsultant.size} consultant payouts`);

  // Get admin users for approvedBy field
  const adminUsers = await prisma.user.findMany({
    where: {
      role: "ADMIN",
    },
    select: {
      id: true,
    },
    take: 5,
  });

  let payoutsCreated = 0;
  let earningsLinked = 0;

  // Create a payout for each consultant with PAID earnings
  const consultantEntries = Array.from(earningsByConsultant.entries());
  for (const [consultantProfileId, earnings] of consultantEntries) {
    try {
      // Calculate total amount for this payout
      const totalAmount = earnings.reduce(
        (sum, e) => sum + e.consultantSharePaise,
        0,
      );

      // Determine provider and related fields
      const provider = weightedRandom(PAYOUT_PROVIDER_WEIGHTS);
      const method = getPayoutMethod(provider);
      const currency = getCurrency(provider);
      const status = weightedRandom(PAYOUT_STATUS_WEIGHTS);

      // Generate dates based on status
      const createdAt = faker.date.recent({ days: 30 });
      let processedAt: Date | null = null;
      let approvedAt: Date | null = null;
      let approvedBy: string | null = null;
      let failureReason: string | null = null;
      let retryCount = 0;

      // Set fields based on status
      switch (status) {
        case "COMPLETED":
          approvedAt = new Date(createdAt.getTime() + 1000 * 60 * 60); // 1 hour after creation
          processedAt = new Date(approvedAt.getTime() + 1000 * 60 * 60 * 2); // 2 hours after approval
          approvedBy =
            adminUsers.length > 0
              ? faker.helpers.arrayElement(adminUsers).id
              : null;
          break;
        case "PROCESSING":
          approvedAt = new Date(createdAt.getTime() + 1000 * 60 * 60);
          approvedBy =
            adminUsers.length > 0
              ? faker.helpers.arrayElement(adminUsers).id
              : null;
          break;
        case "APPROVED":
          approvedAt = new Date(createdAt.getTime() + 1000 * 60 * 60);
          approvedBy =
            adminUsers.length > 0
              ? faker.helpers.arrayElement(adminUsers).id
              : null;
          break;
        case "FAILED":
          approvedAt = new Date(createdAt.getTime() + 1000 * 60 * 60);
          processedAt = new Date(approvedAt.getTime() + 1000 * 60 * 60);
          approvedBy =
            adminUsers.length > 0
              ? faker.helpers.arrayElement(adminUsers).id
              : null;
          failureReason = generatePayoutFailureReason();
          retryCount = faker.number.int({ min: 1, max: 3 });
          break;
        // PENDING and CANCELLED don't need additional fields
      }

      // Create the payout
      const payout = await prisma.consultantPayout.create({
        data: {
          consultantProfileId,
          provider,
          providerPayoutId:
            status === "COMPLETED" ||
            status === "PROCESSING" ||
            status === "FAILED"
              ? generateProviderPayoutId(provider)
              : null,
          amount: totalAmount,
          currency,
          status,
          method,
          batchId: generateBatchId(createdAt),
          failureReason,
          retryCount,
          processedAt,
          approvedAt,
          approvedBy,
          idempotencyKey: generateIdempotencyKey(),
          createdAt,
        },
      });

      payoutsCreated++;

      // Link earnings to this payout
      const earningIds = earnings.map((e) => e.id);
      await prisma.consultantEarnings.updateMany({
        where: {
          id: {
            in: earningIds,
          },
        },
        data: {
          payoutId: payout.id,
        },
      });

      earningsLinked += earningIds.length;

      if (payoutsCreated % 10 === 0) {
        console.log(`Created ${payoutsCreated} payouts...`);
      }
    } catch (error) {
      console.error(
        `Failed to create payout for consultant ${consultantProfileId}:`,
        error,
      );
    }
  }

  // Log summary
  console.log(`\nPayouts Summary:`);
  console.log(`  Total payouts created: ${payoutsCreated}`);
  console.log(`  Total earnings linked: ${earningsLinked}`);

  const statusSummary = await prisma.consultantPayout.groupBy({
    by: ["status"],
    _count: true,
    _sum: {
      amount: true,
    },
  });

  console.log("\nPayouts by Status:");
  for (const item of statusSummary) {
    const totalAmount = sumPaise(item._sum.amount);
    console.log(
      `  ${item.status}: ${item._count} payouts (Total: ${(totalAmount / 100).toFixed(2)} INR)`,
    );
  }

  const providerSummary = await prisma.consultantPayout.groupBy({
    by: ["provider"],
    _count: true,
  });

  console.log("\nPayouts by Provider:");
  for (const item of providerSummary) {
    console.log(`  ${item.provider}: ${item._count}`);
  }
}
