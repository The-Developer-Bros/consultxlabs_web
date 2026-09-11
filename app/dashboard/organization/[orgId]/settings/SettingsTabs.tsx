"use client";

/**
 * Settings — general org config, SSO, and the three integrations.
 *
 * SSO and the integrations used to be their own routes; SSO in particular had
 * no sidebar entry at all and was reachable only from a link buried inside the
 * settings page. They're tabs now, addressable as `?tab=`.
 *
 * Each tab carries the gate its old route guard used, so a role that couldn't
 * reach the page can't reach the tab. The gates differ meaningfully:
 * `settings.manage` is GOVERNANCE (OWNER + MAINTAINER), `integrations.read` is
 * the finance set (which includes BILLING_ADMIN), and SSO is an OWNER rank
 * floor — a genuine hierarchy check, not a surface grant. A BILLING_ADMIN
 * therefore lands on Billing and Webhooks with no General tab, which is
 * correct: `billing.manage` is OWNER + BILLING_ADMIN, and the Billing tab
 * carries exactly the two fields the server's field-level gate already let
 * that role write.
 */

import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { UrlTabs, type UrlTab } from "@/components/dashboard/UrlTabs";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

import { useOrgRole } from "../useOrgRole";
import { GeneralPanel } from "./GeneralPanel";
import { BillingSettingsPanel } from "./BillingSettingsPanel";
import { SsoPanel } from "./SsoPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { ScimPanel } from "./ScimPanel";
import { DataExportsPanel } from "./DataExportsPanel";
import { NotificationPreferencesPanel } from "@/components/notifications/NotificationPreferencesPanel";

export function SettingsTabs({ orgId }: { orgId: string }) {
  const { role, isLoading } = useOrgRole(orgId);

  // useOrgRole defaults to LEARNER while loading, which would flash a
  // single-tab bar and then expand. Hold until the role resolves.
  if (isLoading) return null;

  const can = hasOrgPermission.bind(null, role);
  const canIntegrations = can("integrations.read");

  const tabs: UrlTab[] = [
    {
      value: "general",
      label: "General",
      content: <GeneralPanel orgId={orgId} />,
      show: can("settings.manage"),
    },
    {
      value: "sso",
      label: "SSO",
      content: <SsoPanel orgId={orgId} />,
      // Rank floor, not a matrix surface — SSO config is OWNER-only.
      show: role === "OWNER",
    },
    {
      value: "billing",
      label: "Billing",
      content: <BillingSettingsPanel orgId={orgId} />,
      // `billing.manage` (OWNER + BILLING_ADMIN), not `settings.manage`. The
      // server has always let BILLING_ADMIN write these two fields — see
      // BILLING_ADMIN_FIELDS in the org PATCH route — but the only UI for them
      // sat on General behind GOVERNANCE, so the finance role could not reach
      // the billing email it owns.
      show: can("billing.manage"),
    },
    {
      value: "webhooks",
      label: "Webhooks",
      content: <WebhooksPanel orgId={orgId} />,
      show: canIntegrations,
    },
    {
      value: "scim",
      label: "SCIM",
      content: <ScimPanel orgId={orgId} />,
      // #1132 — the SCIM token routes are requireOrgOwner, so showing this on
      // `integrations.read` (which includes MAINTAINER/BILLING_ADMIN/MANAGER)
      // rendered a tab that 403s the moment it loads.
      show: role === "OWNER",
    },
    {
      value: "data-exports",
      label: "Data exports",
      content: <DataExportsPanel orgId={orgId} />,
      // #1132 — the data-export routes are requireOrgBillingAdminOrOwner, so
      // this is `billing.manage`, not the broader `integrations.read`.
      show: can("billing.manage"),
    },
    {
      // ADR 23 — the org dashboard carried a notification bell but no way to
      // configure it, and no org category existed at all, so the whole ORG_*
      // family was unmutable. Deliberately ungated: this configures the
      // VIEWER's own delivery, not org config, so it needs no matrix key and
      // every active member reaches it — the same floor as Appointments and
      // Messages. The preferences themselves are per-user, not per-org, which
      // is why the panel is the same one the personal dashboards mount.
      value: "notifications",
      label: "Notifications",
      content: <NotificationPreferencesPanel />,
    },
  ];

  return (
    <>
      <DashboardHeader
        title="Settings"
        subtitle="Organization profile, sign-on, and integrations"
      />
      <div className="p-4 sm:p-6 lg:p-8">
        <UrlTabs tabs={tabs} />
      </div>
    </>
  );
}
