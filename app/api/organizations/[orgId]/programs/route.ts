/**
 * GET  /api/organizations/[orgId]/programs
 * POST /api/organizations/[orgId]/programs
 *
 * Programs are the commercial primitive — every ProgramAssignment hangs
 * off one. v1 supports LICENSED_SEAT and CREDIT_POOL; PROJECT and
 * RETAINER are reserved in the Prisma enum for v2 but not yet accepted
 * at the create endpoint. See schema.prisma for the full subtype story.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  capabilityOf,
  isReachableOrgFundingPath,
  overageBehaviorUnsupportedReason,
} from "@/lib/enterprise/reachable-paths";
import { sumPaise } from "@/lib/payments/utils/money";

const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

const BillingCycleSchema = z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]);
// TODO(#715): CHARGE_MEMBER and CHARGE_ORG are accepted here and
// `recordBookingUtilization` correctly flags `wasOverage` for bookings
// past the cap, but the downstream financial side effect is still in
// flight — member-side card charge for CHARGE_MEMBER and invoice-accrual
// leg for CHARGE_ORG. Until #715 ships, the safe production grid is
// BLOCK only; the wizard surfaces a WIP banner when either of the other
// two is selected so operators don't ship a silent under-charge.
const OverageBehaviorSchema = z.enum(["BLOCK", "CHARGE_MEMBER", "CHARGE_ORG"]);

// #768 #14/#15 — overage-combo guards shared by both config schemas:
//   - CHARGE_* without a positive maxOveragePerCyclePaise = unbounded
//     runaway liability (the breaker is the only hard stop);
//   - surcharge with BLOCK = dead knob (nothing is ever charged).
const refineOverageCombo = (
  v: {
    overageBehavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
    overageSurchargeBps?: number | null;
    maxOveragePerCyclePaise?: number | null;
  },
  ctx: z.RefinementCtx,
) => {
  if (v.overageBehavior !== "BLOCK") {
    if (v.maxOveragePerCyclePaise == null || v.maxOveragePerCyclePaise < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxOveragePerCyclePaise"],
        message: `overageBehavior=${v.overageBehavior} requires a positive maxOveragePerCyclePaise circuit-breaker ceiling`,
      });
    }
  } else if ((v.overageSurchargeBps ?? 0) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overageSurchargeBps"],
      message:
        "overageSurchargeBps has no effect with overageBehavior=BLOCK — remove it or pick CHARGE_MEMBER/CHARGE_ORG",
    });
  }
};

// Create bodies are discriminated by `type` so the nested config schema
// only accepts the right shape for each subtype. A LICENSED_SEAT body
// with creditPoolConfig fails validation at the edge, not at the DB.
const LicensedSeatConfigSchema = z
  .object({
    ratePerSeatPaise: z.coerce.number().int().min(0),
    cycle: BillingCycleSchema,
    coveredEngagementsPerCycle: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
    overageBehavior: OverageBehaviorSchema.default("BLOCK"),
    priceCapPerEngagementPaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
    // #775 — bps markup on the pass-through overage marginal (null = no markup).
    overageSurchargeBps: z.coerce.number().int().min(0).nullable().optional(),
    // #768 #14/#15 — per-cycle overage ceiling (circuit breaker; null = none).
    maxOveragePerCyclePaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    // Unlimited coverage (null cap) never produces an overage — every overage
    // knob is dead config; reject rather than persist a misleading program.
    if (v.coveredEngagementsPerCycle == null) {
      const deadKnobs: Array<[string, boolean]> = [
        ["overageBehavior", v.overageBehavior !== "BLOCK"],
        ["overageSurchargeBps", (v.overageSurchargeBps ?? 0) > 0],
        ["maxOveragePerCyclePaise", v.maxOveragePerCyclePaise != null],
        ["priceCapPerEngagementPaise", v.priceCapPerEngagementPaise != null],
      ];
      for (const [field, isDead] of deadKnobs) {
        if (isDead) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} has no effect when coveredEngagementsPerCycle is unlimited (null)`,
          });
        }
      }
      return;
    }
    refineOverageCombo(v, ctx);
  });

// 1 credit = ₹1 = 100 paise (fixed; see schema.prisma). The pool resets
// every `cycle`. Premium-tier multipliers were dropped from v1 — bespoke
// per-expert rates live on a Program rate-card override.
//
// TODO(#715, #716): CREDIT_POOL works end-to-end at the schema + lazy-
// debit + reconcile layer, but the refund-back-to-pool path and the
// consolidated-invoice round-trip have not been acceptance-tested
// against a finance-grade tenant yet. The wizard surfaces a WIP banner
// when CREDIT_POOL is picked so operators see the soak status before
// committing a real customer to it.
const CreditPoolConfigSchema = z
  .object({
    cycle: BillingCycleSchema,
    creditBudgetPerCycle: z.coerce.number().int().min(1),
    // #775 — over-budget routing + markup + ceiling (parity with LICENSED_SEAT).
    overageBehavior: OverageBehaviorSchema.default("BLOCK"),
    overageSurchargeBps: z.coerce.number().int().min(0).nullable().optional(),
    maxOveragePerCyclePaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
  })
  // Pool budgets are always finite (creditBudgetPerCycle ≥ 1), so only the shared
  // combo guards apply here.
  .superRefine(refineOverageCombo);

const CreateBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("LICENSED_SEAT"),
    contractId: z.string().min(1),
    name: z.string().min(2).max(120),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).default([]),
    allowedCategories: z.array(z.string()).default([]),
    licensedSeatConfig: LicensedSeatConfigSchema,
    // #751 — explicit operator acknowledgement of overlapping coverage.
    forceOverlap: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("CREDIT_POOL"),
    contractId: z.string().min(1),
    name: z.string().min(2).max(120),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).default([]),
    allowedCategories: z.array(z.string()).default([]),
    creditPoolConfig: CreditPoolConfigSchema,
    forceOverlap: z.boolean().default(false),
  }),
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Read is widened to any ACTIVE org member: LEARNERs legitimately need
  // to see "which programs am I under" (drives the home dashboard,
  // booking UI, and utilization widgets). Mutations (POST below) stay
  // MANAGER+canSponsor — see docs/enterprise/00-foundations/04-roles-and-permissions.md.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    // Hosting-only orgs genuinely do not have programs; surface 404 so
    // the nav treats this as "feature off" rather than "forbidden".
    return NextResponse.json(
      { error: "Organization does not sponsor — no programs to list" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const contractId = url.searchParams.get("contractId") ?? undefined;
  // #777 §B — archived programs are hidden from the active list by default;
  // ?includeArchived=true surfaces them (history view).
  const includeArchived = url.searchParams.get("includeArchived") === "true";

  const programs = await prisma.program.findMany({
    where: {
      contract: { organizationId: orgId },
      ...(contractId && { contractId }),
      ...(!includeArchived && { archivedAt: null }),
    },
    include: {
      licensedSeatConfig: true,
      creditPoolConfig: true,
      _count: { select: { assignments: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // #777 §H — per-program usage across current-cycle assignments, so the list
  // can show a utilization column without a per-row round-trip. Aggregated.
  const now = new Date();
  const usage = programs.length
    ? await prisma.programAssignment.groupBy({
        by: ["programId"],
        // ACTIVE + in-window only: a future (not-yet-started) or
        // cancelled/rolled row would inflate the capacity multiplier the
        // utilization column derives from _count.
        where: {
          programId: { in: programs.map((p) => p.id) },
          status: "ACTIVE",
          periodStart: { lte: now },
          periodEnd: { gte: now },
        },
        _sum: { engagementsUsed: true, consumedPaise: true },
        _count: { _all: true },
      })
    : [];
  const usageByProgram = new Map(usage.map((u) => [u.programId, u]));

  const data = programs.map((p) => {
    const u = usageByProgram.get(p.id);
    return {
      ...p,
      utilization: {
        activeAssignments: u?._count._all ?? 0,
        engagementsUsed: u?._sum.engagementsUsed ?? 0,
        consumedPaise: sumPaise(u?._sum.consumedPaise),
      },
    };
  });

  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "programs.manage",
    canSponsor: true,
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

  // Contract ownership check — same pattern as BillingAccount in
  // /contracts: reject a stolen id from another tenant before we hit
  // the FK layer with a 500. We also pull the parent's billingAccount
  // fundingSource so the reachable-path gate below can reject any
  // (capability x fundingSource x programType) combo the v0 matrix
  // (#768) doesn't sanction before it ever hits the DB.
  const contract = await prisma.contract.findUnique({
    where: { id: body.contractId },
    select: {
      organizationId: true,
      status: true,
      billingAccount: { select: { fundingSource: true } },
    },
  });
  if (!contract || contract.organizationId !== orgId) {
    return NextResponse.json(
      { error: "Contract does not belong to this organization" },
      { status: 400 },
    );
  }
  if (contract.status === "TERMINATED" || contract.status === "EXPIRED") {
    return NextResponse.json(
      { error: `Cannot attach a program to a ${contract.status} contract` },
      { status: 409 },
    );
  }

  // Single gate for every illegal (capability x fundingSource x
  // programType) combo — subsumes the old BOGUS_LICENSE_CREDIT_POOL
  // special-case (the v0 matrix #768 already excludes SPONSOR + LICENSE +
  // CREDIT_POOL). The wizard hides unreachable options; this closes the
  // API loophole so a curious client can't construct one directly.
  const capability = capabilityOf(access.org.canSponsor, access.org.canHost);
  const fundingSource = contract.billingAccount?.fundingSource ?? null;
  if (
    !capability ||
    !isReachableOrgFundingPath(capability, fundingSource, body.type)
  ) {
    return NextResponse.json(
      {
        error: `${body.type} programs are not allowed for a ${capability ?? "non-sponsoring"} organization on a ${fundingSource ?? "unknown"}-funded contract. This combination isn't part of the supported funding matrix.`,
        code: "UNREACHABLE_FUNDING_PATH",
      },
      { status: 400 },
    );
  }

  // #1458 — the matrix above sanctions the funding shape but says nothing about
  // what happens past the cap. CHARGE_MEMBER on a wallet-funded contract only
  // failed at checkout, inside the booking transaction, so the refusal landed on
  // a member who had already picked a slot. Refuse it here instead.
  const overageConfig =
    body.type === "LICENSED_SEAT"
      ? body.licensedSeatConfig
      : body.creditPoolConfig;
  const overageReason = overageBehaviorUnsupportedReason(
    fundingSource,
    overageConfig.overageBehavior,
    // #1458 — the surcharge is part of the rule, not a separate knob: CHARGE_ORG
    // is collectable on a wallet debit only while the marginal stays inside the
    // price that debit took.
    overageConfig.overageSurchargeBps,
  );
  if (overageReason) {
    return NextResponse.json(
      { error: overageReason, code: "INVALID_OVERAGE_CONFIG" },
      { status: 400 },
    );
  }

  // #751 — two ACTIVE programs on the same contract with intersecting
  // coveredPlanTypes make checkout's program resolution ambiguous (the
  // booking lands on whichever resolves first) and can double-entitle a
  // member. An empty coveredPlanTypes covers everything, so it intersects
  // any other program. Refuse unless the operator explicitly forces it.
  if (!body.forceOverlap) {
    const siblings = await prisma.program.findMany({
      where: {
        contractId: body.contractId,
        status: "ACTIVE",
        archivedAt: null,
      },
      select: { id: true, name: true, coveredPlanTypes: true },
    });
    const coversAll = body.coveredPlanTypes.length === 0;
    const overlapping = siblings.filter(
      (s) =>
        coversAll ||
        s.coveredPlanTypes.length === 0 ||
        s.coveredPlanTypes.some((t) => body.coveredPlanTypes.includes(t)),
    );
    if (overlapping.length > 0) {
      return NextResponse.json(
        {
          error: `Coverage overlaps ${overlapping.length} active program(s) on this contract: ${overlapping
            .map((p) => p.name)
            .join(
              ", ",
            )}. Bookings matching both resolve unpredictably. Pass forceOverlap: true to create it anyway.`,
          code: "PROGRAM_COVERAGE_OVERLAP",
          overlappingProgramIds: overlapping.map((p) => p.id),
        },
        { status: 409 },
      );
    }
  }

  const program = await prisma.$transaction(async (tx) => {
    const created = await tx.program.create({
      data: {
        contractId: body.contractId,
        type: body.type,
        name: body.name,
        coveredPlanTypes: body.coveredPlanTypes,
        allowedCategories: body.allowedCategories,
        ...(body.type === "LICENSED_SEAT" && {
          licensedSeatConfig: {
            create: {
              ratePerSeatPaise: body.licensedSeatConfig.ratePerSeatPaise,
              cycle: body.licensedSeatConfig.cycle,
              coveredEngagementsPerCycle:
                body.licensedSeatConfig.coveredEngagementsPerCycle ?? null,
              overageBehavior: body.licensedSeatConfig.overageBehavior,
              priceCapPerEngagementPaise:
                body.licensedSeatConfig.priceCapPerEngagementPaise ?? null,
              overageSurchargeBps:
                body.licensedSeatConfig.overageSurchargeBps ?? null,
              maxOveragePerCyclePaise:
                body.licensedSeatConfig.maxOveragePerCyclePaise ?? null,
            },
          },
        }),
        ...(body.type === "CREDIT_POOL" && {
          creditPoolConfig: {
            create: {
              cycle: body.creditPoolConfig.cycle,
              creditBudgetPerCycle: body.creditPoolConfig.creditBudgetPerCycle,
              overageBehavior: body.creditPoolConfig.overageBehavior,
              overageSurchargeBps:
                body.creditPoolConfig.overageSurchargeBps ?? null,
              maxOveragePerCyclePaise:
                body.creditPoolConfig.maxOveragePerCyclePaise ?? null,
            },
          },
        }),
      },
      include: {
        licensedSeatConfig: true,
        creditPoolConfig: true,
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "PROGRAM",
        action: AUDIT_ACTIONS.PROGRAM.PROGRAM_CREATED,
        description: `Program ${created.name} (${created.type}) created under contract ${body.contractId}`,
        details: {
          programId: created.id,
          contractId: body.contractId,
          type: body.type,
        },
      },
    });

    return created;
  });

  return NextResponse.json({ program }, { status: 201 });
}
