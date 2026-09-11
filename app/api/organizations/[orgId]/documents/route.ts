/**
 * GET /api/organizations/[orgId]/documents
 *
 * Org-scoped AppointmentDocument list (#674 / B1-hybrid). MANAGER+ at
 * the org. Documents inherit org context via the parent
 * `Appointment.organizationId`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { listDocumentsScoped } from "@/lib/api/scope/list-documents";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  reviewStatus: z
    .enum(["PENDING", "APPROVED", "REJECTED", "IN_REVIEW", "NEEDS_REVISION"])
    .optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "operations.read" });
  if (access.error) return access.error;

  const url = new URL(req.url);
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
    scope: { kind: "org", orgId },
    userId: access.session.user.id,
    reviewStatus: filters.data.reviewStatus,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
