"use client";

/**
 * Staff dashboard chrome. Sits inside the server `layout.tsx`, which runs the
 * access guard and resolves the identity props server-side.
 *
 * The nav array used to live here as a flat list of 16 items, duplicated
 * almost item-for-item in AdminShell. Both shells now build from
 * `buildBackofficeNav`, so the two trees can't drift apart again — this tree
 * simply resolves fewer items out of the same definition, because
 * BACKOFFICE_PERMISSIONS grants STAFF fewer surfaces.
 *
 * The nav is built for STAFF even when an admin is viewing this tree: the
 * reason to open it as an admin is to see what a staff member sees.
 *
 * Settings lives in the bottom user chip rather than the nav, matching the
 * admin tree — it's the operator's own profile, not a platform surface.
 */

import { useMemo } from "react";
import { Settings } from "lucide-react";

import {
  OperatorDashboardShell,
  type OperatorDashboardShellProps,
} from "@/components/dashboard/OperatorDashboardShell";
import { buildBackofficeNav } from "@/lib/dashboard/backoffice-nav";

export function StaffShell({
  staffId,
  userName,
  userEmail,
  userImage,
  children,
}: { staffId: string } & Pick<
  OperatorDashboardShellProps,
  "userName" | "userEmail" | "userImage" | "children"
>) {
  const groups = useMemo(() => buildBackofficeNav("staff"), []);
  const basePath = `/dashboard/staff/${staffId}`;

  return (
    <OperatorDashboardShell
      sidebarGroups={groups}
      basePath={basePath}
      title="Staff Portal"
      breadcrumbRoot="Staff"
      footerLabel="Familiarise Staff v1.0"
      avatarFallback="S"
      userName={userName}
      userEmail={userEmail}
      userImage={userImage}
      bottomUserChipRole="Staff"
      bottomUserChipActions={[
        {
          type: "item",
          label: "Settings",
          href: `${basePath}/settings`,
          icon: Settings,
        },
      ]}
      prefetchPaths={[`${basePath}/home`, `${basePath}/tickets`]}
    >
      {children}
    </OperatorDashboardShell>
  );
}
