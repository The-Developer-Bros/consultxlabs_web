/**
 * GET  /api/organizations/[orgId]/payouts
 * POST /api/organizations/[orgId]/payouts
 *
 * Hosting-side settlements: roll READY earnings into an `OrganizationPayout`
 * row. The creation path is deliberately admin-gated and narrow:
 *   1. Pick all READY earnings in [periodStart, periodEnd).
 *   2. Create the payout with aggregated totals (gross/fee/refunds/net).
 *   3. Attach those earnings to the payout + flip their status to BATCHED
 *      (#837 — not PAID; PAID happens only at payout COMPLETED + UTR).
 *
 * Actual fund-movement (RazorpayX / Cashfree) happens asynchronously in
 * jobs/payouts/** — this endpoint only records the intent and reserves the
 * earnings. `status` starts at `PENDING` and transitions via that job.
 *
 * India statutory fields (`tdsAmountPaise`, `mustPayByDate`, …) are nullable
 * at creation and filled by the cron; the route accepts hints but does not
 * derive them.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: payout initiation is a finance-team action; downgrade from
// requireOrgOwner so BILLING_ADMIN can trigger payouts without escalation.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { sumPaise } from "@/lib/payments/utils/money";
import { createOrgPayoutBatch } from "@/lib/payments/payouts/org-payout-service";
import type { PayoutStatus } from "@prisma/client";

const PayoutStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

const PaymentGatewaySchema = z.enum([
  "STRIPE",
  "RAZORPAY",
  "CARD",
]);

const CreatePayoutBodySchema = z
  .object({
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    paymentGateway: PaymentGatewaySchema.default("RAZORPAY"),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.periodEnd.getTime() > v.periodStart.getTime(), {
    message: "periodEnd must be after periodStart",
  });

const QuerySchema = z.object({
  status: PayoutStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

// In-flight = held/reserved but not yet disbursed (mirrors the client's
// former "Pending" card definition).
const IN_FLIGHT_STATUSES: PayoutStatus[] = ["PENDING", "APPROVED", "PROCESSING"];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "payouts.read" });
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host — no payouts to list" },
      { status: 404 },
    );
  }

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

  const where = {
    organizationId: orgId,
    ...(q.status && { status: q.status }),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from && { gte: q.from }),
            ...(q.to && { lt: q.to }),
          },
        }
      : {}),
  };

  // #997 secondary findings: this used to fetch every payout for the org
  // (no offset) and reduce totals client-side every render. Pagination now
  // bounds the list; `stats` below is server-aggregated and org-wide
  // (ignores status/date filters) so the summary cards don't shift as the
  // table is filtered/paged — matching the client's original "stay on the
  // full set" intent.
  const [payouts, total, paidAgg, pendingAgg, statusCounts] =
    await Promise.all([
      prisma.organizationPayout.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
        skip: q.offset,
        include: {
          _count: { select: { earnings: true } },
        },
      }),
      prisma.organizationPayout.count({ where }),
      prisma.organizationPayout.aggregate({
        where: { organizationId: orgId, status: "COMPLETED" },
        // #1132 follow-up — stats quote the DISBURSED figure (amountPaise =
        // net after TDS), not netPayoutPaise (pre-TDS org share). Legacy
        // pre-TDS rows carried amountPaise == netPayoutPaise, so history
        // doesn't shift.
        _sum: { amountPaise: true },
      }),
      prisma.organizationPayout.aggregate({
        where: { organizationId: orgId, status: { in: IN_FLIGHT_STATUSES } },
        _sum: { amountPaise: true },
      }),
      prisma.organizationPayout.groupBy({
        by: ["status"],
        where: { organizationId: orgId },
        _count: { id: true },
      }),
    ]);

  const counts = Object.fromEntries(
    statusCounts.map((s) => [s.status, s._count.id]),
  ) as Partial<Record<PayoutStatus, number>>;
  const totalCount = statusCounts.reduce((sum, s) => sum + s._count.id, 0);

  return NextResponse.json({
    data: payouts,
    pagination: {
      total,
      limit: q.limit,
      offset: q.offset,
      hasMore: q.offset + q.limit < total,
    },
    stats: {
      totalPaidPaise: sumPaise(paidAgg._sum.amountPaise),
      pendingPaise: sumPaise(pendingAgg._sum.amountPaise),
      counts: { ...counts, total: totalCount },
    },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host — payouts are unavailable" },
      { status: 409 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = CreatePayoutBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    // Delegate to the canonical batch creator rather than re-implementing it.
    //
    // This route used to carry its own copy of the create logic, and the copy
    // had drifted: it wrote `amountPaise: orgShare - refunds` with NO TDS
    // withheld and left `tdsAmountPaise` / `mustPayByDate` null, on the
    // strength of a comment claiming "TDS is withheld by the cron". Nothing
    // back-fills TDS — `createOrgPayoutBatch` is the only writer of those
    // fields — and disbursement submits `payout.amountPaise` verbatim, so a
    // batch created from the dashboard paid the org the full pre-tax amount.
    // That is statutory under-withholding, and the MSME 43B(h) alert job
    // skipped the row because `mustPayByDate` was never set.
    //
    // The service is a strict superset of what was here: same payout-account
    // VERIFIED gate, same race-safe claim of READY earnings, plus TDS, the
    // MSME deadline, a distributed lock and idempotency.
    const result = await createOrgPayoutBatch(
      orgId,
      body.periodStart,
      body.periodEnd,
      {
        paymentGateway: body.paymentGateway,
        notes: body.notes,
        actorMembershipId: access.member.id,
      },
    );

    const payout = await prisma.organizationPayout.findUnique({
      where: { id: result.payoutId },
    });
    // The service just wrote this row, so a miss means the read raced a
    // rollback or hit a replica — either way `201 { payout: null }` would tell
    // the caller the batch succeeded and hand them nothing to act on.
    if (!payout) {
      Sentry.captureException(
        new Error(
          `Payout ${result.payoutId} created but not readable on re-fetch`,
        ),
        { tags: { subsystem: "enterprise" } },
      );
      return NextResponse.json(
        {
          error:
            "The payout batch was created but could not be read back. Refresh the payouts list before retrying.",
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ payout }, { status: 201 });
  } catch (err) {
    // PayoutValidationError carries `httpStatus` (409 for an unverified
    // payout account, no READY earnings, etc.), so the existing branch
    // already maps it correctly.
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
