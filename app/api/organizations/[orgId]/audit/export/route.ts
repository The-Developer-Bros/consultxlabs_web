/**
 * GET /api/organizations/[orgId]/audit/export
 *
 * CSV export for the audit-log viewer. Reuses the same filter semantics
 * as `GET /api/organizations/[orgId]/audit` but streams the full filtered
 * set rather than a paginated page. Required for compliance reviews
 * where the reviewer wants the whole trail for a date range.
 *
 * Self-auditing: the export action itself emits an
 * `AUDIT_LOG_EXPORTED` audit row before streaming the body. A
 * compliance review asking "who pulled our audit trail in Q2?"
 * needs that row to exist.
 *
 * Streaming is chunked via a ReadableStream so orgs with 10k+ rows
 * don't OOM the function. Each chunk = 500 rows.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  sanitizeAuditDescription,
  sanitizeAuditDetails,
} from "@/lib/enterprise/audit-sanitize";

type AuditExportRow = {
  id: string;
  category: string;
  action: string;
  description: string;
  details: Prisma.JsonValue | null;
  actorMembershipId: string | null;
  targetMembershipId: string | null;
  createdAt: Date;
};

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
});

const CSV_CHUNK_SIZE = 500;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
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
  };

  // Emit the export-action audit row up-front (before the stream starts)
  // so the record lands even if the download is cancelled mid-flight.
  const totalCount = await prisma.orgAuditLog.count({ where });
  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "SETTINGS",
      action: AUDIT_ACTIONS.SETTINGS.AUDIT_LOG_EXPORTED,
      description: `Audit log exported (${totalCount} rows)`,
      details: {
        filters: {
          categories: q.categories,
          actions: q.actions,
          actorMembershipId: q.actorMembershipId ?? null,
          q: q.q ?? null,
          from: q.from?.toISOString() ?? null,
          to: q.to?.toISOString() ?? null,
        },
        rowCount: totalCount,
      },
    },
  });

  // Stream rows to the client. Each chunk fetches CSV_CHUNK_SIZE rows
  // via cursor pagination so memory stays bounded regardless of total
  // size. Using a ReadableStream lets the browser start downloading
  // before we've assembled the full body.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Header row
        controller.enqueue(
          encoder.encode(
            "createdAt,category,action,actor_email,actor_role,target_email,description,details_json\n",
          ),
        );

        let cursor: { createdAt: Date; id: string } | null = null;
        // Upper bound on iterations prevents a runaway loop if the DB
        // ever returns inconsistent cursor progress. 400 * 500 = 200k
        // rows — well above any realistic audit-log query in this
        // product's lifetime.
        const MAX_ITERATIONS = 400;

        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const rows: AuditExportRow[] = await prisma.orgAuditLog.findMany({
            where: cursor
              ? {
                  ...where,
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    {
                      createdAt: cursor.createdAt,
                      id: { lt: cursor.id },
                    },
                  ],
                }
              : where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: CSV_CHUNK_SIZE,
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
          if (rows.length === 0) break;

          // Resolve membership → email/role in-batch
          const mids: string[] = Array.from(
            new Set(
              [
                ...rows
                  .map((r: AuditExportRow) => r.actorMembershipId)
                  .filter((v: string | null): v is string => !!v),
                ...rows
                  .map((r: AuditExportRow) => r.targetMembershipId)
                  .filter((v: string | null): v is string => !!v),
              ],
            ),
          );
          const members = mids.length
            ? await prisma.membership.findMany({
                where: { id: { in: mids } },
                select: {
                  id: true,
                  role: true,
                  user: { select: { email: true } },
                },
              })
            : [];
          const mmap = new Map(
            members.map((m) => [m.id, { role: m.role, email: m.user.email }]),
          );

          for (const row of rows) {
            const actor = row.actorMembershipId
              ? mmap.get(row.actorMembershipId)
              : null;
            const target = row.targetMembershipId
              ? mmap.get(row.targetMembershipId)
              : null;
            const line = [
              row.createdAt.toISOString(),
              row.category,
              row.action,
              csvEscape(actor?.email ?? ""),
              actor?.role ?? "",
              csvEscape(target?.email ?? ""),
              csvEscape(sanitizeAuditDescription(row.description)),
              csvEscape(JSON.stringify(sanitizeAuditDetails(row.details) ?? {})),
            ].join(",");
            controller.enqueue(encoder.encode(line + "\n"));
          }

          const last: AuditExportRow = rows[rows.length - 1];
          cursor = { createdAt: last.createdAt, id: last.id };
          if (rows.length < CSV_CHUNK_SIZE) break;
        }

        controller.close();
      } catch (err) {
        console.error(
          JSON.stringify({
            event: "audit_export_stream_failed",
            orgId,
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
        controller.error(err);
      }
    },
  });

  const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${orgId}-${now}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * CSV-escape a field: wrap in double quotes if it contains comma /
 * quote / newline; double-up any embedded quotes.
 */
function csvEscape(v: string): string {
  if (v === "" || v === null || v === undefined) return "";
  const needsQuoting = /[",\n\r]/.test(v);
  if (!needsQuoting) return v;
  return `"${v.replace(/"/g, '""')}"`;
}
