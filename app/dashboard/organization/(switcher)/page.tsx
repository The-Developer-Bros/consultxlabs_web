/**
 * /dashboard/organization is no longer a standalone "your orgs" list.
 *
 * The org grid moved into /dashboard/org-workspace/<id>/home — the
 * canonical operator dashboard with sidebar navigation, cross-org
 * stats, activity feed, and billing roll-up. This page exists only as
 * a redirect target so old bookmarks, dropdown links, and Novu bell
 * payloads keep working.
 *
 * Routing rules:
 *   - User has an OrgWorkspaceProfile → /dashboard/org-workspace/<id>/home
 *   - User has no OrgWorkspaceProfile → /dashboard (role-router lands
 *     them on consultant/consultee home; they hop between orgs via
 *     the OrganizationSwitcher dropdown)
 *   - Unauthenticated → /auth/signin
 *
 * Non-OrgWorkspace members never needed this page — the
 * OrganizationSwitcher dropdown already lets them hop between orgs,
 * and they don't own a portfolio that needs cross-org roll-ups.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-server";

export default async function OrganizationSwitcherRedirect() {
  const session = await getSession(true);
  if (!session?.user?.id) redirect("/auth/signin");

  // `Session["user"].orgWorkspaceProfileId` is part of the customSession
  // return shape in lib/auth.ts — the inferred Session type
  // exposes it directly. No cast needed; the field is real and typed.
  if (session.user.orgWorkspaceProfileId) {
    redirect(`/dashboard/org-workspace/${session.user.orgWorkspaceProfileId}/home`);
  }

  redirect("/dashboard");
}
