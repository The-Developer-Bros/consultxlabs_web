/**
 * Mock Webhook API - Development Only
 *
 * Simulates Razorpay webhook events for local testing without requiring actual
 * payment gateway callbacks. Only works in development environment.
 *
 * Usage:
 *   POST /api/dev/mock-webhook
 *   {
 *     "event": "payment.captured",
 *     "paymentId": "pay_xxx",  // or orderId for order events
 *     "appointmentId": "..."   // optional, for creating payment first
 *   }
 *
 * Supported Events:
 *   - payment.captured: Triggers earnings creation
 *   - order.paid: Same as payment.captured
 *   - refund.created: Marks earnings as refunded
 *   - payout.processed: Marks payout as completed
 *   - payout.rejected: Marks payout as failed
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handlePaymentSuccess } from "@/lib/payments/webhooks/handlers";
import { refundEarnings } from "@/lib/payments/payouts/earnings-service";
import { handlePayoutWebhook } from "@/lib/payments/payouts/payout-service";
import { PaymentGateway, EarningStatus } from "@prisma/client";

// ============================================
// Types
// ============================================

interface MockWebhookRequest {
  event: string;
  paymentId?: string;
  orderId?: string;
  appointmentId?: string;
  payoutId?: string;
  amount?: number;
  release?: boolean; // Immediately release earnings
}

interface MockWebhookResponse {
  success: boolean;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

// ============================================
// Development Check
// ============================================

/**
 * This route reaches `handlePaymentSuccess`, `refundEarnings` and
 * `handlePayoutWebhook` with NO signature and NO authentication. The gate is
 * therefore the only thing standing between the open internet and the money
 * pipeline.
 *
 * It used to also admit `ALLOW_MOCK_WEBHOOKS === "true"`, which meant a single
 * environment variable — one dashboard toggle, one copied .env line — turned a
 * production deployment into an unauthenticated "confirm any payment" endpoint.
 * That disjunct is gone. The gate is now build-time posture only: a production
 * build cannot be opened up by configuration.
 *
 * The `VERCEL_ENV === "preview"` disjunct went the same way, for the same
 * reason: it was a second runtime toggle contradicting the sentence above, and
 * on a preview built against the one shared Supabase project it would have
 * meant an unauthenticated "confirm any payment" endpoint over real rows. It
 * was never load-bearing here — this app deploys on Netlify, which sets no
 * `VERCEL_ENV`, so the branch had been dead since it was written.
 */
function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

// ============================================
// Event Handlers
// ============================================

