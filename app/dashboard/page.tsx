import { redirect } from "next/navigation";
import { requireOnboarded } from "@/lib/auth-guard";
import { resolvePersonalDashboardHref } from "@/lib/labels/personal-dashboard";

// Server-side dashboard router. requireOnboarded() guarantees an onboarded
// session carrying role + profile FKs + organizationMemberships (auth.ts
// customSession), so we resolve the landing here — no client fetch. redirect()
// throws by design; do not wrap it in a swallowing try/catch.
//
// Operator/staff/admin are distinct identities and route by role. Consumer
// identities route by CAPABILITY: prefer the onboarding role's home, then any
// personal facet the user's profiles provide, then an org they belong to — so a
// dual-profile / org-only user is never stranded on a role whose profile is absent.
export default async function Dashboard() {
  const { user } = await requireOnboarded();

  let target: string;
  if (user.role === "ADMIN") {
    target = "/dashboard/admin/home";
  } else if (user.role === "STAFF") {
    target = user.staffProfileId
      ? `/dashboard/staff/${user.staffProfileId}/home`
      : "/";
  } else if (user.role === "ORG_WORKSPACE") {
    // Mirrors /dashboard/organization so a multi-org operator lands on the
    // cross-org portfolio. No profile yet (#724) → the create wizard.
    target = user.orgWorkspaceProfileId
      ? `/dashboard/org-workspace/${user.orgWorkspaceProfileId}/home`
      : "/dashboard/organization";
  } else {
    const roleHome =
      user.role === "CONSULTEE" && user.consulteeProfileId
        ? `/dashboard/consultee/${user.consulteeProfileId}/home`
        : user.role === "CONSULTANT" && user.consultantProfileId
          ? `/dashboard/consultant/${user.consultantProfileId}/home`
          : null;
    const firstOrg = user.organizationMemberships?.[0]?.organizationId;
    target =
      roleHome ??
      resolvePersonalDashboardHref(user) ??
      (firstOrg ? `/dashboard/organization/${firstOrg}/home` : null) ??
      "/dashboard/error";
  }

  redirect(target);
}
