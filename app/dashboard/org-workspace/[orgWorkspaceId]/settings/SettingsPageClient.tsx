"use client";

/**
 * OrgWorkspace operator settings.
 *
 * Three independent sections, each with its own Save button so a slow
 * Save in one section doesn't block edits in another:
 *
 *   - Default landing organisation
 *   - Notification routing
 *   - Locale + currency display
 *
 * The IDOR-protecting `auth.session.user.orgWorkspaceProfileId !==
 * orgWorkspaceId` check is enforced server-side on every API call.
 * The page itself is reachable only via the OrgWorkspaceShell sidebar,
 * which the layout already scopes to the caller's own workspace.
 *
 * Client half of the split page. The server `page.tsx` SSR-prefetches the
 * settings payload under ["org-workspace-settings", orgWorkspaceId]; the
 * useQuery below hydrates from that cache verbatim.
 */

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { DefaultLandingOrgSection } from "./components/DefaultLandingOrgSection";
import { LocaleAndCurrencySection } from "./components/LocaleAndCurrencySection";
import { NotificationRoutingSection } from "./components/NotificationRoutingSection";
import { fetchSettings } from "./utils/api";

export function SettingsPageClient({
  orgWorkspaceId,
}: {
  orgWorkspaceId: string;
}) {
  const settings = useQuery({
    queryKey: ["org-workspace-settings", orgWorkspaceId],
    queryFn: () => fetchSettings(orgWorkspaceId),
  });

  return (
    <>
      <DashboardHeader
        title="Settings"
        subtitle="Operator-level preferences across all your organisations. Per-org settings (branding, SSO, billing configuration) live on each organisation's own Settings page."
      />

      <DashboardContent>
        {settings.isLoading ? (
          <Card>
            <CardContent className="py-8 flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
              preferences…
            </CardContent>
          </Card>
        ) : settings.isError || !settings.data ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-red-700">
                Couldn’t load preferences
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-zinc-600">
              <p>
                If the problem persists, contact support — the workspace
                profile row may be missing.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => settings.refetch()}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <DefaultLandingOrgSection
              orgWorkspaceId={orgWorkspaceId}
              current={settings.data.profile.defaultLandingOrganizationId}
              candidates={settings.data.candidateOrgs}
            />
            <NotificationRoutingSection
              orgWorkspaceId={orgWorkspaceId}
              current={settings.data.profile.notificationRoutingMode}
            />
            <LocaleAndCurrencySection
              orgWorkspaceId={orgWorkspaceId}
              currentLocale={settings.data.profile.locale}
              currentCurrency={settings.data.profile.currencyDisplayCode}
            />
          </div>
        )}
      </DashboardContent>
    </>
  );
}
