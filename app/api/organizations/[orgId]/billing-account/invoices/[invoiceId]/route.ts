/**
 * GET   /api/organizations/[orgId]/billing-account/invoices/[invoiceId]
 * PATCH /api/organizations/[orgId]/billing-account/invoices/[invoiceId]
 *
 * Invoice status transitions are narrow:
 *   DRAFT → ISSUED      (manual issue; also done by issueImmediately on POST)
 *   DRAFT → CANCELLED   (safe to cancel before send)
 *   ISSUED → PAID       (webhook path — see /pay)
 *   ISSUED → OVERDUE    (cron path; not exposed as an API mutation)
 *   ISSUED → VOID       (credit-note equivalent; refund-worthy)
 *
 * The /pay sub-route handles the webhook → PAID transition. This
 * PATCH only covers manual admin actions that don't need payment
 * gateway integration.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: invoice PATCH covers status transitions (DRAFT → ISSUED, ISSUED → VOID)
// which are finance-team mutations; allow BILLING_ADMIN alongside OWNER.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionOrgInvoice } from "@/lib/enterprise/transitions";

const PatchStatusSchema = z.enum(["ISSUED", "CANCELLED", "VOID"]);

const PatchBodySchema = z
  .object({
    status: PatchStatusSchema.optional(),
    dueDate: z.coerce.date().optional(),
    pdfUrl: z.string().url().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER", canSponsor: true });
  if (access.error) return access.error;

  const invoice = await prisma.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId: orgId },
    include: {
      purchaseOrder: true,
      contract: { select: { id: true, status: true } },
      billedPayments: {
        select: { id: true, amount: true, currency: true, createdAt: true },
      },
      payment: true,
    },
  });
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  return NextResponse.json({ invoice });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, { canSponsor: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.organizationInvoice.findFirst({
        where: { id: invoiceId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Invoice not found"), {
          httpStatus: 404,
        });
      }

      // Route policy — narrower than the global INVOICE_ALLOWED_FROM on
      // purpose: PAID/OVERDUE/REFUNDED are webhook- and cron-owned moves, not
      // manual ones. This pre-check is the friendly error; the CAS below is
      // the race-safe enforcement.
      if (body.status) {
        const allowed: Record<string, string[]> = {
          DRAFT: ["ISSUED", "CANCELLED"],
          ISSUED: ["VOID"],
          OVERDUE: ["VOID"],
          PAID: [],
          VOID: [],
          CANCELLED: [],
        };
        const allowedFromCurrent = allowed[current.status] ?? [];
        if (!allowedFromCurrent.includes(body.status)) {
          throw Object.assign(
            new Error(
              `Cannot transition invoice from ${current.status} to ${body.status}`,
            ),
            { httpStatus: 409 },
          );
        }
      }

      // Invalidate the cached PDF when the invoice transitions out of a
      // sendable state (CANCELLED / VOID) — the next GET …/pdf must
      // regenerate so the watermark + status reflect the change. The
      // refunded path lives on Payment, not OrganizationInvoice, so we
      // don't branch on REFUNDED here.
      const invalidatePdfCache =
        body.status !== undefined &&
        (body.status === "CANCELLED" || body.status === "VOID");

      const restorePoBalance =
        body.status &&
        body.status !== current.status &&
        (body.status === "VOID" || body.status === "CANCELLED") &&
        current.purchaseOrderId !== null;

      if (body.status) {
        // CAS — a concurrent transition (e.g. the dunning cron flipping
        // ISSUED → OVERDUE, or the payment webhook landing PAID) between the
        // pre-check read and this write matches zero rows and 409s instead
        // of voiding a paid invoice.
        await transitionOrgInvoice(tx, {
          where: { id: invoiceId, organizationId: orgId },
          to: body.status,
          data: {
            ...(body.status === "ISSUED" ? { issuedAt: new Date() } : {}),
            ...(body.dueDate !== undefined && { dueDate: body.dueDate }),
            ...(body.pdfUrl !== undefined && { pdfUrl: body.pdfUrl }),
            ...(invalidatePdfCache && {
              pdfStoragePath: null,
              pdfGeneratedAt: null,
            }),
          },
          audit: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "INVOICE",
            action:
              body.status === "ISSUED"
                ? AUDIT_ACTIONS.INVOICE.INVOICE_ISSUED
                : body.status === "CANCELLED"
                  ? AUDIT_ACTIONS.INVOICE.INVOICE_CANCELLED
                  : AUDIT_ACTIONS.INVOICE.INVOICE_VOIDED,
            description: `Invoice ${current.invoiceNumber}: ${current.status} → ${body.status}`,
            details: {
              invoiceId,
              from: current.status,
              to: body.status,
              ...(restorePoBalance && {
                purchaseOrderId: current.purchaseOrderId,
                restoredPaise: current.totalPaise,
              }),
            },
          },
        });

        // PO balance restoration on VOID / CANCELLED. The invoice POST
        // route atomically decremented `PurchaseOrder.remainingAmountPaise`
        // at issue time; when the invoice is now being voided or cancelled,
        // atomically increment the PO balance back so the consumed budget
        // is released. Unbounded increment is safe — we can never overshoot
        // `totalAmountPaise` because we only restore amounts we previously
        // took, and the CAS above guarantees this runs at most once per
        // invoice (VOID/CANCELLED are terminal).
        if (restorePoBalance && current.purchaseOrderId) {
          await tx.purchaseOrder.update({
            where: { id: current.purchaseOrderId },
            data: {
              remainingAmountPaise: { increment: current.totalPaise },
            },
          });
        }
      } else {
        const scalarData = {
          ...(body.dueDate !== undefined && { dueDate: body.dueDate }),
          ...(body.pdfUrl !== undefined && { pdfUrl: body.pdfUrl }),
        };
        if (Object.keys(scalarData).length > 0) {
          await tx.organizationInvoice.update({
            where: { id: invoiceId },
            data: scalarData,
          });
        }
      }

      // updateMany returns no row — re-read in-tx for the response body.
      return tx.organizationInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
    });

    return NextResponse.json({ invoice: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
