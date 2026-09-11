/**
 * GET /api/recordings
 *
 * Personal Recording list with optional `?orgScope=` filter
 * (#674 / B1-hybrid). Org-scoped sibling at
 * `/api/organizations/[orgId]/recordings`.
 *
 * No pre-existing dashboard route for recordings — this IS the
 * canonical list endpoint. Per-consultant recordings page consumes
 * this with `?orgScope=personal`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { listRecordingsScoped } from "@/lib/api/scope/list-recordings";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  status: z
    .enum([
      "RECORDING",
      "PROCESSING",
      "READY",
      "TRANSFERRING",
      "AVAILABLE",
      "FAILED",
      "EXPIRED",
    ])
    .optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const session = auth.session;

  const memberships = await prisma.membership.findMany({
    where: { userId: session.user.id, status: "ACTIVE" },
    select: { organizationId: true, status: true, role: true },
  });

  const url = new URL(req.url);
  const scopeResolution = resolveOrgScope({
    raw: url.searchParams.get("orgScope"),
    memberships,
    userRole: (session.user as { role?: string }).role,
    userId: session.user.id,
  });
  if (!scopeResolution.ok) {
    return NextResponse.json(
      { error: scopeResolution.message, code: scopeResolution.code },
      { status: scopeResolution.status },
    );
  }

  const filters = QuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }
  const pagination = parsePagination(url);

  const result = await listRecordingsScoped({
    scope: scopeResolution.scope,
    userId: session.user.id,
    status: filters.data.status,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
