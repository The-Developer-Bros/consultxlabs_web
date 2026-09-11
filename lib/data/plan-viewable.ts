import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { isPlanViewable } from "@/lib/api/plans/visibility";
import type { OrgPlanVisibility } from "@prisma/client";

/**
 * Server-side wiring for {@link isPlanViewable}.
 *
 * Split from the pure predicate so the gate itself stays unit-testable without
 * a database, and so the four detail pages share one membership query rather
 * than each inventing their own.
 */
export async function canViewPlanDetail(
  plan: {
    visibility: OrgPlanVisibility;
    organizationId: string | null;
    archivedAt?: Date | null;
  } | null,
): Promise<boolean> {
  // A session-lookup failure is treated as anonymous by design (matches
  // app/api/waitlist/route.ts's identical fallback) — captured for
  // visibility only; the anonymous-fallback outcome itself is unchanged.
  const session = await getSession().catch((error) => {
    reportSentryError(error, { subsystem: "plans", expected: true });
    return null;
  });
  return isPlanViewable(
    plan,
    session?.user?.id ?? null,
    async (args) => {
      const membership = await prisma.membership.findFirst({
        where: {
          userId: args.userId,
          organizationId: args.organizationId,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      return membership !== null;
    },
    // Owner preview: an author sees their own DRAFT / archived offering at the
    // real detail URL. Nobody else's access changes.
    session?.user?.consultantProfileId ?? null,
  );
}
