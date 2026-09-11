import { redirect } from "next/navigation";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

import { CatalogClient } from "./CatalogClient";

/**
 * /dashboard/organization/[orgId]/catalog — the offerings this org OWNS.
 *
 * Separate from the sibling `programs` page on purpose, and for the same reason
 * ADR 19 keeps `my-program` separate from `programs`: they are different
 * objects, not two scopes of one. Catalog is host-side — what the org sells.
 * Programs is sponsor-side — the entitlement that funds bookings of anybody's
 * plans. No toggle sensibly spans them.
 *
 * Only Webinar and Class appear here. `ConsultationPlan` and `SubscriptionPlan`
 * require a `consultantProfileId` in the schema, so an org can never solely own
 * one — those stay on the consultant's own planner with the org as a tag.
 */
export default async function OrgCatalogPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId, {
    permission: "catalog.manage",
    canHost: true,
  });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  // The pickable deliverers. An org plan with no consultant behind it is not
  // bookable, so the form requires one and the API re-checks the membership —
  // this list is convenience, not authorization.
  const expertMemberships = await prisma.membership.findMany({
    where: {
      organizationId: orgId,
      status: "ACTIVE",
      role: "EXPERT",
      consultantProfileId: { not: null },
    },
    select: {
      consultantProfileId: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const experts = expertMemberships.map((m) => ({
    consultantProfileId: m.consultantProfileId as string,
    name: m.user.name ?? m.user.email,
  }));

  return <CatalogClient orgId={orgId} experts={experts} />;
}
