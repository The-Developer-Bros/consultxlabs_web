import { redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";

/**
 * Bare /[orgId] route.
 *
 * Routing by role:
 *   - MANAGER+      → /home (operator overview)
 *   - LEARNER       → /my-program (per-org sponsored allocation view)
 *   - EXPERT        → /compensation (per-org payout + RateCard view)
 *   - SUPPORT       → /home (read-only operator views; rank-30 passes
 *                    role checks on the lighter pages)
 *   - no membership → personal dashboard fallback (resolver may return
 *                     null if no profile yet — final default is
 *                     /dashboard which routes by role on the client)
 *
 * Platform ADMINs are role-stubbed as OWNER by `requireOrgAccess`
 * elsewhere; they always pass through to /home.
 */
export default async function OrgRoot({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const session = await getSession(true);
  if (!session?.user?.id) redirect("/auth/signin");

  if (session.user.role !== "ADMIN") {
    const member = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: session.user.id,
          organizationId: orgId,
        },
      },
      select: { role: true, status: true },
    });

    if (member?.status === "ACTIVE") {
      if (member.role === "LEARNER") {
        redirect(`/dashboard/organization/${orgId}/my-program`);
      }
      if (member.role === "EXPERT") {
        redirect(`/dashboard/organization/${orgId}/compensation`);
      }
      // MANAGER+, SUPPORT, OWNER, MAINTAINER fall through to /home
    } else if (!member) {
      // No membership — bounce out entirely. resolvePersonalDashboardHref
      // may return null if the user has no personal profile yet.
      redirect(resolvePersonalDashboardHref(session.user) ?? "/dashboard");
    }
  }

  redirect(`/dashboard/organization/${orgId}/home`);
}
