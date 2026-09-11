/**
 * POST /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay
 *
 * Mints a real Razorpay order for an issued invoice and returns the
 * order id + publishable key + amount so the dashboard can open
 * Razorpay's hosted checkout. The order's `notes.type =
 * "invoice_payment"` routes the webhook handler at
 * /api/webhooks/razorpay (see app/api/webhooks/utils.ts#handleOrgPaymentSuccess)
 * to transition the invoice ISSUED → PAID atomically.
 *
 * This endpoint never settles the invoice itself — doing so client-
 * side would leave a race where the client thinks it's paid before
 * Razorpay confirms. The webhook is the only path that mutates
 * invoice.status to PAID.
 *
 * If RAZORPAY_KEY_ID/SECRET are missing (preview / CI / dev), the
 * route returns 503 so the client surfaces a "payment gateway not
 * configured" error instead of opening a popup that can never
 * resolve.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: paying an invoice mints a Razorpay order — finance-team action that
// BILLING_ADMIN should be able to perform without escalating to OWNER.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";
import { PaymentError } from "@/lib/payments/core/types";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, {
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  // #677/PM-36 — pay initiates a gateway order for a statutory document.
  // #1236-triage — per-ACTOR key (see pdf route note).
  const limited = await applyRateLimit(
    moneyOpsLimiter,
    access.member?.id ?? orgId,
  );
  if (limited) return limited;

  const invoice = await prisma.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId: orgId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      paidAt: true,
      providerPaymentOrderId: true,
    },
  });
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (invoice.status === "PAID") {
    return NextResponse.json(
      { error: "Invoice already paid", paidAt: invoice.paidAt },
      { status: 409 },
    );
  }
  if (!["ISSUED", "OVERDUE"].includes(invoice.status)) {
    return NextResponse.json(
      {
        error: `Cannot pay an invoice in ${invoice.status} state`,
        invoiceStatus: invoice.status,
      },
      { status: 409 },
    );
  }

  let razorpayOrderId: string;
  // Idempotent Pay: if we already minted a Razorpay order for this
  // invoice (persisted on OrganizationInvoice.providerPaymentOrderId),
  // reuse it instead of creating another. Without this, every retry of
  // the client popup leaks a fresh order into the gateway.
  if (invoice.providerPaymentOrderId) {
    razorpayOrderId = invoice.providerPaymentOrderId;
    console.log(
      `[invoice/pay] reusing existing Razorpay order ${razorpayOrderId} for invoice ${invoiceId}`,
    );
  } else {
    try {
      const order = await createRazorpayOrder({
        amount: invoice.totalPaise,
        currency: invoice.displayCurrency,
        paymentGateway: "RAZORPAY",
        // PaymentIntentParams.metadata insists on appointmentId/Type for
        // booking flows; invoice payments don't have an appointment so
        // we pass empty strings. The webhook routes purely off
        // `notes.type === "invoice_payment"` + `notes.invoiceId`.
        metadata: {
          appointmentId: "",
          appointmentType: "",
          type: "invoice_payment",
          invoiceId,
          organizationId: orgId,
          invoiceNumber: invoice.invoiceNumber,
        },
      });
      razorpayOrderId = order.id;
    } catch (err) {
      if (err instanceof PaymentError && err.code === "RAZORPAY_NOT_INITIALIZED") {
        Sentry.logger.warn("[invoice/pay] Razorpay gateway not configured", { tags: { subsystem: "enterprise" }, extra: { orgId, invoiceId } });
        return NextResponse.json(
          {
            error:
              "Payment gateway not configured. Set RAZORPAY_KEY_ID and RAZORPAY_SECRET to enable invoice payments.",
            errorType: err.code,
          },
          { status: 503 },
        );
      }
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" }, extra: { orgId, invoiceId } });
      console.error("[invoice/pay] createRazorpayOrder failed:", err);
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Failed to initiate Razorpay order",
          errorType:
            err instanceof PaymentError ? err.code : "RAZORPAY_ORDER_FAILED",
        },
        { status: 502 },
      );
    }

    // Persist the order id + audit log atomically so the next retry
    // sees the order id (and audit writes tie to the gateway side-effect).
    try {
      await prisma.$transaction(async (tx) => {
        await tx.organizationInvoice.update({
          where: { id: invoiceId },
          data: { providerPaymentOrderId: razorpayOrderId },
        });
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
            description: `Payment initiated for invoice ${invoice.invoiceNumber}`,
            details: {
              invoiceId,
              razorpayOrderId,
              totalPaise: invoice.totalPaise,
            },
          },
        });
      });
    } catch (err) {
      // Gateway order already live — log but return it so the client
      // can proceed. The webhook still honours the order on capture.
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" }, extra: { orgId, invoiceId, razorpayOrderId } });
      console.error(
        "[invoice/pay] failed to persist providerPaymentOrderId/audit log:",
        err,
      );
    }
  }

  return NextResponse.json({
    // `razorpayOrderId` (`order_<…>`) drives Razorpay checkout
    // (`new Razorpay({ order_id })`); Razorpay echoes the order's
    // `notes` back on capture so the webhook can route the
    // confirmation without the client forwarding anything itself.
    razorpayOrderId,
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    amountPaise: invoice.totalPaise,
    currency: invoice.displayCurrency,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
    },
  });
}
