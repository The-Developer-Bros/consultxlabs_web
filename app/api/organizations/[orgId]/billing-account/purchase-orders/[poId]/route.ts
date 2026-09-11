/**
 * GET    /api/organizations/[orgId]/billing-account/purchase-orders/[poId]
 * PATCH  /api/organizations/[orgId]/billing-account/purchase-orders/[poId]
 * DELETE /api/organizations/[orgId]/billing-account/purchase-orders/[poId]
 *
 * DELETE is narrow: only POs with no contracts and no invoices can be
 * hard-deleted. Otherwise mark CANCELLED via PATCH.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: PATCH and DELETE on a PO are finance-team mutations; allow
// BILLING_ADMIN alongside OWNER while still excluding MAINTAINER. See
// `lib/auth/billing-admin-gate.ts`.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionPurchaseOrder } from "@/lib/enterprise/transitions";

const PoStatusSchema = z.enum(["ACTIVE", "CLOSED", "CANCELLED"]);

const PatchBodySchema = z
  .object({
    status: PoStatusSchema.optional(),
    poDate: z.coerce.date().optional(),
    validUntil: z.coerce.date().nullable().optional(),
    totalAmountPaise: z.coerce.number().int().min(0).optional(),
    remainingAmountPaise: z.coerce.number().int().min(0).optional(),
    uploadedDocUrl: z.string().url().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; poId: string }>;
  },
) {
  const { orgId, poId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "purchaseOrders.read", canSponsor: true });
  if (access.error) return access.error;

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: poId, organizationId: orgId },
    include: {
      contracts: {
        select: { id: true, status: true, effectiveFrom: true, effectiveTo: true },
      },
      invoices: {
        select: { id: true, invoiceNumber: true, status: true, totalPaise: true },
      },
    },
  });
  if (!po) {
    return NextResponse.json({ error: "PurchaseOrder not found" }, { status: 404 });
  }
  return NextResponse.json({ purchaseOrder: po });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; poId: string }>;
  },
) {
  const { orgId, poId } = await params;
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
      const current = await tx.purchaseOrder.findFirst({
        where: { id: poId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("PurchaseOrder not found"), {
          httpStatus: 404,
        });
      }
      // Money/term fields are only meaningful on an ACTIVE PO — editing them
      // on a CLOSED/CANCELLED row is the same class of bug as terminal-state
      // re-entry, so they share the CAS guard. The doc attachment is plain
      // paperwork and stays editable in any state.
      const moneyOrTermData = {
        ...(body.poDate !== undefined && { poDate: body.poDate }),
        ...(body.validUntil !== undefined && { validUntil: body.validUntil }),
        ...(body.totalAmountPaise !== undefined && {
          totalAmountPaise: body.totalAmountPaise,
        }),
        ...(body.remainingAmountPaise !== undefined && {
          remainingAmountPaise: body.remainingAmountPaise,
        }),
      };
      const docData = {
        ...(body.uploadedDocUrl !== undefined && {
          uploadedDocUrl: body.uploadedDocUrl,
        }),
      };

      if (body.status !== undefined && body.status !== current.status) {
        await transitionPurchaseOrder(tx, {
          where: { id: poId, organizationId: orgId },
          to: body.status,
          data: { ...moneyOrTermData, ...docData },
          audit: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "INVOICE", // PO lifecycle rides the INVOICE category (see OrgAuditCategory)
            action:
              body.status === "CLOSED"
                ? AUDIT_ACTIONS.INVOICE.PURCHASE_ORDER_CLOSED
                : AUDIT_ACTIONS.INVOICE.PURCHASE_ORDER_CANCELLED,
            description: `PurchaseOrder ${poId}: ${current.status} → ${body.status}`,
            details: { poId, from: current.status, to: body.status },
          },
        });
      } else {
        if (Object.keys(moneyOrTermData).length > 0) {
          const res = await tx.purchaseOrder.updateMany({
            where: { id: poId, organizationId: orgId, status: "ACTIVE" },
            data: moneyOrTermData,
          });
          if (res.count === 0) {
            throw Object.assign(
              new Error(
                "PO amounts and dates are immutable once the PO is closed or cancelled",
              ),
              { httpStatus: 409, code: "PO_NOT_ACTIVE" },
            );
          }
        }
        if (Object.keys(docData).length > 0) {
          await tx.purchaseOrder.update({ where: { id: poId }, data: docData });
        }
      }

      // updateMany returns no row — re-read in-tx for the response body.
      return tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    });
    return NextResponse.json({ purchaseOrder: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code && { code }) },
        { status },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; poId: string }>;
  },
) {
  const { orgId, poId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, { canSponsor: true });
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.purchaseOrder.findFirst({
        where: { id: poId, organizationId: orgId },
        include: {
          _count: { select: { contracts: true, invoices: true } },
        },
      });
      if (!current) {
        throw Object.assign(new Error("PurchaseOrder not found"), {
          httpStatus: 404,
        });
      }
      if (current._count.contracts > 0 || current._count.invoices > 0) {
        throw Object.assign(
          new Error(
            "Cannot delete a PO referenced by contracts or invoices. Mark CANCELLED via PATCH instead.",
          ),
          { httpStatus: 409 },
        );
      }
      await tx.purchaseOrder.delete({ where: { id: poId } });
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