async function handleMockPaymentCaptured(
  request: MockWebhookRequest,
): Promise<MockWebhookResponse> {
  const { paymentId, orderId, appointmentId, release } = request;

  // Find the payment with appointment details to get consultant ID
  const paymentInclude = {
    appointment: {
      include: {
        consultation: {
          include: {
            consultationPlan: { select: { consultantProfileId: true } },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: { select: { consultantProfileId: true } },
          },
        },
        webinar: {
          include: { webinarPlan: { select: { consultantProfileId: true } } },
        },
        class: {
          include: { classPlan: { select: { consultantProfileId: true } } },
        },
      },
    },
  };

  let payment;
  if (paymentId) {
    payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: paymentInclude,
    });
  } else if (orderId) {
    payment = await prisma.payment.findFirst({
      where: { paymentIntent: orderId },
      include: paymentInclude,
    });
  } else if (appointmentId) {
    payment = await prisma.payment.findFirst({
      where: { appointmentId },
      include: paymentInclude,
    });
  }

  if (!payment) {
    return {
      success: false,
      event: "payment.captured",
      message: "Payment not found",
    };
  }

  // ADR 21 — deliberately NOT flipping paymentStatus here.
  //
  // This used to set SUCCEEDED before calling handlePaymentSuccess below, which
  // meant the pipeline always hit its already-SUCCEEDED early-return and did
  // nothing: no appointment confirmation, no earnings, no journal entry. The
  // mock webhook looked like it worked while exercising none of the code it
  // exists to exercise — and since the only non-seed payments in the database
  // came through this route, that made it a poor proxy for the real flow.
  //
  // The pipeline owns the status transition. Leave the row alone.

  // Extract consultant profile ID from the appointment's plan
  const getConsultantProfileId = () => {
    const apt = payment.appointment;
    if (!apt) return "";
    return (
      apt.consultation?.consultationPlan?.consultantProfileId ||
      apt.subscription?.subscriptionPlan?.consultantProfileId ||
      apt.webinar?.webinarPlan?.consultantProfileId ||
      apt.class?.classPlan?.consultantProfileId ||
      ""
    );
  };

  // Build metadata for handlePaymentSuccess with real IDs
  const metadata: Record<string, string> = {
    appointmentId: payment.appointmentId || "",
    appointmentType: payment.appointment?.appointmentType || "CONSULTATION",
    // #1439 — the schema's key is `userId`; under `consulteeId` every replay
    // failed validation and took the manual-recovery branch instead of
    // confirming the booking.
    userId: payment.userId || "",
    consultantId: getConsultantProfileId(),
  };

  try {
    // Use the same handler as real webhooks
    await handlePaymentSuccess(payment.paymentIntent, metadata);

    // If release flag is set, immediately mark earnings as READY
    if (release) {
      const earningsList = await prisma.consultantEarnings.findMany({
        where: { paymentId: payment.id },
      });

      for (const earning of earningsList) {
        await prisma.consultantEarnings.update({
          where: { id: earning.id },
          data: {
            status: EarningStatus.READY,
            holdUntil: new Date(),
          },
        });
      }
    }

    // Check if earnings were created
    const earnings = await prisma.consultantEarnings.findFirst({
      where: { paymentId: payment.id },
    });

    return {
      success: true,
      event: "payment.captured",
      message: earnings
        ? "Payment captured and earnings created"
        : "Payment captured but no earnings created (may already exist or no consultant found)",
      data: {
        paymentId: payment.id,
        earningsId: earnings?.id,
        earningsCreated: !!earnings,
        released: release || false,
      },
    };
  } catch (error) {
    return {
      success: false,
      event: "payment.captured",
      message:
        error instanceof Error ? error.message : "Failed to process payment",
      data: { paymentId: payment.id },
    };
  }
}

async function handleMockRefund(
  request: MockWebhookRequest,
): Promise<MockWebhookResponse> {
  const { paymentId } = request;

  if (!paymentId) {
    return {
      success: false,
      event: "refund.created",
      message: "paymentId is required",
    };
  }

  const result = await refundEarnings(paymentId);

  return {
    success: result,
    event: "refund.created",
    message: result
      ? "Earnings marked as refunded"
      : "Failed to refund earnings (may not exist or already paid)",
    data: { paymentId },
  };
}

async function handleMockPayoutProcessed(
  request: MockWebhookRequest,
): Promise<MockWebhookResponse> {
  const { payoutId } = request;

  if (!payoutId) {
    return {
      success: false,
      event: "payout.processed",
      message: "payoutId is required",
    };
  }

  // Find payout by ID or providerPayoutId
  const payout = await prisma.consultantPayout.findFirst({
    where: {
      OR: [{ id: payoutId }, { providerPayoutId: payoutId }],
    },
  });

  if (!payout) {
    return {
      success: false,
      event: "payout.processed",
      message: "Payout not found",
    };
  }

  // Use a mock provider payout ID if not set
  const providerPayoutId = payout.providerPayoutId || `mock_pout_${Date.now()}`;

  // Update the payout with the mock provider ID if not set
  if (!payout.providerPayoutId) {
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: { providerPayoutId },
    });
  }

  await handlePayoutWebhook(
    PaymentGateway.RAZORPAY,
    providerPayoutId,
    "COMPLETED",
    undefined,
  );

  return {
    success: true,
    event: "payout.processed",
    message: "Payout marked as completed and earnings marked as paid",
    data: { payoutId: payout.id },
  };
}

