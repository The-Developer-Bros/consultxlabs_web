/**
 * GET  /api/organizations/[orgId]/billing-account/purchase-orders
 * POST /api/organizations/[orgId]/billing-account/purchase-orders
 *
 * First-class PurchaseOrder surface for India AP 3-way-match workflows
 * (Org.requiresPO=true forces every Contract and Invoice to reference a
 * live PO). Orgs without `requiresPO=true` can still create POs for
 * tracking, but the 3-way match isn't enforced.
 *
 * PO numbers are caller-provided (`poNumber`) because enterprise
 * finance teams issue them from their own AP systems and expect the
 * same number to appear on the invoice. We enforce uniqueness per org.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: PO creation is a finance-team mutation that BILLING_ADMIN should
// be able to perform without escalating to OWNER. The disjunction is
// enforced by `requireOrgBillingAdminOrOwner`; MAINTAINER is intentionally
// excluded — see `lib/auth/billing-admin-gate.ts` for the rationale.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

// #1396 — the `Currency` enum stays on the column (ADR 15 keeps the type), but
// this API refuses to write anything except INR. Nothing downstream compares a
// PO's currency against what is drawn from it: the invoice route decrements
// `remainingAmountPaise` by an INR total, and the dashboard rollup sums
// remainders across currencies. A USD PO was therefore spent in rupees.
const CurrencySchema = z.literal("INR");
const PoStatusSchema = z.enum(["ACTIVE", "CLOSED", "CANCELLED"]);

const CreateBodySchema = z.object({
  poNumber: z.string().min(1).max(64),
  poDate: z.coerce.date(),
  validUntil: z.coerce.date().nullable().optional(),
  totalAmountPaise: z.coerce.number().int().min(0),
  currency: CurrencySchema.default("INR"),
  uploadedDocUrl: z.string().url().nullable().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "purchaseOrders.read", canSponsor: true });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus ? PoStatusSchema.safeParse(rawStatus) : null;

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { invoices: true, contracts: true },
      },
    },
  });

  return NextResponse.json({ data: purchaseOrders });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, {
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Rely on the `(organizationId, poNumber)` unique index to guarantee no
  // duplicates under concurrency. A read-before-write pre-check opens a
  // race window (two simultaneous POSTs can both pass the findFirst and
  // both reach `create`); the DB catches the second one as P2002 but the
  // handler needs to translate that to a 409 rather than letting it
  // surface as a 500.
  try {
    const po = await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          organizationId: orgId,
          poNumber: body.poNumber,
          poDate: body.poDate,
          validUntil: body.validUntil ?? null,
          totalAmountPaise: body.totalAmountPaise,
          // remainingAmountPaise mirrors totalAmountPaise at creation.
          // Invoice issuance doesn't auto-decrement today — we leave
          // that to a follow-up reconciliation pass so the 3-way match
          // can be done strictly or leniently per org policy.
          remainingAmountPaise: body.totalAmountPaise,
          currency: body.currency,
          uploadedDocUrl: body.uploadedDocUrl ?? null,
          status: "ACTIVE",
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "INVOICE",
          action: AUDIT_ACTIONS.INVOICE.PURCHASE_ORDER_CREATED,
          description: `PO ${body.poNumber} created (${body.currency} ${(
            body.totalAmountPaise / 100
          ).toLocaleString()})`,
          details: {
            purchaseOrderId: created.id,
            poNumber: body.poNumber,
            totalAmountPaise: body.totalAmountPaise,
          },
        },
      });

      return created;
    });

    return NextResponse.json({ purchaseOrder: po }, { status: 201 });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: `PO number ${body.poNumber} already exists for this org` },
        { status: 409 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
