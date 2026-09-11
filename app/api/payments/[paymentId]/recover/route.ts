/**
 * Payment Recovery Endpoint
 *
 * Admin endpoint to manually trigger appointment creation for payments
 * that succeeded but failed to create appointments due to metadata validation errors.
 *
 * Use case: When webhook metadata is malformed, payment is marked as SUCCEEDED
 * but appointment creation is blocked. This endpoint allows admins to manually
 * provide corrected metadata and retry appointment creation.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentStatus, UserRole } from "@prisma/client";
import { validateWebhookMetadata } from "@/schemas/webhooks/metadata";
import { ZodError } from "zod";

import { getSession } from "@/lib/auth-server";
// ============================================================================
// GET - Fetch payment details for recovery
// ============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  try {
    // Authenticate admin/staff
    const session = await getSession();
    if (
      !session?.user?.id ||
      (session.user.role !== UserRole.ADMIN &&
        session.user.role !== UserRole.STAFF)
    ) {
      return NextResponse.json(
        { error: "Unauthorized - Admin access required" },
        { status: 403 },
      );
    }

    const { paymentId } = await params;

    // Fetch payment with full details
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        user: {
          include: {
            consulteeProfile: true,
          },
        },
        appointment: {
          include: {
            consultation: true,
            subscription: true,
            webinar: true,
            class: true,
          },
        },
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    return NextResponse.json({
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        paymentIntent: payment.paymentIntent,
        paymentStatus: payment.paymentStatus,
        description: payment.description,
        userId: payment.userId,
        appointmentId: payment.appointmentId,
        createdAt: payment.createdAt,
        hasAppointment: !!payment.appointment,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "payments" } });
    console.error("Error fetching payment for recovery:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment details" },
      { status: 500 },
    );
  }
}

// ============================================================================
// POST - Recover payment by creating appointment with corrected metadata
// ============================================================================

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  try {
    // Authenticate admin/staff
    const session = await getSession();
    if (
      !session?.user?.id ||
      (session.user.role !== UserRole.ADMIN &&
        session.user.role !== UserRole.STAFF)
    ) {
      return NextResponse.json(
        { error: "Unauthorized - Admin access required" },
        { status: 403 },
      );
    }

    const { paymentId } = await params;
    const body = await req.json();

    // Validate request body
    if (!body.metadata || typeof body.metadata !== "object") {
      return NextResponse.json(
        { error: "metadata object is required in request body" },
        { status: 400 },
      );
    }

    // Fetch payment
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        user: {
          include: {
            consulteeProfile: true,
          },
        },
        appointment: true,
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Check payment status
    if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
      return NextResponse.json(
        {
          error: `Payment status is ${payment.paymentStatus}. Can only recover SUCCEEDED payments.`,
        },
        { status: 400 },
      );
    }

    // Check if appointment already exists
    if (payment.appointmentId) {
      return NextResponse.json(
        { error: "Payment already has an appointment linked" },
        { status: 400 },
      );
    }

    // Validate metadata
    try {
      validateWebhookMetadata(body.metadata);
    } catch (validationError) {
      const errorMessage =
        validationError instanceof ZodError
          ? validationError.errors
              .map((e) => `${e.path.join(".")}: ${e.message}`)
              .join("; ")
          : validationError instanceof Error
            ? validationError.message
            : String(validationError);

      return NextResponse.json(
        {
          error: "Metadata validation failed",
          details: errorMessage,
        },
        { status: 400 },
      );
    }

    // Import handlePaymentSuccess dynamically to avoid circular dependencies
    const { handlePaymentSuccess } =
      await import("@/lib/payments/webhooks/handlers");

    // Retry appointment creation with corrected metadata
    try {
      await handlePaymentSuccess(payment.paymentIntent, body.metadata);

      // Fetch updated payment
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: {
          appointment: {
            include: {
              consultation: true,
              subscription: true,
              webinar: true,
              class: true,
            },
          },
        },
      });

      return NextResponse.json({
        success: true,
        message: "Payment recovered successfully - appointment created",
        payment: {
          id: updatedPayment?.id,
          appointmentId: updatedPayment?.appointmentId,
          paymentStatus: updatedPayment?.paymentStatus,
        },
        appointment: updatedPayment?.appointment,
      });
    } catch (recoveryError) {
      Sentry.captureException(recoveryError instanceof Error ? recoveryError : new Error(String(recoveryError)), { tags: { subsystem: "payments" } });
      console.error("Error during payment recovery:", recoveryError);
      return NextResponse.json(
        {
          error: "Failed to create appointment",
          details:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Error recovering payment:", error);
    return NextResponse.json(
      { error: "Failed to recover payment" },
      { status: 500 },
    );
  }
}