async function handleMockPayoutRejected(
  request: MockWebhookRequest,
): Promise<MockWebhookResponse> {
  const { payoutId } = request;

  if (!payoutId) {
    return {
      success: false,
      event: "payout.rejected",
      message: "payoutId is required",
    };
  }

  const payout = await prisma.consultantPayout.findFirst({
    where: {
      OR: [{ id: payoutId }, { providerPayoutId: payoutId }],
    },
  });

  if (!payout) {
    return {
      success: false,
      event: "payout.rejected",
      message: "Payout not found",
    };
  }

  const providerPayoutId = payout.providerPayoutId || `mock_pout_${Date.now()}`;

  // Update the payout with the mock provider ID if not set
  if (!payout.providerPayoutId) {
    await prisma.consultantPayout.update({
      where: { id: payout.id },
      data: { providerPayoutId },
    });
  }

  await handlePayoutWebhook(
    PaymentGateway.RAZORPAY,
    providerPayoutId,
    "FAILED",
    "Mock rejection for testing",
  );

  return {
    success: true,
    event: "payout.rejected",
    message: "Payout marked as failed",
    data: { payoutId: payout.id },
  };
}

// ============================================
// API Handler
// ============================================

export async function POST(request: NextRequest) {
  // Block in production
  if (!isDevelopment()) {
    return NextResponse.json(
      {
        success: false,
        error: "Mock webhooks are only available in development environment",
      },
      { status: 403 },
    );
  }

  try {
    const body = (await request.json()) as MockWebhookRequest;
    const { event } = body;

    if (!event) {
      return NextResponse.json(
        { success: false, error: "event is required" },
        { status: 400 },
      );
    }

    let response: MockWebhookResponse;

    switch (event) {
      case "payment.captured":
      case "order.paid":
        response = await handleMockPaymentCaptured(body);
        break;

      case "refund.created":
      case "refund.processed":
        response = await handleMockRefund(body);
        break;

      case "payout.processed":
        response = await handleMockPayoutProcessed(body);
        break;

      case "payout.rejected":
        response = await handleMockPayoutRejected(body);
        break;

      default:
        response = {
          success: false,
          event,
          message: `Unsupported event: ${event}. Supported: payment.captured, order.paid, refund.created, payout.processed, payout.rejected`,
        };
    }

    return NextResponse.json(response, {
      status: response.success ? 200 : 400,
    });
  } catch (error) {
    console.error("Mock webhook error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  if (!isDevelopment()) {
    return NextResponse.json({ error: "Not available" }, { status: 403 });
  }

  return NextResponse.json({
    name: "Mock Webhook API",
    description: "Simulates payment gateway webhooks for development testing",
    usage: {
      endpoint: "POST /api/dev/mock-webhook",
      events: [
        {
          event: "payment.captured",
          params: "paymentId OR orderId OR appointmentId, optional: release",
          description: "Simulates payment capture and creates earnings",
        },
        {
          event: "order.paid",
          params: "Same as payment.captured",
          description: "Alias for payment.captured",
        },
        {
          event: "refund.created",
          params: "paymentId",
          description: "Marks earnings as refunded",
        },
        {
          event: "payout.processed",
          params: "payoutId",
          description: "Marks payout as completed and earnings as paid",
        },
        {
          event: "payout.rejected",
          params: "payoutId",
          description: "Marks payout as failed",
        },
      ],
    },
    examples: [
      {
        description: "Capture payment and create earnings",
        request: { event: "payment.captured", paymentId: "pay_xxx" },
      },
      {
        description: "Capture and immediately release for payout",
        request: {
          event: "payment.captured",
          appointmentId: "app_xxx",
          release: true,
        },
      },
      {
        description: "Process a payout",
        request: { event: "payout.processed", payoutId: "payout_xxx" },
      },
    ],
  });
}
