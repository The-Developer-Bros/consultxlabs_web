import { faker } from "@faker-js/faker";
import { Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";
import { sumPaise } from "../../lib/payments/utils/money";
import { postLedgerTxn, type Posting } from "../../lib/payments/ledger/post";
import {
  calculatePlatformFee,
  calculateConsultantShare,
  generateHoldUntilDate,
  weightedRandom,
  EARNING_STATUS_WEIGHTS,
} from "./utils";

const paymentInclude = {
  appointment: {
    include: {
      consultation: { include: { consultationPlan: true } },
      subscription: { include: { subscriptionPlan: true } },
      webinar: { include: { webinarPlan: true } },
      class: { include: { classPlan: true } },
    },
  },
} satisfies Prisma.PaymentInclude;

// #780 — Prisma.Result, not GetPayload: money fields are number through the
// extended client; the raw payload type still says bigint.
type PaymentWithAppointment = Prisma.Result<
  typeof prisma.payment,
  { include: typeof paymentInclude },
  "findFirstOrThrow"
>;

/**
 * Extract consultant profile ID from payment's appointment
 */
function getConsultantProfileIdFromPayment(
  payment: PaymentWithAppointment,
): string | null {
  const appointment = payment.appointment;
  if (!appointment) return null;

  // Check each appointment type and get the consultant from the plan
  if (appointment.consultation?.consultationPlan) {
    return appointment.consultation.consultationPlan.consultantProfileId;
  }
  if (appointment.subscription?.subscriptionPlan) {
    return appointment.subscription.subscriptionPlan.consultantProfileId;
  }
  if (appointment.webinar?.webinarPlan) {
    return appointment.webinar.webinarPlan.consultantProfileId;
  }
  if (appointment.class?.classPlan) {
    return appointment.class.classPlan.consultantProfileId;
  }

  return null;
}

/**
 * Generate paidAt date based on holdUntil for PAID status
 */
function generatePaidAtDate(holdUntil: Date): Date {
  // Payment happens 1-5 days after hold period ends
  const daysAfterHold = faker.number.int({ min: 1, max: 5 });
  const paidAt = new Date(holdUntil);
  paidAt.setDate(paidAt.getDate() + daysAfterHold);
  return paidAt;
}

export async function createConsultantEarnings(): Promise<void> {
  console.log("Creating consultant earnings...");

  // Get SUCCEEDED payments without existing earnings records
  const succeededPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      earnings: { none: {} }, // No existing earnings record
      appointment: {
        isNot: null, // Must have an appointment
      },
    },
    include: paymentInclude,
  });

  console.log(
    `Found ${succeededPayments.length} SUCCEEDED payments to process`,
  );

  if (succeededPayments.length === 0) {
    console.warn("No eligible payments found for earnings creation");
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const payment of succeededPayments) {
    try {
      // Get consultant profile ID from the payment's appointment
      const consultantProfileId = getConsultantProfileIdFromPayment(payment);

      if (!consultantProfileId) {
        console.warn(
          `Could not find consultant for payment ${payment.id}, skipping`,
        );
        skipped++;
        continue;
      }

      // Calculate revenue breakdown. #773 — gross is originalAmount (the
      // pre-discount plan price), the same basis createEarningsFromPayment
      // splits on; fee + share == gross by construction (floor + complement).
      const grossAmount = payment.originalAmount;
      const platformFeePaise = calculatePlatformFee(grossAmount);
      const consultantSharePaise = calculateConsultantShare(grossAmount);

      // #773 — a 0-gross payment can't post a balanced journal (no postings),
      // so skip it entirely; an earnings row without a booking txn would keep
      // reconcile's earningsPaymentsWithoutBookingTxn above zero.
      if (grossAmount <= 0) {
        skipped++;
        continue;
      }

      // Assign status based on weighted distribution
      const status = weightedRandom(EARNING_STATUS_WEIGHTS);

      // Calculate hold period (based on payment creation date)
      const holdUntil = generateHoldUntilDate(payment.createdAt);

      // Set paidAt only for PAID status
      const paidAt = status === "PAID" ? generatePaidAtDate(holdUntil) : null;

      // #773 — post the balanced booking journal alongside the earnings row,
      // the same shape (and idempotencyKey) createEarningsFromPayment posts,
      // so a fresh seed reconciles with earningsPaymentsWithoutBookingTxn == 0
      // and zero EARNINGS_LEDGER_DRIFT. Seeded payments carry no PaymentLegs →
      // legacy CASH funding of payment.amount; the DISCOUNT plug absorbs the
      // seeded discount gap (gross + tax − amount), mirroring the service.
      // One tx — a row without its journal (or vice versa) would be drift.
      const taxPaise = payment.taxAmount ?? 0;
      const fundingPaise = payment.amount;
      const discountPaise = Math.max(0, grossAmount + taxPaise - fundingPaise);
      const postings: Posting[] = [];
      const push = (p: Posting) => {
        if (p.amountPaise > 0) postings.push(p);
      };
      push({
        account: { kind: "CASH" },
        direction: "DEBIT",
        amountPaise: fundingPaise,
      });
      push({
        account: { kind: "DISCOUNT" },
        direction: "DEBIT",
        amountPaise: discountPaise,
      });
      push({
        account: { kind: "PLATFORM_FEE" },
        direction: "CREDIT",
        amountPaise: platformFeePaise,
      });
      push({
        account: { kind: "CONSULTANT_PAYABLE", consultantProfileId },
        direction: "CREDIT",
        amountPaise: consultantSharePaise,
      });
      push({
        account: { kind: "GST_PAYABLE" },
        direction: "CREDIT",
        amountPaise: taxPaise,
      });

      await prisma.$transaction(async (tx) => {
        await tx.consultantEarnings.create({
          data: {
            consultantProfileId,
            paymentId: payment.id,
            grossAmount,
            platformFeePaise,
            consultantSharePaise,
            status,
            holdUntil,
            paidAt,
          },
        });
        await postLedgerTxn(tx, {
          idempotencyKey: `booking:${payment.id}`,
          kind: "BOOKING",
          paymentId: payment.id,
          postings,
        });
      });

      created++;
      if (created % 20 === 0) {
        console.log(`Created ${created} earnings records...`);
      }
    } catch (error) {
      console.error(
        `Failed to create earnings for payment ${payment.id}:`,
        error,
      );
      skipped++;
    }
  }

  // Log summary
  console.log(`\nConsultant Earnings Summary:`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped: ${skipped}`);

  const statusSummary = await prisma.consultantEarnings.groupBy({
    by: ["status"],
    _count: true,
    _sum: {
      consultantSharePaise: true,
    },
  });

  console.log("\nEarnings by Status:");
  for (const item of statusSummary) {
    // #780 — groupBy _sum bypasses the result extension: bigint at runtime.
    const totalAmount = sumPaise(item._sum.consultantSharePaise);
    console.log(
      `  ${item.status}: ${item._count} records (Total Share: ${(totalAmount / 100).toFixed(2)} INR)`,
    );
  }
}
