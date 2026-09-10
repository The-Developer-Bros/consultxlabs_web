"use client";

/**
 * Shared chrome for the operator-class dashboards (admin, staff) — the
 * cross-cutting internal surfaces that manage the whole platform rather
 * than one org or one personal account.
 *
 * Chrome contract matches the org / org-workspace flagship: a full
 * CollapsibleSidebar (which owns its own mobile drawer, since these trees
 * carry 16+ nav items and can't collapse to a bottom tab bar) plus a sticky
 * h-14 DashboardContextBar carrying the identity, a breadcrumb trail, and a
 * right slot (OrganizationSwitcher + notification bell). Page content is
 * wrapped in the shared DashboardErrorBoundary.
 *
 * Access is enforced upstream in the server layout; this component is chrome
 * only. Identity arrives as server-resolved props (no useSession first-render
 * null → no hydration mismatch on the displayed name).
 */

import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import { usePathname } from "next/navigation";
import { UserRound } from "lucide-react";

import NovuProvider from "@/providers/NovuProvider";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { DashboardContextBar } from "@/components/dashboard/DashboardContextBar";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
  type CollapsibleSidebarGroup,
  type CollapsibleSidebarProps,
} from "@/components/dashboard/CollapsibleSidebar";
import { signOutEverywhere } from "@/lib/auth/sign-out";

/** Title-case a path segment for the breadcrumb when it isn't a nav item
 *  (e.g. a detail sub-route like `tickets/abc123`). */
function prettifySegment(segment: string): string {
  return segment
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface OperatorDashboardShellProps {
  /**
   * Flat sidebar nav; item.name doubles as the breadcrumb label per path.
   * Mutually exclusive with `sidebarGroups` — pass one or the other.
   */
  sidebarItems?: CollapsibleSidebarItem[];
  /**
   * Grouped sidebar nav. The merged back-office uses this: 21 items in one
   * flat list stopped being scannable, and the groups double as the
   * staff-vs-admin story (a staff member simply has fewer items per group,
   * and empty groups elide).
   */
  sidebarGroups?: CollapsibleSidebarGroup[];
  /** e.g. "/dashboard/admin". */
  basePath: string;
  /** Sidebar header title, e.g. "Admin Portal". */
  title: string;
  /** Root breadcrumb crumb, e.g. "Admin". */
  breadcrumbRoot: string;
  footerLabel?: string;
  avatarFallback: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  /** Routes to warm on mount (idle-scheduled). */
  prefetchPaths?: string[];
  /**
   * Bottom user-chip dropdown entries, forwarded to CollapsibleSidebar.
   * The back-office uses this to surface Settings, which previously had no
   * nav entry and no inbound link at all.
   */
  bottomUserChipActions?: CollapsibleSidebarProps["bottomUserChipActions"];
  /**
   * Role badge for the bottom chip (e.g. "Admin", "Staff"). Required for the
   * chip to render — CollapsibleSidebar only shows the dropdown when both
   * the chip and its actions are present.
   */
  bottomUserChipRole?: string;
  children: React.ReactNode;
}

export function OperatorDashboardShell({
  sidebarItems,
  sidebarGroups,
  basePath,
  title,
  breadcrumbRoot,
  footerLabel,
  avatarFallback,
  userName,
  userEmail,
  userImage,
  prefetchPaths,
  bottomUserChipActions,
  bottomUserChipRole,
  children,
}: OperatorDashboardShellProps) {
  const pathname = usePathname() ?? "";

  // Sync user as Novu subscriber (once per session)
  useNovuSubscriberSync();

  // Warm the RSC payloads for this operator tree's top destinations.
  usePrefetchNavPaths(prefetchPaths ?? []);

  const displayName = userName || "Operator";

  // Active page label for the breadcrumb: the first segment after the base
  // path, mapped to its sidebar item name (or a prettified fallback for
  // detail sub-routes not present in the sidebar).
  // Flatten once so breadcrumb lookup works identically for the flat and
  // grouped APIs. Multi-segment paths (e.g. "integrations/webhooks") are
  // matched first so they don't fall through to the prettified fallback.
  const flatItems = sidebarGroups
    ? sidebarGroups.flatMap((g) => g.items)
    : (sidebarItems ?? []);

  const rest = pathname.slice(basePath.length).split("/").filter(Boolean);
  const segment = rest[0];
  const activeItem =
    flatItems.find((i) => i.path === rest.slice(0, 2).join("/")) ??
    flatItems.find((i) => i.path === segment);
  const pageLabel = activeItem
    ? activeItem.name
    : segment
      ? prettifySegment(segment)
      : (flatItems[0]?.name ?? "");

  return (
    <NovuProvider>
      <div className="flex h-screen-maintenance overflow-hidden bg-background">
        <CollapsibleSidebar
          items={sidebarGroups ? undefined : sidebarItems}
          groups={sidebarGroups}
          basePath={basePath}
          title={title}
          footerLabel={footerLabel}
          avatarFallback={avatarFallback}
          userName={displayName}
          userEmail={userEmail ?? undefined}
          userImage={userImage}
          bottomUserChip={
            bottomUserChipRole
              ? {
                  name: displayName,
                  image: userImage,
                  role: bottomUserChipRole,
                }
              : undefined
          }
          bottomUserChipActions={bottomUserChipActions}
          pathname={pathname}
          onSignOut={() => void signOutEverywhere()}
        />

        {/* Right panel: context bar + scrolling page content */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <DashboardContextBar
            identity={{
              name: displayName,
              image: userImage,
              FallbackIcon: UserRound,
            }}
            breadcrumbs={[breadcrumbRoot, pageLabel]}
            rightSlot={
              <div className="flex items-center gap-2">
                <OrganizationSwitcher />
                <NotificationInbox />
              </div>
            }
          />

          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="p-6">
              <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </NovuProvider>
  );
}
