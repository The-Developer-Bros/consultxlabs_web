/**
 * GET  /api/organizations/[orgId]/rate-cards
 * POST /api/organizations/[orgId]/rate-cards
 *
 * Org-scoped rate cards govern the 3-way split (platform / org / consultant)
 * in basis points. Bps are integer — no float drift — and must sum to 10000.
 *
 * A RateCard is never mutated after creation; a "change" rotates via
 * `bumpRateCard` in lib/api/organizations/rate-card.ts, which closes the
 * previous card's `effectiveTo` and creates a new row with `effectiveFrom =
 * now()`. This preserves the historical split each earning was settled
 * against — see `OrganizationEarnings.platformBpsApplied`.
 *
 * #1335 — a card scoped to a contract, planType or planId is only selected at
 * settlement when `RATE_CARD_SCOPED_RESOLUTION=on`; off (the default), the org
 * default card settles instead. Creation is unaffected either way.
 *
 * Query params on GET:
 *   scope=current|all           (default current — live cards only)
 *   planType=CONSULTATION|CLASS|WEBINAR|SUBSCRIPTION
 *   planId=<plan id>
 *   contractId=<contract id>    org-scoped by default; narrow via contractId
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: rate card creation/edit is a finance-team mutation; downgrade
// from OWNER-only so BILLING_ADMIN can configure splits without escalation.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { bumpRateCard } from "@/lib/api/organizations/rate-card";

const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

const QuerySchema = z.object({
  scope: z.enum(["current", "all"]).default("current"),
  planType: CoveredPlanTypeSchema.optional(),
  planId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
});

const CreateBodySchema = z
  .object({
    contractId: z.string().uuid().nullable().optional(),
    planType: CoveredPlanTypeSchema.nullable().optional(),
    planId: z.string().uuid().nullable().optional(),
    platformBps: z.coerce.number().int().min(0).max(10_000),
    orgBps: z.coerce.number().int().min(0).max(10_000),
    consultantBps: z.coerce.number().int().min(0).max(10_000),
    effectiveAt: z.coerce.date().optional(),
    minGrossPaise: z.coerce.number().int().min(0).nullable().optional(),
    maxGrossPaise: z.coerce.number().int().min(0).nullable().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.platformBps + v.orgBps + v.consultantBps === 10_000, {
    message: "platformBps + orgBps + consultantBps must equal 10000",
  });

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Read access widened to any ACTIVE member of a canHost org. Rate
  // cards encode the org's revenue-split policy (e.g. "consultants
  // earn 80%"), which the consultant rightly needs to know — keeping
  // the GET MANAGER-gated meant an EXPERT had no way to confirm their
  // commission. Mutations (POST + bumpRateCard) stay OWNER-gated.
  const access = await requireOrgAccess(orgId, { canHost: true });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsedQuery = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsedQuery.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsedQuery.data;

  // When filtering by contractId, verify the contract belongs to this
  // org. This prevents a caller from enumerating foreign rate cards by
  // guessing contract ids.
  if (q.contractId) {
    const contract = await prisma.contract.findFirst({
      where: { id: q.contractId, organizationId: orgId },
      select: { id: true },
    });
    if (!contract) {
      return NextResponse.json(
        { error: "Contract not found for this organization" },
        { status: 404 },
      );
    }
  }

  const now = new Date();

  const rateCards = await prisma.rateCard.findMany({
    where: {
      ...(q.contractId
        ? { ownerContractId: q.contractId }
        : { ownerOrgId: orgId }),
      ...(q.planType !== undefined && { planType: q.planType }),
      ...(q.planId !== undefined && { planId: q.planId }),
      ...(q.scope === "current" && {
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      }),
    },
    orderBy: [{ effectiveFrom: "desc" }],
  });

  return NextResponse.json({ data: rateCards });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, { canHost: true });
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

  try {
    // #1405 — bumpRateCard is read-then-write (findEffective → close the open
    // card → insert the replacement). Under the default isolation two
    // concurrent bumps on one scope each read "no card open yet" and each
    // insert with `effectiveTo = null`, after which `findEffective` picks
    // between the two open windows non-deterministically. Serializable makes
    // that interleaving abort, and withSerializableRetry re-runs the loser
    // the way checkout does rather than surfacing P2034 to the caller.
    const card = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Cross-org check: contract must belong to this org when scoping
          // the card to a contract.
          if (body.contractId) {
            const contract = await tx.contract.findFirst({
              where: { id: body.contractId, organizationId: orgId },
              select: { id: true },
            });
            if (!contract) {
              throw Object.assign(
                new Error("Contract not found for this organization"),
                { httpStatus: 404 },
              );
            }
          }

          const created = await bumpRateCard(tx, {
            scope: body.contractId
              ? { ownerContractId: body.contractId }
              : { ownerOrgId: orgId },
            planType: body.planType ?? null,
            planId: body.planId ?? null,
            next: {
              platformBps: body.platformBps,
              orgBps: body.orgBps,
              consultantBps: body.consultantBps,
            },
            minGrossPaise: body.minGrossPaise,
            maxGrossPaise: body.maxGrossPaise,
            effectiveAt: body.effectiveAt,
            reason: body.reason,
          });

          await tx.orgAuditLog.create({
            data: {
              organizationId: orgId,
              actorMembershipId: access.member.id,
              category: "PROGRAM",
              action: AUDIT_ACTIONS.PROGRAM.RATE_CARD_BUMPED,
              description: body.contractId
                ? `Rate card bumped for contract ${body.contractId}`
                : `Org-default rate card bumped`,
              details: {
                rateCardId: created.id,
                contractId: body.contractId ?? null,
                planType: body.planType ?? null,
                planId: body.planId ?? null,
                platformBps: body.platformBps,
                orgBps: body.orgBps,
                consultantBps: body.consultantBps,
                effectiveFrom: created.effectiveFrom,
                reason: body.reason ?? null,
              },
            },
          });

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    return NextResponse.json({ rateCard: card }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    // #1405 — the `rate_card_one_open_window` partial unique is the structural
    // half of the fix: it refuses a second open window on the same scope even
    // if Serializable is unavailable or the write arrives from somewhere else.
    // A caller that loses that race is not a server fault, so answer 409 and
    // let them re-read the current card and retry.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error:
            "This rate-card scope already has an open window; re-read the current card and retry",
          code: "RATE_CARD_OPEN_WINDOW_CONFLICT",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
