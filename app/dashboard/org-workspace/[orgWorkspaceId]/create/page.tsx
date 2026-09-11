/**
 * Create-org wizard for an existing OrgWorkspace operator. Renders the
 * same `<CreateOrganizationWizard />` as /dashboard/organization/create
 * but inside the operator dashboard sidebar chrome — so an OrgWorkspace
 * operator starting their 2nd, 3rd, … org never gets bumped out of the chrome
 * they're already in.
 *
 * Cancel target is the operator overview (where they came from).
 * Success redirect is the same in both entry points (the wizard always
 * routes to /dashboard/organization/<newOrgId>/home).
 *
 * Server component so it can read ENABLE_HOST_ORGS (#863) and hide the host
 * capability when off; the wizard itself is a client component.
 */

import { CreateOrganizationWizard } from "@/components/organization/create-wizard/Wizard";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";

export default async function OrgWorkspaceCreatePage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  return (
    <CreateOrganizationWizard
      cancelHref={`/dashboard/org-workspace/${orgWorkspaceId}/home`}
      hostOrgsEnabled={ENABLE_HOST_ORGS}
    />
  );
}
