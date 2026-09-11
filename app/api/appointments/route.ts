/**
 * GET /api/appointments
 *
 * Personal appointments list with optional `?orgScope=` filter
 * (#674 / B1-hybrid). The org-scoped sibling lives at
 * `/api/organizations/[orgId]/appointments`. Both call the same shared
 * `listAppointmentsScoped` service.
 *
 * Auth: any signed-in user via `getServerSession`. The scope dimension
 * is then validated by `resolveOrgScope` against the caller's
 * memberships (rejects `<orgId>` if the caller isn't a member; rejects
 * `all` if not ADMIN/STAFF).
 *
 * Default scope is `personal` — backwards-compatible with any caller
 * that doesn't pass the param.
 *
 * NOT TO BE CONFUSED WITH `/api/dashboard/{consultee|consultant}/[id]/events`
 * which is the pre-existing 5-type-union "all my bookings widget"
 * endpoint. That one returns
 * `{consultations, subscriptions, webinars, classes, trials}` flattened
 * for a per-user dashboard tab — not paginated, scope-aware. This
 * endpoint returns a paginated `Appointment[]` (parent rows only) for
 * use by org-side dashboards + the new scope-toggle UX. Both endpoints
 * accept `?orgScope=` since the B1-personal-retrofit; pick the one that
 * matches the response shape you need.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { listAppointmentsScoped } from "@/lib/api/scope/list-appointments";
import { resolveOrgScope } from "@/lib/api/scope/parse";
import { parsePagination } from "@/lib/enterprise/validators";

const QuerySchema = z.object({
  appointmentType: z
    .enum(["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS", "TRIAL"])
    .optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const session = auth.session;

  // Resolve scope against the caller's active memberships.
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
    appointmentType: url.searchParams.get("appointmentType") ?? undefined,
  });
  if (!filters.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: filters.error.flatten() },
      { status: 400 },
    );
  }
  const pagination = parsePagination(url);

  const result = await listAppointmentsScoped({
    scope: scopeResolution.scope,
    userId: session.user.id,
    appointmentType: filters.data.appointmentType,
    page: pagination.page,
    perPage: pagination.pageSize,
  });
  return NextResponse.json(result);
}
