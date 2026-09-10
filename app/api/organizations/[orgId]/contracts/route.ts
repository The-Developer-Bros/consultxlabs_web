/**
 * GET  /api/organizations/[orgId]/contracts
 * POST /api/organizations/[orgId]/contracts
 *
 * Contracts are the negotiated commercial relationship between an org
 * and Familiarise. Every Program hangs off a Contract; every Invoice
 * optionally references one for audit. Only OWNERs can create contracts
 * — creating one has budget implications and can't be unlocked by a
 * MAINTAINER without an explicit promotion.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const ContractStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "EXPIRED",
  "TERMINATED",
]);

const LicenseCycleSchema = z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]);

const CreateBodySchema = z
  .object({
    billingAccountId: z.string().min(1),
    // PurchaseOrder is optional — India enterprise orgs have
    // requiresPO=true, but we surface the UX constraint at the org
    // level. Server-side we only enforce the FK shape.
    purchaseOrderId: z.string().min(1).nullable().optional(),
    // `effectiveFrom` defaults to now so a contract created via API
    // takes effect immediately unless the caller specifies otherwise.
    effectiveFrom: z.coerce.date().default(() => new Date()),
    effectiveTo: z.coerce.date().nullable().optional(),
    paymentTermsDays: z.coerce.number().int().min(1).max(120).default(60),
    autoRenew: z.coerce.boolean().default(false),
    terms: z.unknown().optional(),
    status: ContractStatusSchema.default("DRAFT"),
    // LICENSE-funded contracts can include a flat-fee BillingSubscription
    // at create time. Both fields are optional and only meaningful when
    // the BillingAccount has fundingSource=LICENSE. When provided, the
    // server creates Contract + BillingSubscription atomically in one tx
    // so the LICENSE commercial value (annual fee + cycle) is recorded.
    licenseModel: z.enum(["FLAT_FEE", "PER_SEAT"]).optional(),
    licenseFeePaise: z.coerce.number().int().min(1).optional(),
    licenseRatePerSeatPaise: z.coerce.number().int().min(1).optional(),
    licenseCycle: LicenseCycleSchema.optional(),
  })
  .refine(
    (v) => v.effectiveTo === null || v.effectiveTo === undefined
      ? true
      : v.effectiveTo.getTime() > v.effectiveFrom.getTime(),
    {
      message: "effectiveTo must be strictly after effectiveFrom",
      path: ["effectiveTo"],
    },
  )
  .refine(
    (v) =>
      // PER_SEAT bills seats × rate, so it needs a per-seat rate and must not
      // carry a flat fee; FLAT_FEE is the reverse. E2E-audit P1 fix — PER_SEAT
      // was unreachable: the create route hardcoded FLAT_FEE.
      v.licenseModel !== "PER_SEAT" ||
      (v.licenseRatePerSeatPaise !== undefined && v.licenseFeePaise === undefined),
    {
      message:
        "PER_SEAT requires licenseRatePerSeatPaise and forbids licenseFeePaise",
      path: ["licenseModel"],
    },
  );

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "contracts.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw
    ? ContractStatusSchema.safeParse(statusRaw)
    : null;

  const contracts = await prisma.contract.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    include: {
      billingAccount: {
        select: { id: true, fundingSource: true, currency: true },
      },
      purchaseOrder: {
        select: { id: true, poNumber: true, status: true },
      },
      programs: {
        select: { id: true, name: true, type: true, status: true },
      },
      subscription: {
        select: {
          id: true,
          model: true,
          cycle: true,
          flatFeePaise: true,
        },
      },
      _count: { select: { programs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: contracts });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Contracts are commercial agreements — nothing should bind the
  // platform to an org that hasn't cleared verification yet.
  const access = await requireOrgAccess(orgId, {
    permission: "contracts.manage",
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

  // BillingAccount ownership check — the caller can only link contracts
  // to a BillingAccount owned by the same org they're admin of. A stolen
  // BillingAccount id from another tenant is rejected here rather than
  // hitting a FK error later.
  const billingAccount = await prisma.billingAccount.findUnique({
    where: { id: body.billingAccountId },
    select: {
      ownerOrgId: true,
      currency: true,
      fundingSource: true,
      subscription: { select: { id: true } },
    },
  });
  if (!billingAccount || billingAccount.ownerOrgId !== orgId) {
    return NextResponse.json(
      { error: "BillingAccount does not belong to this organization" },
      { status: 400 },
    );
  }

  // LICENSE subscription gate: license fields are only meaningful when
  // funding=LICENSE, and we don't currently support overwriting an
  // existing subscription via contract create (renewals are a separate
  // flow). Fail loud rather than silently dropping the operator's input.
  const wantsLicenseSubscription =
    body.licenseFeePaise !== undefined || body.licenseRatePerSeatPaise !== undefined;
  if (wantsLicenseSubscription) {
    if (billingAccount.fundingSource !== "LICENSE") {
      return NextResponse.json(
        {
          error:
            "License fee fields are only allowed when the BillingAccount funding source is LICENSE",
        },
        { status: 400 },
      );
    }
    if (billingAccount.subscription) {
      return NextResponse.json(
        {
          error:
            "A BillingSubscription already exists for this BillingAccount. Subscription updates aren't supported via contract creation yet — terminate the existing subscription first.",
        },
        { status: 409 },
      );
    }
  }

  if (body.purchaseOrderId) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: body.purchaseOrderId },
      select: { organizationId: true },
    });
    if (!po || po.organizationId !== orgId) {
      return NextResponse.json(
        { error: "PurchaseOrder does not belong to this organization" },
        { status: 400 },
      );
    }
  }

  const contract = await prisma.$transaction(async (tx) => {
    const created = await tx.contract.create({
      data: {
        organizationId: orgId,
        billingAccountId: body.billingAccountId,
        purchaseOrderId: body.purchaseOrderId ?? null,
        status: body.status,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
        paymentTermsDays: body.paymentTermsDays,
        autoRenew: body.autoRenew,
      },
    });

    if (wantsLicenseSubscription) {
      const cycleEnd = computeCycleEnd(body.effectiveFrom, body.licenseCycle!);
      const isPerSeat = body.licenseModel === "PER_SEAT";
      await tx.billingSubscription.create({
        data: {
          contractId: created.id,
          billingAccountId: body.billingAccountId,
          model: body.licenseModel ?? "FLAT_FEE",
          cycle: body.licenseCycle!,
          ratePerSeatPaise: isPerSeat
            ? BigInt(body.licenseRatePerSeatPaise!)
            : null,
          flatFeePaise:
            !isPerSeat && body.licenseFeePaise !== undefined
              ? BigInt(body.licenseFeePaise)
              : null,
          activeSeatCount: 0,
          currentCycleStart: body.effectiveFrom,
          currentCycleEnd: cycleEnd,
          nextInvoiceDate: cycleEnd,
          startsAt: body.effectiveFrom,
          endsAt: body.effectiveTo ?? null,
        },
      });
    }

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "CONTRACT",
        action: AUDIT_ACTIONS.CONTRACT.CONTRACT_CREATED,
        description: `Contract created, effective from ${body.effectiveFrom.toISOString()}`,
        details: {
          contractId: created.id,
          billingAccountId: body.billingAccountId,
          paymentTermsDays: body.paymentTermsDays,
          ...(wantsLicenseSubscription
            ? {
                licenseFeePaise: body.licenseFeePaise,
                licenseCycle: body.licenseCycle,
              }
            : {}),
        },
      },
    });
    return created;
  });

  return NextResponse.json({ contract }, { status: 201 });
}

/**
 * Compute the end of a billing cycle given a start date and cycle type.
 * Used to seed BillingSubscription.currentCycleEnd + nextInvoiceDate at
 * contract create time. Mirrors the cycle math elsewhere in the codebase
 * (jobs/billing/generate-subscription-invoices.ts uses the same +1mo /
 * +3mo / +1yr offsets).
 */
function computeCycleEnd(
  start: Date,
  cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL",
): Date {
  const end = new Date(start);
  if (cycle === "MONTHLY") end.setMonth(end.getMonth() + 1);
  else if (cycle === "QUARTERLY") end.setMonth(end.getMonth() + 3);
  else end.setFullYear(end.getFullYear() + 1);
  return end;
}
