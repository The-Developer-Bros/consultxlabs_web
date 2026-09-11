import { notFound } from "next/navigation";

import { requireOrgAccess } from "@/lib/auth-helpers";

import { SettingsTabs } from "./SettingsTabs";

/**
 * /dashboard/organization/[orgId]/settings — org config, SSO, integrations.
 *
 * Floors at active membership rather than `settings.manage`, because the tabs
 * behind it answer to two different grants: General is `settings.manage`
 * (GOVERNANCE) while the integrations are `integrations.read` (the finance
 * set, which includes BILLING_ADMIN). Gating the page on either one would
 * lock out a role that legitimately holds the other. Each tab enforces its
 * own gate, and `UrlTabs` renders nothing when none apply.
 */
export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  const access = await requireOrgAccess(orgId);
  if (access.error) {
    notFound();
  }

  return <SettingsTabs orgId={orgId} />;
}
