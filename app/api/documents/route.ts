/**
 * GET /api/documents
 *
 * Personal AppointmentDocument list with optional `?orgScope=` filter
 * (#674 / B1-hybrid). Org-scoped sibling at
 * `/api/organizations/[orgId]/documents`.
 *
 * NOT TO BE CONFUSED WITH
 * `/api/dashboard/consultant/[consultantId]/documents` which is the
 * pre-existing consultant-side review queue (different shape, accepts
 * its own `?orgScope=` since the B1-personal-retrofit). This endpoint
 * is the unified scope-aware list used by org dashboards.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { listDocumentsScoped } from "@/lib/api/scope/list-documents";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  reviewStatus: z
    .enum(["PENDING", "APPROVED", "REJECTED", "IN_REVIEW", "NEEDS_REVISION"])
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
    reviewStatus: url.searchParams.get("reviewStatus") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }
  const pagination = parsePagination(url);

  const result = await listDocumentsScoped({
    scope: scopeResolution.scope,
    userId: session.user.id,
    reviewStatus: filters.data.reviewStatus,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
