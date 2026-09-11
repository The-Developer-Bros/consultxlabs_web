/**
 * Layout for the org-switcher surface — the routes that live under
 * `/dashboard/organization` BUT are not nested inside a specific org's
 * dashboard:
 *   - /dashboard/organization        (switcher list — page.tsx here)
 *   - /dashboard/organization/create (create-org wizard)
 *
 * The (switcher) route group keeps this layout from cascading into
 * `/[orgId]/*`, which has its own per-org chrome with the rich
 * CollapsibleSidebar. Without the group, every per-org page would
 * render this slim top-bar above the sidebar — visually broken and
 * structurally redundant.
 *
 * Wraps with NovuProvider so NotificationInbox in the top bar can
 * subscribe to in-app notifications. Mirrors app/dashboard/admin/layout.
 */

import NovuProvider from "@/providers/NovuProvider";
import { OrgSwitcherTopBar } from "@/components/dashboard/OrgSwitcherTopBar";

export default function OrganizationSwitcherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance min-h-0 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-950">
        <OrgSwitcherTopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="p-6">{children}</div>
        </main>
      </div>
    </NovuProvider>
  );
}
