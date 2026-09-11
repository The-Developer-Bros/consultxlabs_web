/**
 * GET /api/organizations/[orgId]/activity
 *
 * Read-only view over `OrgAuditLog` for a single organization. The audit
 * log is the central event feed for every mutation against the org — it
 * gets written inside the same transaction as the mutation it records
 * (see the 9a-9g routes), so this endpoint is the canonical "what
 * happened" surface for admins.
 *
 * Filters:
 *   category=MEMBER|CONTRACT|PROGRAM|WALLET|INVOICE|PAYOUT|SETTINGS|CONSENT|SYSTEM
 *   action=<string literal from AUDIT_ACTIONS>
 *   actorMembershipId=<uuid>
 *   from=ISO-8601 (inclusive lower bound)
 *   to=ISO-8601   (exclusive upper bound)
 *   limit=1..200  (default 50)
 *   cursor=<id>   (for reverse-chronological pagination)
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const CategorySchema = z.enum([
  "MEMBER",
  "CONTRACT",
  "PROGRAM",
  "WALLET",
  "INVOICE",
  "PAYOUT",
  "SETTINGS",
  "CONSENT",
  "SYSTEM",
]);

const QuerySchema = z.object({
  category: CategorySchema.optional(),
  action: z.string().min(1).max(128).optional(),
  actorMembershipId: z.string().uuid().optional(),
  targetMembershipId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
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

  const rows = await prisma.orgAuditLog.findMany({
    where: {
      organizationId: orgId,
      ...(q.category && { category: q.category }),
      ...(q.action && { action: q.action }),
      ...(q.actorMembershipId && { actorMembershipId: q.actorMembershipId }),
      ...(q.targetMembershipId && {
        targetMembershipId: q.targetMembershipId,
      }),
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
  });

  const hasMore = rows.length > q.limit;
  const data = hasMore ? rows.slice(0, q.limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

  return NextResponse.json({
    data,
    pagination: { hasMore, nextCursor, limit: q.limit },
  });
}
