import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { getRazorpayClient } from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";

export async function GET(req: NextRequest) {
  try {
    const razorpayClient = getRazorpayClient();
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get payment intent from query parameters
    const { searchParams } = new URL(req.url);
    const paymentIntent = searchParams.get("payment_intent");
    // L4 FIX: Optional sync=true to fetch latest status from Razorpay
    const shouldSync = searchParams.get("sync") === "true";

    if (!paymentIntent) {
      return NextResponse.json(
        { error: "Payment intent ID is required" },
        { status: 400 },
      );
    }

    // Find payment record with appointment details
    const payment = await prisma.payment.findUnique({
      where: { paymentIntent },
      include: {
        user: true,
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: true,
                requestedBy: true,
              },
            },
            subscription: {
              include: {
                subscriptionPlan: true,
                requestedBy: true,
              },
            },
            webinar: {
              include: {
                webinarPlan: true,
              },
            },
            class: {
              include: {
                classPlan: true,
              },
            },
            slotsOfAppointment: true,
          },
        },
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Verify the payment belongs to the authenticated user
    if (payment.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Unauthorized access to payment" },
        { status: 403 },
      );
    }

    // L4 FIX: On-demand sync — fetch latest status from Razorpay API.
    // Placed AFTER ownership check to prevent unauthorized status updates.
    //
    // ADR 21 — this used to flip the row to SUCCEEDED with a bare updateMany,
    // which made the later `payment.captured` webhook short-circuit on its
    // already-SUCCEEDED early-return and skip appointment confirmation,
    // earnings, and the `booking:<paymentId>` journal entry. It now drives the
    // same idempotent pipeline the webhook drives, so a sync can only ever
    // produce the complete outcome or none of it.
    if (
      shouldSync &&
      payment.paymentStatus === "PENDING" &&
      paymentIntent.startsWith("order_") &&
      razorpayClient
    ) {
      try {
        const rzpOrder = await razorpayClient.orders.fetch(paymentIntent);
        if (rzpOrder.status === "paid") {
          // Resolve the captured payment so the parity check and the
          // notes-based routing both see gateway truth, exactly as the
          // webhook does.
          const orderPayments =
            await razorpayClient.orders.fetchPayments(paymentIntent);
          const captured =
            orderPayments.items?.find((p) => p.status === "captured") ??
            orderPayments.items?.[0];

          await routeCapturedPayment({
            orderId: paymentIntent,
            notes: Object.fromEntries(
              Object.entries(captured?.notes ?? rzpOrder.notes ?? {}).map(
                ([k, v]) => [k, String(v)],
              ),
            ),
            amountPaise:
              captured?.amount !== undefined
                ? Number(captured.amount)
                : undefined,
            gatewayPaymentId: captured?.id,
          });

          // Re-read payment to reflect the pipeline's outcome
          const updated = await prisma.payment.findUnique({
            where: { paymentIntent },
          });
          if (updated) {
            (payment as typeof updated).paymentStatus = updated.paymentStatus;
          }
        }
      } catch (syncError) {
        // Non-fatal: the webhook and the stuck-event sweeper remain the durable
        // path. Report so a systematically failing sync is visible rather than
        // silently leaving buyers on a spinner.
        Sentry.captureException(
          syncError instanceof Error ? syncError : new Error(String(syncError)),
          { tags: { subsystem: "payments" } },
        );
        console.warn(
          `Failed to sync payment status from Razorpay for ${paymentIntent}:`,
          syncError,
        );
      }
    }

    // Check payment status
    if (payment.paymentStatus !== "SUCCEEDED") {
      return NextResponse.json(
        {
          error: "Payment not completed",
          status: payment.paymentStatus,
          message: getPaymentStatusMessage(payment.paymentStatus),
        },
        { status: 400 },
      );
    }

    // Get appointment type from appointment or metadata
    let appointmentType = "UNKNOWN";
    if (payment.appointment) {
      appointmentType = payment.appointment.appointmentType;
    }

    // Return success response with appointment details
    return NextResponse.json({
      paymentIntent: payment.paymentIntent,
      appointmentType,
      status: "SUCCEEDED",
      message: "Payment verified successfully",
      appointment: payment.appointment
        ? {
            id: payment.appointment.id,
            type: payment.appointment.appointmentType,
            slots: payment.appointment.slotsOfAppointment,
            consultation: payment.appointment.consultation,
            subscription: payment.appointment.subscription,
            webinar: payment.appointment.webinar,
            class: payment.appointment.class,
          }
        : null,
      amount: payment.amount,
      currency: payment.currency,
      createdAt: payment.createdAt,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "checkout" } },
    );
    console.error("Payment verification error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

function getPaymentStatusMessage(status: string): string {
  switch (status) {
    case "PENDING":
      return "Payment is still being processed. Please wait a few moments and refresh the page.";
    case "FAILED":
      return "Payment failed. Please try again with a different payment method.";
    case "EXPIRED":
      return "Payment session expired. Please start a new checkout.";
    default:
      return "Payment status is unknown. Please contact support.";
  }
}
