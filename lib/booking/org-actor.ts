import prisma from "@/lib/prisma";
import type { MemberRole } from "@prisma/client";

/**
 * The payer-side actor for an org-funded booking. OWNER and MAINTAINER answer
 * for the org's money; EXPERT and the rest are deliberately excluded, matching
 * the availability route's admin floor. Named separately from the lookup below
 * because surfaces that already hold a resolved Membership (the org dashboard
 * pages) need the rule without a second round trip.
 */
export function isPayerAdminRole(role: MemberRole | null | undefined): boolean {
  return role === "OWNER" || role === "MAINTAINER";
}

/**
 * #1166 ORG-9 half — lifecycle authorization for the org that funds a booking.
 * An OWNER/MAINTAINER of the appointment's organization may cancel or
 * reschedule it: the org is the payer, so they act on the PAYER side of the
 * policy tiers (never the consultant side). EXPERT and other roles are
 * deliberately excluded, matching the availability route's admin floor.
 */
export async function isOrgAdminOfAppointment(
  userId: string,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { status: true, role: true },
  });
  return membership?.status === "ACTIVE" && isPayerAdminRole(membership.role);
}
