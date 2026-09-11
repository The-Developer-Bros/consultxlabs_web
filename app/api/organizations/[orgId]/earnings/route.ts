/**
 * GET /api/organizations/[orgId]/earnings
 *
 * Lists `OrganizationEarnings` rows for a hosting org, optionally filtered
 * by status and time window. Earnings are the per-payment 3-way split
 * artifact (platform / org / consultant shares) and carry the rate-card
 * snapshot that was applied. Unlike payouts (which aggregate earnings),
 * each earnings row is immutable once written — the rate snapshot fields
 * ensure a later RateCard bump cannot retroactively rewrite settlement.
 *
 * Query params:
 *   status=PENDING|HELD|READY|PAID|REFUNDED   optional single status filter
 *   from=ISO-8601                              createdAt >= from
 *   to=ISO-8601                                createdAt <  to
 *   payoutId=...                               rows rolled into a given payout
 *   limit=1..200                               default 50
 *   cursor=...                                 opaque cursor (last row id)
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { sumPaise } from "@/lib/payments/utils/money";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

const EarningStatusSchema = z.enum([
  "PENDING",
  "HELD",
  "READY",
  "BATCHED", // #837 — batched, cash not yet disbursed; filterable + distinct from PAID
  "PAID",
  "REFUNDED",
]);

const QuerySchema = z.object({
  status: EarningStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  payoutId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  // Honesty gate: an org's canHost column can be true from when the flag was
  // on, but with ENABLE_HOST_ORGS off resolveOrgSplit returns null so NO new
  // OrganizationEarnings accrue — surfacing a split dashboard would lie.
  if (!ENABLE_HOST_ORGS || !access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host — no earnings to list" },
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

  const [earnings, aggregates] = await Promise.all([
    prisma.organizationEarnings.findMany({
      where: {
        organizationId: orgId,
        ...(q.status && { status: q.status }),
        ...(q.payoutId !== undefined && { orgPayoutId: q.payoutId }),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from && { gte: q.from }),
                ...(q.to && { lt: q.to }),
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            originalAmount: true,
            currency: true,
            paymentStatus: true,
            appointmentId: true,
            createdAt: true,
          },
        },
        orgPayout: {
          select: { id: true, status: true, processedAt: true },
        },
      },
    }),
    prisma.organizationEarnings.groupBy({
      by: ["status"],
      where: { organizationId: orgId },
      _sum: {
        orgSharePaise: true,
        platformFeePaise: true,
        consultantSharePaise: true,
        refundedAmountPaise: true,
      },
      _count: { _all: true },
    }),
  ]);

  const hasMore = earnings.length > q.limit;
  const rows = hasMore ? earnings.slice(0, q.limit) : earnings;
  const nextCursor = hasMore ? (rows[rows.length - 1]?.id ?? null) : null;

  return NextResponse.json({
    data: rows,
    pagination: { hasMore, nextCursor, limit: q.limit },
    aggregates: aggregates.map((g) => ({
      status: g.status,
      count: g._count._all,
      orgSharePaise: sumPaise(g._sum.orgSharePaise),
      platformFeePaise: sumPaise(g._sum.platformFeePaise),
      consultantSharePaise: sumPaise(g._sum.consultantSharePaise),
      refundedAmountPaise: sumPaise(g._sum.refundedAmountPaise),
    })),
  });
}
