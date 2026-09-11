/**
 * Shared read for the org-scoped appointments list (#674 / B1-hybrid).
 *
 * Single source of truth for the table the org Appointments page renders.
 * The org appointments server page calls this directly in its SSR prefetch
 * (queryKey ["org-appointments", orgId, page]) so the default page hydrates
 * without a fetch waterfall, and the payload matches the client useQuery
 * shape. The `/api/organizations/[orgId]/appointments` route calls the same
 * function so both sources stay identical.
 *
 * Auth is enforced UPSTREAM (route via requireOrgAccess; the page is already
 * inside the MANAGER+ org dashboard segment). This trusts its caller.
 *
 * Wrapped in toPlain: appointment rows spread #780/#781 money-$extends
 * models (Proxy-backed, carrying the inspect symbol), which React's RSC
 * serializer rejects until flattened to genuinely plain objects.
 */

import type { AppointmentsType } from "@prisma/client";
import {
  listAppointmentsScoped,
  type ListAppointmentsResult,
} from "@/lib/api/scope/list-appointments";
import { toPlain } from "@/lib/data/serialize";

export interface GetOrgAppointmentsArgs {
  appointmentType?: AppointmentsType;
  page?: number;
  perPage?: number;
}

export async function getOrgAppointments(
  orgId: string,
  args: GetOrgAppointmentsArgs = {},
): Promise<ListAppointmentsResult> {
  const result = await listAppointmentsScoped({
    scope: { kind: "org", orgId },
    // Org scope filters by organizationId only — the userId is unused for
    // this kind (see buildWhere), so a stable sentinel is safe here.
    userId: "",
    appointmentType: args.appointmentType,
    page: args.page ?? 1,
    perPage: args.perPage ?? 20,
  });
  return toPlain(result);
}

/**
 * #org-appts — ONE member's own appointments within an org (booked as a learner
 * OR delivered as an expert). Powers the per-user "Org Appointments" page.
 * Distinct from getOrgAppointments (all-org, MANAGER+). Auth is enforced upstream
 * (membership at orgId); this trusts its caller.
 */
export async function getOrgMemberAppointments(
  orgId: string,
  userId: string,
  args: GetOrgAppointmentsArgs = {},
): Promise<ListAppointmentsResult> {
  const result = await listAppointmentsScoped({
    scope: { kind: "orgMember", orgId, userId },
    userId,
    appointmentType: args.appointmentType,
    page: args.page ?? 1,
    perPage: args.perPage ?? 20,
  });
  return toPlain(result);
}
