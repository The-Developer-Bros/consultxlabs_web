/**
 * Shared visibility filter for plan-marketplace endpoints (#726).
 *
 * Org-owned plans (ConsultationPlan / SubscriptionPlan / WebinarPlan /
 * ClassPlan with `organizationId` set) carry an `OrgPlanVisibility`
 * enum that decides whether they're discoverable on `/explore/**` and
 * the public plan list APIs:
 *
 *   PUBLIC          — visible everywhere (default for personal plans).
 *   ORG_AND_PUBLIC  — discoverable AND surfaced to org members.
 *   ORG_ONLY        — only org members see it; the marketplace MUST
 *                     filter it out.
 *
 * Every public-facing plan list endpoint should compose this filter
 * into its `where` clause. An org-internal catalog endpoint should NOT
 * use this helper — those endpoints accept `ORG_ONLY` for the viewer's
 * own org by design.
 *
 * Why a helper rather than inline checks: a dropped or mistyped filter
 * on any one of the four marketplace surfaces becomes a tenant-private
 * catalog leak (the bug class #726 was filed to prevent). Routing every
 * public surface through one constant keeps the gate auditable.
 */

import type { OrgPlanVisibility } from "@prisma/client";

/**
 * Visibility values that are safe to show on the public marketplace.
 * Used as a Prisma `where: { visibility: { in: ... } }` filter.
 */
export const MARKETPLACE_VISIBILITY: OrgPlanVisibility[] = [
  "PUBLIC",
  "ORG_AND_PUBLIC",
];

/**
 * Convenience filter object — spread into any plan-list `where`:
 *
 *   const where = {
 *     ...other filters,
 *     ...marketplaceVisibilityWhere(),
 *   };
 */
export function marketplaceVisibilityWhere() {
  return { visibility: { in: MARKETPLACE_VISIBILITY } } as const;
}

/**
 * Full discovery filter: publicly visible AND not withdrawn from sale.
 *
 * This used to apply only to WebinarPlan and ClassPlan, because they were the
 * only models with an `archivedAt` column and Prisma rejects a filter naming a
 * column the model lacks. ConsultationPlan and SubscriptionPlan now carry it
 * too, so this is the correct filter for all four and
 * `marketplaceVisibilityWhere()` is the narrower one — use it only where
 * archived rows are deliberately in scope.
 *
 * Archived means withdrawn from sale. The row is kept because it carries the
 * terms of every booking made against it, and because the plan FK chain
 * cascades to Appointment and Payment — see the catalog DELETE handler.
 */
export function eventPlanDiscoverableWhere() {
  return {
    visibility: { in: MARKETPLACE_VISIBILITY },
    archivedAt: null,
  } as const;
}

/**
 * Gate for a PLAN DETAIL PAGE, which is reached by id rather than by listing.
 *
 * The list surfaces all compose `marketplaceVisibilityWhere()`, but the four
 * detail pages fetched by primary key and filtered on nothing — so an
 * `ORG_ONLY` plan was fully readable by anyone holding its id, and an archived
 * one still rendered a working page. That is the #726 leak class arriving
 * through the back door, and it predated the two new detail routes.
 *
 * A plan is viewable when it is not archived AND either it is publicly visible
 * or the viewer is an ACTIVE member of the org that owns it. Membership is the
 * only thing that can widen it — being the authoring consultant is deliberately
 * NOT enough, because the consultant already reads their own plans through the
 * planner, which is org-internal by design.
 */
export async function isPlanViewable(
  plan: {
    visibility: OrgPlanVisibility;
    organizationId: string | null;
    archivedAt?: Date | null;
    /**
     * The plan's authoring consultant. Present only where the caller loaded it;
     * absent keeps the previous behaviour exactly.
     */
    consultantProfileId?: string | null;
  } | null,
  viewerUserId: string | null | undefined,
  findActiveMembership: (args: {
    userId: string;
    organizationId: string;
  }) => Promise<boolean>,
  /**
   * The viewer's own consultant profile, when they have one.
   *
   * This is the owner-preview arm: an author may open their own unpublished or
   * archived offering at its REAL detail URL, so "preview" is the actual page
   * rather than a second renderer that can drift from it. It deliberately does
   * NOT widen anything for anyone else — a non-owner still gets a 404.
   */
  viewerConsultantProfileId?: string | null,
): Promise<boolean> {
  if (!plan) return false;

  const isOwner =
    !!viewerConsultantProfileId &&
    !!plan.consultantProfileId &&
    plan.consultantProfileId === viewerConsultantProfileId;
  if (isOwner) return true;

  if (plan.archivedAt) return false;
  if (MARKETPLACE_VISIBILITY.includes(plan.visibility)) return true;
  if (!plan.organizationId || !viewerUserId) return false;
  return findActiveMembership({
    userId: viewerUserId,
    organizationId: plan.organizationId,
  });
}
