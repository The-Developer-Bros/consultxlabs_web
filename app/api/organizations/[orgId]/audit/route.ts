/**
 * GET /api/organizations/[orgId]/audit
 *
 * Cursor-paginated audit log browser for MAINTAINER+ roles. Supports
 * category / action / actor / freetext / date-range filters. Used by
 * the audit viewer page at `/dashboard/organization/[orgId]/audit`.
 *
 * Pagination is cursor-based on `(createdAt DESC, id DESC)` — the
 * existing `@@index([organizationId, createdAt])` and
 * `@@index([organizationId, category, createdAt])` cover the hot
 * filters without a new index.
 *
 * Freetext search (`q=` param) hits `description` via ILIKE. The
 * `details` JSON isn't indexed and would require a GIN index to
 * search efficiently — out of scope; `q` is description-only.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  sanitizeAuditDescription,
  sanitizeAuditDetails,
} from "@/lib/enterprise/audit-sanitize";

const CategorySchema = z.enum([
  "MEMBER",
  "CONTRACT",
  "PROGRAM",
  "WALLET",
  "INVOICE",
  "PAYOUT",
  "SETTINGS",
  "CONSENT",
  "CATALOG",
  "SYSTEM",
]);

const QuerySchema = z.object({
  // Multi-select filters are supplied as comma-separated lists so the
  // URL stays readable + bookmarkable by support. Empty = no filter.
  categories: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(z.array(CategorySchema)),
  actions: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    ),
  actorMembershipId: z.string().optional(),
  q: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // Cursor = base64 of `<iso>|<id>` from the last row returned.
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // audit.read (OWNER/MAINTAINER/SUPPORT) — same matrix entry as the
  // sidebar + page gate, incl. the SUPPORT L1/L2 read carve-out. The CSV
  // export route keeps its MAINTAINER floor (bulk PII is governance).
  const access = await requireOrgAccess(orgId, { permission: "audit.read" });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsed.data;

  // Decode cursor (iso|id). Invalid cursors are silently ignored —
  // caller gets page 1 instead of a 400, which is friendlier for
  // shared/bookmarked URLs where the cursor may be stale.
  let cursorAt: Date | null = null;
  let cursorId: string | null = null;
  if (q.cursor) {
    try {
      const decoded = Buffer.from(q.cursor, "base64").toString("utf-8");
      const [iso, id] = decoded.split("|");
      if (iso && id) {
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) {
          cursorAt = d;
          cursorId = id;
        }
      }
    } catch {
      // ignore — fall through to no-cursor
    }
  }

  const where: Prisma.OrgAuditLogWhereInput = {
    organizationId: orgId,
    ...(q.categories.length > 0 ? { category: { in: q.categories } } : {}),
    ...(q.actions.length > 0 ? { action: { in: q.actions } } : {}),
    ...(q.actorMembershipId
      ? { actorMembershipId: q.actorMembershipId }
      : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: q.from } : {}),
            ...(q.to ? { lte: q.to } : {}),
          },
        }
      : {}),
    ...(q.q
      ? { description: { contains: q.q, mode: "insensitive" as const } }
      : {}),
    ...(cursorAt && cursorId
      ? {
          OR: [
            { createdAt: { lt: cursorAt } },
            {
              createdAt: cursorAt,
              id: { lt: cursorId },
            },
          ],
        }
      : {}),
  };

  const rows = await prisma.orgAuditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1, // peek one extra to detect if more exist
    select: {
      id: true,
      category: true,
      action: true,
      description: true,
      details: true,
      actorMembershipId: true,
      targetMembershipId: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > q.limit;
  const pageRows = hasMore ? rows.slice(0, q.limit) : rows;

  const nextCursor =
    hasMore && pageRows.length > 0
      ? Buffer.from(
          `${pageRows[pageRows.length - 1].createdAt.toISOString()}|${pageRows[pageRows.length - 1].id}`,
          "utf-8",
        ).toString("base64")
      : null;

  // Resolve actor + target membership labels in a single query so the
  // viewer can render human-readable names without N+1.
  const membershipIds = Array.from(
    new Set([
      ...pageRows.map((r) => r.actorMembershipId).filter((v): v is string => !!v),
      ...pageRows.map((r) => r.targetMembershipId).filter((v): v is string => !!v),
    ]),
  );

  const members = membershipIds.length
    ? await prisma.membership.findMany({
        where: { id: { in: membershipIds } },
        select: {
          id: true,
          role: true,
          user: { select: { name: true, email: true } },
        },
      })
    : [];

  const memberMap = new Map(
    members.map((m) => [m.id, { role: m.role, user: m.user }]),
  );

  // Read-side scrub — strip engineering-noise patterns from the
  // description column AND drop sensitive keys from `details` before
  // the row ships to org-visible surfaces. This catches legacy rows
  // written before the call-site discipline landed, plus any future
  // regression. The raw payload remains in the DB for compliance;
  // only the projection is sanitized. See lib/enterprise/audit-sanitize.ts.
  return NextResponse.json({
    rows: pageRows.map((r) => ({
      id: r.id,
      category: r.category,
      action: r.action,
      description: sanitizeAuditDescription(r.description),
      details: sanitizeAuditDetails(r.details),
      createdAt: r.createdAt.toISOString(),
      actor: r.actorMembershipId
        ? memberMap.get(r.actorMembershipId) ?? null
        : null,
      target: r.targetMembershipId
        ? memberMap.get(r.targetMembershipId) ?? null
        : null,
    })),
    nextCursor,
  });
}
