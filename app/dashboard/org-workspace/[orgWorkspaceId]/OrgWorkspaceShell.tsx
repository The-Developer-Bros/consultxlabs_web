"use client";

/**
 * Client-side shell for the org-workspace (operator) dashboard. Sits inside
 * the server-side layout that runs the IDOR guard and resolves the user
 * identity props on the server (so the sidebar's displayed name is the same
 * on the server-rendered HTML and the first client render — no hydration
 * mismatch).
 *
 * Same chrome contract as the other role dashboards: a collapsible sidebar
 * (md+), a sticky h-14 DashboardContextBar, and a mobile bottom tab bar
 * (<md) so the w-64 aside never crushes the content column on a phone.
 *
 * Visual differentiation from the per-org dashboard: the sidebar carries a
 * jet-black gradient accent (via CollapsibleSidebar's `className` prop, with
 * `dark` scoped to the aside) — the one cue that says "cross-org operator",
 * not "inside a single org". Per-org operator surfaces (members, programs,
 * payouts) live one level deeper at /dashboard/organization/[orgId]/*.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  CreditCard,
  Home,
  LifeBuoy,
  Settings,
  UserRound,
} from "lucide-react";

import {
  CollapsibleSidebar,
  type CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import { DashboardContextBar } from "@/components/dashboard/DashboardContextBar";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { isActiveRoute } from "@/components/dashboard/route-active";
import { LinkPendingIcon } from "@/components/ui/NavLink";
import { OrganizationSwitcher } from "@/components/dashboard/OrganizationSwitcher";
import { useNovuSubscriberSync } from "@/hooks/useNovuSubscriberSync";
import { usePrefetchNavPaths } from "@/hooks/usePrefetchNavPaths";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";
import { signOutEverywhere } from "@/lib/auth/sign-out";

/**
 * Cross-org portfolio nav.
 *
 * "Billing" and "Settings" used to collide head-on with the per-org
 * dashboard's own Billing and Settings entries — same words, different scope,
 * and an operator moving between the two layers had no way to tell which one
 * they were looking at. Both are renamed for what they actually are: a
 * read-only roll-up of spend across orgs, and preferences that belong to the
 * workspace rather than to any single org (default landing org, locale,
 * notification routing).
 */
const sidebarItems: CollapsibleSidebarItem[] = [
  { name: "Overview", icon: Home, path: "home" },
  { name: "Activity", icon: Activity, path: "activity" },
  { name: "Spend", icon: CreditCard, path: "billing" },
  { name: "Workspace settings", icon: Settings, path: "settings" },
  // Operators had no support surface at all until this entry — see
  // support/page.tsx.
  { name: "Support", icon: LifeBuoy, path: "support" },
];

/** Breadcrumb labels per first path segment (mirrors the sidebar + /create). */
const PAGE_LABELS: Record<string, string> = {
  home: "Overview",
  activity: "Activity",
  billing: "Spend",
  settings: "Workspace settings",
  support: "Support",
  create: "New organization",
};

export function OrgWorkspaceShell({
  orgWorkspaceId,
  userName,
  userEmail,
  userImage,
  children,
}: {
  orgWorkspaceId: string;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  children: React.ReactNode;
}) {
  // ADR 23 — see the org layout. This tree also carries a bell but never
  // synced the subscriber behind it, and it is where the routing-mode
  // preference is set, so the sync has to run here for that to take effect.
  useNovuSubscriberSync();

  // usePathname() returns the URL-encoded path, while orgWorkspaceId (from
  // route params) is decoded — decode so basePath.slice + isActiveRoute compare
  // like-for-like even for ids that need encoding. `?? ""` guards a null path;
  // the try/catch guards a malformed %-sequence (decodeURIComponent throws a
  // URIError) — fall back to the raw path so a bad URL never blanks the shell.
  const rawPathname = usePathname() ?? "";
  let pathname = rawPathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    pathname = rawPathname;
  }
  const basePath = `/dashboard/org-workspace/${orgWorkspaceId}`;

  // Idle-warm the RSC payloads for the workspace tree's top destinations —
  // this shell previously had zero nav warming, so the first click on any
  // tab always paid a full RSC round trip after the Router Cache's 30s
  // dynamic window. Overview + Activity + Spend cover the operator's core
  // loop; settings/support are low-frequency first-clicks.
  usePrefetchNavPaths([
    `${basePath}/home`,
    `${basePath}/activity`,
    `${basePath}/billing`,
  ]);

  const displayName = userName ?? "Operator";
  const avatarFallback = displayName.charAt(0).toUpperCase();

  // Active page label for the context-bar breadcrumb trail. The segment is
  // the first path part after the workspace id (defaults to the overview).
  const segment =
    pathname.slice(basePath.length).split("/").filter(Boolean)[0] ?? "home";
  const pageLabel = PAGE_LABELS[segment] ?? "Overview";

  return (
    <div className="flex h-screen-maintenance overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* Sidebar — hidden on mobile, visible md+ */}
      <div className="hidden h-full shrink-0 md:block">
        <CollapsibleSidebar
          items={sidebarItems}
          basePath={basePath}
          title="All organizations"
          avatarFallback={avatarFallback}
          userName={displayName}
          userEmail={userEmail ?? undefined}
          userImage={userImage}
          userSubtitle="Cross-org portfolio"
          pathname={pathname}
          onSignOut={() => void signOutEverywhere()}
          // Jet-black sidebar accent via the shared className prop. The
          // component's text/icons use `text-zinc-900 dark:text-zinc-100`
          // pairs, so scoping `dark` to this aside (Tailwind class strategy)
          // flips copy + icons to light without touching any other surface.
          className="dark bg-gradient-to-b from-black via-zinc-900 to-black"
        />
      </div>

      {/* Right panel: context bar + page content + mobile tabs */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <DashboardContextBar
          identity={{
            name: displayName,
            image: userImage,
            FallbackIcon: UserRound,
          }}
          breadcrumbs={["All organizations", pageLabel]}
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

        {/* Mobile bottom tab bar — only visible below md breakpoint. The
            safe-area inset keeps the tabs clear of the iPhone home indicator.
            In normal flow at the column's end (not fixed), so it takes real
            layout space and <main> needs no compensating bottom padding. */}
        <nav className="md:hidden shrink-0 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 flex pb-[env(safe-area-inset-bottom)]">
          {sidebarItems.map(({ name, icon: Icon, path }) => {
            const isActive = isActiveRoute(pathname, basePath, path);
            return (
              <Link
                key={path}
                href={`${basePath}/${path}`}
                aria-current={isActive ? "page" : undefined}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors ${
                  isActive
                    ? "text-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                <LinkPendingIcon
                  Icon={Icon}
                  className={`h-5 w-5 ${isActive ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500"}`}
                />
                {name}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
