/**
 * GET /api/admin/system-events
 *
 * Platform-engineering surface for operational events captured by
 * `recordSystemEvent` / `recordSystemError`. Separate from `OrgAuditLog`
 * — see SystemEvent docstring for the distinction (stack traces / Prisma
 * errors live here; clean prose lives in the org-visible audit log).
 *
 * Admin-only. Cursor-paginated on `(createdAt DESC, id DESC)` using the
 * `system_events_createdAt_idx` covering indexes. Query filters:
 *   - `severity` — INFO | WARN | ERROR
 *   - `category` — DATA_EXPORT | HRIS_SYNC | WEBHOOK | PAYOUT | CRON ...
 *   - `organizationId` — scope to one tenant
 *   - `correlationId` — pull every event for a single job invocation
 *   - `since` — ISO timestamp lower bound
 *   - `limit` — page size (default 100, max 500)
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, SystemEventSeverity } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAdminAuth } from "@/lib/auth-helpers";

const QuerySchema = z.object({
  severity: z.nativeEnum(SystemEventSeverity).optional(),
  category: z.string().min(1).max(64).optional(),
  organizationId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth();
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsed.data;

  const where: Prisma.SystemEventWhereInput = {
    ...(q.severity ? { severity: q.severity } : {}),
    ...(q.category ? { category: q.category } : {}),
    ...(q.organizationId ? { organizationId: q.organizationId } : {}),
    ...(q.correlationId ? { correlationId: q.correlationId } : {}),
    ...(q.since ? { createdAt: { gte: new Date(q.since) } } : {}),
  };

  const events = await prisma.systemEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit,
    select: {
      id: true,
      organizationId: true,
      category: true,
      severity: true,
      message: true,
      context: true,
      correlationId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    data: events.map((e) => ({
      ...e,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
