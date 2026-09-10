/**
 * Disputes API
 * Handles dispute retrieval and evidence submission
 * Note: Disputes are primarily created via webhooks when payment gateways notify us
 */

import { listDisputes, submitDisputeEvidence } from "@/lib/payments";
import prisma from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import { evidenceDeadlinePassed } from "@/lib/payments/dispute-status";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
// ============================================================================
// Validation Schemas
// ============================================================================

const submitEvidenceSchema = z.object({
  disputeId: z.string().min(1, "Dispute ID is required"),
  evidence: z.object({
    customerName: z.string().optional(),
    customerEmailAddress: z.string().email().optional(),
    customerPurchaseIp: z.string().optional(),
    cancellationPolicy: z.string().optional(),
    cancellationPolicyDisclosure: z.string().optional(),
    cancellationRebuttal: z.string().optional(),
    duplicateChargeId: z.string().optional(),
    duplicateChargeExplanation: z.string().optional(),
    duplicateChargeDocumentation: z.string().optional(),
    productDescription: z.string().optional(),
    receipt: z.string().optional(),
    customerCommunication: z.string().optional(),
    uncategorizedText: z.string().optional(),
    uncategorizedFile: z.string().optional(),
  }),
});

// ============================================================================
// GET /api/payments/disputes - List Disputes
// ============================================================================

export async function GET(req: NextRequest) {
  try {
    // Authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Admin/Staff check
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    // Submitting evidence pushes an irreversible decision to the payment
    // gateway, so it is `disputes.manage` (ADMIN) — not the `disputes.read`
    // that staff hold. The dashboard already told staff this
    // ("As a staff member… you cannot submit evidence") and hid the button;
    // the route contradicted its own UI and accepted the call anyway.
    if (
      !user?.role ||
      !hasBackofficePermission(user.role, "disputes.manage")
    ) {
      return NextResponse.json(
        { error: "Forbidden - Admin access required" },
        { status: 403 },
      );
    }

    // Parse query params
    const searchParams = req.nextUrl.searchParams;
    const gateway = searchParams.get("gateway") as "STRIPE" | "RAZORPAY" | null;
    const limit = parseInt(searchParams.get("limit") || "10");

    if (gateway && gateway !== "STRIPE") {
      return NextResponse.json(
        {
          error:
            "Only Stripe supports direct dispute API. Razorpay disputes are webhook-only.",
        },
        { status: 400 },
      );
    }

    if (gateway === "STRIPE") {
      // Fetch from Stripe API
      const disputes = await listDisputes("STRIPE", limit);

      return NextResponse.json({
        disputes,
        gateway: "STRIPE",
        count: disputes.length,
      });
    } else {
      // List all disputes from database
      const disputes = await prisma.dispute.findMany({
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          payment: {
            include: {
              user: { select: { id: true, email: true, name: true } },
              appointment: { select: { id: true, appointmentType: true } },
            },
          },
        },
      });

      return NextResponse.json({
        disputes: disputes.map((d) => ({
          id: d.id,
          disputeId: d.disputeId,
          amount: d.amountPaise,
          currency: d.currency,
          status: d.status,
          reason: d.reason,
          gateway: d.paymentGateway,
          dueBy: d.dueBy,
          isChargeRefundable: d.isChargeRefundable,
          createdAt: d.createdAt,
          payment: {
            id: d.payment.id,
            amount: d.payment.amount,
            user: d.payment.user,
            appointment: d.payment.appointment,
          },
        })),
        count: disputes.length,
      });
    }
  } catch (error) {
    console.error("Disputes listing error:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "payments" } });

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to list disputes",
      },
      { status: 500 },
    );
  }
}

// ============================================================================
// POST /api/payments/disputes - Submit Evidence
// ============================================================================

export async function POST(req: NextRequest) {
  try {
    // Authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Admin/Staff check
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    // Submitting evidence pushes an irreversible decision to the payment
    // gateway, so it is `disputes.manage` (ADMIN) — not the `disputes.read`
    // that staff hold. The dashboard already told staff this
    // ("As a staff member… you cannot submit evidence") and hid the button;
    // the route contradicted its own UI and accepted the call anyway.
    if (
      !user?.role ||
      !hasBackofficePermission(user.role, "disputes.manage")
    ) {
      return NextResponse.json(
        { error: "Forbidden - Admin access required" },
        { status: 403 },
      );
    }

    // #677/PM-36 — evidence submission is an irreversible gateway push.
    const limited = await applyRateLimit(
      moneyOpsLimiter,
      session.user.id,
    );
    if (limited) return limited;

    // Validate request
    const body = await req.json();
    const { disputeId: dbDisputeId, evidence } =
      submitEvidenceSchema.parse(body);

    // STEP 1: Get dispute and validate OUTSIDE transaction
    const dispute = await prisma.dispute.findUnique({
      where: { id: dbDisputeId },
      include: {
        payment: {
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
    });

    if (!dispute) {
      return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
    }

    // Check if dispute can still accept evidence
    if (
      dispute.status === "WON" ||
      dispute.status === "LOST" ||
      dispute.status === "CHARGE_REFUNDED"
    ) {
      return NextResponse.json(
        { error: "Dispute is already resolved and cannot accept new evidence" },
        { status: 400 },
      );
    }

    // #677/PM-37 — enforce the evidence deadline LOCALLY. Late submissions
    // used to fail only inside Stripe, surfacing as an untyped 500 after the
    // operator had already composed the packet. A typed 410 up front lets
    // the dashboard say "deadline passed" instead of "something broke".
    if (
      evidenceDeadlinePassed({
        status: dispute.status,
        dueBy: dispute.dueBy,
        nowMs: Date.now(),
      })
    ) {
      return NextResponse.json(
        {
          error:
            "The evidence deadline for this dispute has passed. Contact payment-gateway support to resolve it manually.",
          code: "EVIDENCE_DEADLINE_PASSED",
          dueBy: dispute.dueBy?.toISOString() ?? null,
        },
        { status: 410 },
      );
    }

    // Check gateway support
    if (dispute.paymentGateway !== "STRIPE") {
      return NextResponse.json(
        {
          error:
            "Only Stripe supports direct evidence submission. For Razorpay, use the dashboard.",
        },
        { status: 400 },
      );
    }

    // STEP 2: Submit to Stripe OUTSIDE transaction
    // This prevents holding DB connections during potentially slow API calls
    const disputeResult = await submitDisputeEvidence(
      {
        disputeId: dispute.disputeId,
        evidence,
      },
      dispute.paymentGateway,
    );

    // STEP 3: Update database in a small, focused transaction
    await prisma.dispute.update({
      where: { disputeId: dispute.disputeId },
      data: {
        status: disputeResult.status,
        evidence: disputeResult.evidence as Prisma.InputJsonValue,
        // Stamped alongside the evidence itself so the two can never disagree.
        evidenceSubmittedAt: new Date(),
      },
    });

    const result = { dispute, disputeResult };

    return NextResponse.json({
      success: true,
      dispute: {
        id: result.dispute.id,
        disputeId: result.disputeResult.disputeId,
        status: result.disputeResult.status,
        isChargeRefundable: result.disputeResult.isChargeRefundable,
        dueBy: result.disputeResult.dueBy,
      },
      message: "Evidence submitted successfully",
    });
  } catch (error) {
    console.error("Evidence submission error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.errors },
        { status: 400 },
      );
    }

    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "payments" } });

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to submit evidence",
      },
      { status: 500 },
    );
  }
}
