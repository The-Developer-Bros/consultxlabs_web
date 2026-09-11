import { faker } from "@faker-js/faker";
import { DisputeStatus, PaymentGateway, Prisma } from "@prisma/client";
import prisma from "../../lib/prisma";

// Dispute status values
const DISPUTE_STATUSES: DisputeStatus[] = [
  "WARNING_NEEDS_RESPONSE",
  "WARNING_UNDER_REVIEW",
  "WARNING_CLOSED",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
  "CHARGE_REFUNDED",
  "WON",
  "LOST",
];

// Dispute reasons
const DISPUTE_REASONS = [
  "fraudulent",
  "product_not_received",
  "product_unacceptable",
  "credit_not_processed",
  "duplicate",
  "subscription_canceled",
  "unrecognized",
  "general",
];

// Human-readable reason descriptions
const REASON_DESCRIPTIONS: Record<string, string> = {
  fraudulent: "Customer claims they did not authorize this transaction",
  product_not_received:
    "Customer claims they did not receive the consultation service",
  product_unacceptable:
    "Customer claims the consultation did not meet expectations",
  credit_not_processed:
    "Customer claims they were promised a refund that was not processed",
  duplicate:
    "Customer claims they were charged multiple times for the same service",
  subscription_canceled:
    "Customer claims they canceled their subscription before being charged",
  unrecognized: "Customer does not recognize this charge",
  general: "General dispute without specific category",
};

/**
 * Generate gateway-specific dispute ID
 */
function generateDisputeId(gateway: PaymentGateway): string {
  switch (gateway) {
    case "STRIPE":
      return `dp_${faker.string.alphanumeric(24)}`;
    case "RAZORPAY":
      return `disp_${faker.string.alphanumeric(14)}`;
    case "CARD":
      return `card_disp_${faker.string.alphanumeric(12)}`;
    default:
      return `disp_${faker.string.alphanumeric(16)}`;
  }
}

/**
 * Generate realistic dispute evidence
 */
function generateEvidence(
  reason: string,
  status: DisputeStatus,
): Record<string, Prisma.JsonValue> {
  const baseEvidence: Record<string, Prisma.JsonValue> = {
    customer_name: faker.person.fullName(),
    customer_email: faker.internet.email(),
    product_description: "Online consultation service",
    billing_address: {
      city: faker.location.city(),
      country: faker.location.countryCode(),
      line1: faker.location.streetAddress(),
      postal_code: faker.location.zipCode(),
    },
  };

  // Add evidence based on reason
  if (reason === "product_not_received" || reason === "product_unacceptable") {
    baseEvidence.service_date = faker.date.recent({ days: 60 }).toISOString();
    baseEvidence.service_documentation =
      "Session notes and recording available";
    baseEvidence.customer_communication = "Pre-session confirmation email sent";
  }

  if (reason === "fraudulent") {
    baseEvidence.customer_signature = faker.datatype.boolean({
      probability: 0.5,
    });
    baseEvidence.customer_ip_address = faker.internet.ip();
    baseEvidence.customer_email_verified = true;
  }

  // Add response evidence for submitted statuses
  if (["UNDER_REVIEW", "WON", "LOST", "CHARGE_REFUNDED"].includes(status)) {
    baseEvidence.submitted_at = faker.date.recent({ days: 14 }).toISOString();
    baseEvidence.evidence_documents = [
      "session_confirmation.pdf",
      "service_agreement.pdf",
      "communication_log.pdf",
    ];
    baseEvidence.uncategorized_text =
      "Customer participated in the scheduled consultation. Session was completed as described. All communications prior to the session indicated customer understood the service.";
  }

  return baseEvidence;
}

import { config } from "./config";

// Dispute volume - configurable via SEED_MODE environment variable
const NUM_DISPUTES = config.volumes.disputes;

export async function createDisputes(): Promise<void> {
  console.log(`Creating ${NUM_DISPUTES} disputes...`);

  // Get succeeded payments that can have disputes (exclude those with existing disputes)
  const eligiblePayments = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      disputes: {
        none: {},
      },
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentGateway: true,
    },
    take: NUM_DISPUTES * 3,
  });

  if (eligiblePayments.length === 0) {
    console.warn("No eligible payments found for dispute creation");
    return;
  }

  let created = 0;

  for (let i = 0; i < Math.min(NUM_DISPUTES, eligiblePayments.length); i++) {
    try {
      const payment = eligiblePayments[i];
      const status = faker.helpers.arrayElement(DISPUTE_STATUSES);
      const reasonCode = faker.helpers.arrayElement(DISPUTE_REASONS);
      const reason = REASON_DESCRIPTIONS[reasonCode];
      const disputeId = generateDisputeId(payment.paymentGateway);
      const evidence = generateEvidence(reasonCode, status);

      // Due date for response (7-21 days from creation for active disputes)
      let dueBy: Date | null = null;
      if (["WARNING_NEEDS_RESPONSE", "NEEDS_RESPONSE"].includes(status)) {
        dueBy = faker.date.soon({
          days: faker.number.int({ min: 7, max: 21 }),
        });
      }

      // Charge refundable status
      const isChargeRefundable = !["CHARGE_REFUNDED", "LOST"].includes(status);

      await prisma.dispute.create({
        data: {
          amountPaise: payment.amount,
          currency: payment.currency,
          reason,
          status,
          disputeId,
          paymentGateway: payment.paymentGateway,
          evidence,
          dueBy,
          isChargeRefundable: isChargeRefundable,
          paymentId: payment.id,
          createdAt: faker.date.recent({ days: 45 }),
        },
      });

      created++;
      if (created % 5 === 0) {
        console.log(`Created ${created} disputes...`);
      }
    } catch (error) {
      console.error(`Failed to create dispute ${i + 1}:`, error);
    }
  }

  console.log(`Created ${created} disputes`);
}
