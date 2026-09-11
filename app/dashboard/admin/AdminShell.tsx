"use client";

/**
 * Admin dashboard chrome. Sits inside the server `layout.tsx`, which runs the
 * requireUserRole("ADMIN") guard and resolves the identity props server-side.
 *
 * The nav array used to live here as a flat list of 17 items, duplicated
 * almost item-for-item in StaffShell. Both shells now build from
 * `buildBackofficeNav`, so the two trees can't drift apart again — the admin
 * tree simply resolves more items out of the same definition.
 *
 * Settings lives in the bottom user chip rather than the nav: it's the
 * operator's own profile page, not a platform surface. It previously had no
 * entry anywhere and zero inbound links, so it was unreachable.
 */

import { useMemo } from "react";
import { Settings } from "lucide-react";

import {
  OperatorDashboardShell,
  type OperatorDashboardShellProps,
} from "@/components/dashboard/OperatorDashboardShell";
import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";

export function AdminShell({
  userName,
  userEmail,
  userImage,
  children,
  // #863 — the TDS surface is flag-gated (ENABLE_TDS_ADMIN_VIEW). The server
  // layout reads the flag and passes it, so the nav item only appears when the
  // page would actually resolve (no link that 404s).
  showTds = false,
}: Pick<
  OperatorDashboardShellProps,
  "userName" | "userEmail" | "userImage" | "children"
> & { showTds?: boolean }) {
  const groups = useMemo(
    () => buildBackofficeNav("admin", { showTds }),
    [showTds],
  );

  return (
    <OperatorDashboardShell
      sidebarGroups={groups}
      basePath="/dashboard/admin"
      title="Admin Portal"
      breadcrumbRoot="Admin"
      footerLabel="Familiarise Admin v1.0"
      avatarFallback="A"
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
      bottomUserChipRole="Admin"
      bottomUserChipActions={[
        {
          type: "item",
          label: "Settings",
          href: "/dashboard/admin/settings",
          icon: Settings,
        },
      ]}
      prefetchPaths={["/dashboard/admin/home", "/dashboard/admin/payments"]}
    >
      {children}
    </OperatorDashboardShell>
  );
}
