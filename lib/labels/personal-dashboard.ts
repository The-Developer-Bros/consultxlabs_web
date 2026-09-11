/**
 * Resolve the href for a user's "Personal Dashboard" link.
 *
 * Priority order:
 *   orgWorkspaceProfile  → /dashboard/org-workspace/:id/home
 *   consultantProfile → /dashboard/consultant/:id/home
 *   consulteeProfile  → /dashboard/consultee/:id/home
 *   (none)            → null
 *
 * Operator identity wins over consumer identity so an org-owner who
 * also happens to have a ConsulteeProfile lands on their operator
 * home, not a consumer surface. Consultant wins over consultee so
 * an expert who also consumes content on the platform lands on their
 * earnings surface.
 *
 * Keeping this resolver in one place prevents the drift we saw before
 * (invitations page + OrgContextBar + sidebar each had their own
 * inline ternary, and they disagreed on the null-fallback).
 */

export interface PersonalProfileIds {
  orgWorkspaceProfileId?: string | null;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
}

export function resolvePersonalDashboardHref(
  user: PersonalProfileIds,
): string | null {
  if (user.orgWorkspaceProfileId) {
    return `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/home`;
  }
  if (user.consultantProfileId) {
    return `/dashboard/consultant/${user.consultantProfileId}/home`;
  }
  if (user.consulteeProfileId) {
    return `/dashboard/consultee/${user.consulteeProfileId}/home`;
  }
  return null;
}

/**
 * Where "back to my appointments" goes for a given user (#1067).
 *
 * The priority deliberately differs from `resolvePersonalDashboardHref`: an
 * org workspace wins there, but it has no appointments surface at all, so
 * sending someone leaving a meeting to a route that does not exist would be
 * worse than the browser Back button they had before. Consultant still wins
 * over consultee for the same reason as above — someone who both delivers and
 * consumes is far more likely to have been hosting.
 *
 * Falls back to whatever home the user does have, and finally to `/dashboard`,
 * so this never returns null: the lobby always needs somewhere to go.
 */
export function resolveAppointmentsHref(user: PersonalProfileIds): string {
  if (user.consultantProfileId) {
    return `/dashboard/consultant/${user.consultantProfileId}/appointments`;
  }
  if (user.consulteeProfileId) {
    return `/dashboard/consultee/${user.consulteeProfileId}/appointments`;
  }
  return resolvePersonalDashboardHref(user) ?? "/dashboard";
}

export type PersonalFacetKind = "org-workspace" | "consultant" | "consultee";

export interface PersonalFacet {
  kind: PersonalFacetKind;
  label: string;
  href: string;
}

/**
 * All of a user's personal facets, in priority order — a user who both
 * delivers (consultantProfile) and consumes (consulteeProfile) now has BOTH
 * personal homes, so the switcher can offer each rather than the single
 * priority-winner `resolvePersonalDashboardHref` returns. Identity is driven by
 * capability (which profiles exist), not the singular UserRole.
 */
export function resolvePersonalDashboardFacets(
  user: PersonalProfileIds,
): PersonalFacet[] {
  const facets: PersonalFacet[] = [];
  if (user.orgWorkspaceProfileId) {
    facets.push({
      kind: "org-workspace",
      label: "Personal (Operator)",
      href: `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/home`,
    });
  }
  if (user.consultantProfileId) {
    facets.push({
      kind: "consultant",
      label: "Personal (Consultant)",
      href: `/dashboard/consultant/${user.consultantProfileId}/home`,
    });
  }
  if (user.consulteeProfileId) {
    facets.push({
      kind: "consultee",
      label: "Personal (Consultee)",
      href: `/dashboard/consultee/${user.consulteeProfileId}/home`,
    });
  }
  return facets;
}
