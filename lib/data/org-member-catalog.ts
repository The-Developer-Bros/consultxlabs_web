/**
 * The org's own catalog, as seen by one of its MEMBERS.
 *
 * `OrgPlanVisibility.ORG_ONLY` was write-only before this existed: an operator
 * could author a plan and narrow it to ORG_ONLY, at which point
 * `marketplaceVisibilityWhere()` correctly hid it from `/explore/**` and
 * nothing else ever showed it — so the plan became invisible to everyone,
 * including the members it was authored for.
 *
 * This is the deliberate counterpart to the marketplace filter: an org-internal
 * read, so it accepts ORG_ONLY *for the viewer's own org* by design. It must
 * only ever be called after `requireOrgAccess(orgId)` has confirmed membership,
 * because the orgId is the entire authorisation boundary here.
 *
 * Archived plans are excluded — withdrawn from sale means withdrawn for members
 * too; the row survives only to resolve past bookings.
 */

import prisma from "@/lib/prisma";
import type { CoveredPlanType, Currency } from "@prisma/client";

const CARD_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  description: true,
  price: true,
  priceCurrency: true,
  visibility: true,
} as const;

// Members see everything their org owns, including ORG_ONLY. The only gate is
// the archive one.
const memberVisibleWhere = (orgId: string) => ({
  organizationId: orgId,
  archivedAt: null,
});

export type OrgCatalogEntry = {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  // Number, not bigint: the extended client returns plan prices as numbers
  // at runtime (#780). Still paise.
  price: number;
  priceCurrency: Currency;
  planType: CoveredPlanType;
  isMembersOnly: boolean;
};

export async function getOrgMemberCatalog(
  orgId: string,
): Promise<OrgCatalogEntry[]> {
  const where = memberVisibleWhere(orgId);
  const [consultations, subscriptions, webinars, classes] = await Promise.all([
    prisma.consultationPlan.findMany({ where, select: CARD_SELECT }),
    prisma.subscriptionPlan.findMany({ where, select: CARD_SELECT }),
    prisma.webinarPlan.findMany({ where, select: CARD_SELECT }),
    prisma.classPlan.findMany({ where, select: CARD_SELECT }),
  ]);

  const tag = (
    rows: (typeof consultations)[number][],
    planType: CoveredPlanType,
  ): OrgCatalogEntry[] =>
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      price: row.price,
      priceCurrency: row.priceCurrency,
      planType,
      // Worth surfacing: a member should know an offering is internal, so they
      // do not try to share the link with someone outside the org.
      isMembersOnly: row.visibility === "ORG_ONLY",
    }));

  return [
    ...tag(consultations, "CONSULTATION"),
    ...tag(subscriptions, "SUBSCRIPTION"),
    ...tag(webinars, "WEBINAR"),
    ...tag(classes, "CLASS"),
  ].sort((a, b) => a.title.localeCompare(b.title));
}
