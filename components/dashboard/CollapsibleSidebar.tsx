"use client";

import { cn } from "@/utils/tailwind";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronsUpDown, LogOut, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LinkPendingIcon } from "@/components/ui/NavLink";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { isActiveRoute } from "@/components/dashboard/route-active";

export interface CollapsibleSidebarItem {
  name: string;
  icon: LucideIcon;
  path: string;
  /**
   * Optional notification badge (e.g. unread chat count). Rendered as a
   * right-aligned pill when expanded and a dot on the icon when collapsed.
   */
  badge?: string | number;
}

/**
 * A labelled cluster of nav items. Groups give the per-org sidebar (~20
 * items) a scanable IA — People / Commerce / Operations / Insights /
 * Configuration. Optional `defaultCollapsed` lets a caller hide an
 * "Operations" cluster from an OWNER who doesn't routinely need
 * appointment-level data in the primary nav.
 *
 * Omitting `label` renders the items as a top-level cluster without a
 * header — used for the always-visible "Overview" link.
 */
export interface CollapsibleSidebarGroup {
  label?: string;
  items: CollapsibleSidebarItem[];
  /** Initial collapsed state. Defaults to false (group open). */
  defaultCollapsed?: boolean;
}

export interface CollapsibleSidebarProps {
  /**
   * Items to render in the nav list (flat list, in order). Mutually
   * exclusive with `groups` — provide one or the other. Kept for the
   * staff / admin / workspace dashboards that don't need clustering.
   */
  items?: CollapsibleSidebarItem[];
  /**
   * Grouped items. When provided, rendered as collapsible sections
   * with optional headers. The per-org sidebar uses this; the simpler
   * dashboards stay on the flat `items` API.
   */
  groups?: CollapsibleSidebarGroup[];
  /** Base path that gets prepended to each `item.path` to build the link href. */
  basePath: string;
  /** Title shown in the sidebar header (e.g. "Staff Portal", "Admin Portal"). */
  title: string;
  /** Footer label shown when expanded (e.g. "Familiarise Staff v1.0"). */
  footerLabel?: string;
  /** Avatar fallback letter if user has no image / name. */
  avatarFallback?: string;
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
  /**
   * When provided, a personal user chip is rendered at the bottom of the
   * sidebar (VS Code / Linear style). The header avatar then represents the
   * entity (org, portal) rather than the person. `role` is shown as a small
   * muted badge below the user's name.
   */
  bottomUserChip?: {
    name: string | null;
    image: string | null;
    role: string;
  };
  /**
   * When provided alongside `bottomUserChip`, the chip becomes a dropdown
   * trigger. Each entry is either a labelled action or a visual separator.
   * Use this to wire up "Personal Dashboard", org-switch links, and Sign Out
   * so all context-switching lives in one discoverable place.
   */
  bottomUserChipActions?: Array<
    | { type: "item"; label: string; href?: string; onClick?: () => void; icon?: LucideIcon }
    | { type: "separator" }
    | { type: "label"; label: string }
  >;
  /**
   * When provided, the top header (avatar + title + subtitle) becomes a
   * dropdown trigger. Used by the org dashboard to expose the org switcher
   * at the top of the sidebar (the Linear / Agentstack pattern): the top
   * answers "which context am I in?" while the bottom chip answers
   * "who am I?".
   */
  topDropdownActions?: Array<
    | { type: "item"; label: string; href?: string; onClick?: () => void; icon?: LucideIcon }
    | { type: "separator" }
    | { type: "label"; label: string }
  >;
  /** Optional subtitle shown under `userName` in the top header (e.g. "Buyer · SEAT_PACK"). */
  userSubtitle?: string | null;
  /** Current pathname (from `usePathname()`). Used to compute active state. */
  pathname: string;
  /** Sign-out handler invoked when the footer button is clicked. */
  onSignOut: () => void;
  /**
   * Extra classes appended to the outer `<aside>`. Lets a caller
   * override or extend the default `bg-white` so different dashboard
   * roles can carry distinct sidebar accents (e.g. operator chrome
   * uses a silver gradient to differentiate from per-org chrome).
   * Cascade order: defaults first, then this prop — so a `bg-*` here
   * wins over the default `bg-white`.
   */
  className?: string;
}

/**
 * Shared collapsible flat sidebar used by both the Staff and Admin dashboards.
 *
 * Visual contract: a vertical white/zinc panel with a profile header, an icon-only
 * collapse toggle, a flat list of nav links with icons (tooltips when collapsed),
 * and a footer Sign Out button. Width animates between `w-64` (expanded) and
 * `w-16` (collapsed).
 */
export function CollapsibleSidebar({
  items,
  groups,
  basePath,
  title,
  footerLabel,
  avatarFallback,
  userName,
  userEmail,
  userImage,
  userSubtitle,
  bottomUserChip,
  bottomUserChipActions,
  topDropdownActions,
  pathname,
  onSignOut,
  className,
}: CollapsibleSidebarProps) {
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  // An EMPTY array is truthy, so a consultant with no org memberships still got
  // the switcher chrome — a chevron opening a menu containing nothing. Labels
  // and separators alone are not something to switch TO either, so the chip
  // only becomes a dropdown when there is at least one real destination in it.
  const hasChipActions = !!bottomUserChipActions?.some(
    (action) => action.type === "item",
  );

  // Per-group collapsed map, keyed by the group's label. Defaults to
  // each group's `defaultCollapsed` on first render so callers can
  // hint "Operations" closed for OWNER while leaving People + Commerce
  // open. Headerless groups never collapse (they have no toggle).
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>(
    () => {
      const init: Record<string, boolean> = {};
      for (const g of groups ?? []) {
        if (g.label) init[g.label] = !!g.defaultCollapsed;
      }
      return init;
    },
  );

  const isActive = (path: string) => isActiveRoute(pathname, basePath, path);

  /** Navigate to the tab root even when already under a nested child route. */
  const goToNavPath = (path: string) => {
    const href = path ? `${basePath}/${path}` : basePath;
    if (pathname === href) return;
    router.push(href);
  };

  const fallbackChar =
    avatarFallback ??
    userName?.charAt(0)?.toUpperCase() ??
    title.charAt(0).toUpperCase();

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-border bg-card transition-all duration-300",
        collapsed ? "w-16" : "w-64",
        className,
      )}
    >
      {/* Header: single-row layout, fixed h-14 to pixel-match the
          DashboardContextBar's h-14 so the sidebar / top-bar border
          intersection lines up cleanly at the crossroad. */}
      <div className="border-b border-border">
        <div
          className={cn(
            "flex items-center gap-1 h-14 px-2",
            collapsed && "h-auto flex-col gap-2 py-2",
          )}
        >
          {/* Identity block (dropdown or static) — takes all remaining space */}
          {topDropdownActions ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-3 flex-1 min-w-0 px-2 py-1.5 rounded-md text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors",
                    collapsed && "w-full justify-center px-0",
                  )}
                  aria-label="Switch context"
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarImage src={userImage || ""} alt={userName || ""} />
                    <AvatarFallback className="bg-primary text-primary-foreground font-semibold text-xs">
                      {fallbackChar}
                    </AvatarFallback>
                  </Avatar>
                  {!collapsed && (
                    <>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                          {userName || title}
                        </p>
                        {(userSubtitle ?? userEmail) && (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate leading-tight mt-0.5">
                            {userSubtitle ?? userEmail}
                          </p>
                        )}
                      </div>
                      <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" />
                    </>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="start" className="w-60">
                {topDropdownActions.map((action, i) => {
                  if (action.type === "separator") {
                    return <DropdownMenuSeparator key={i} />;
                  }
                  if (action.type === "label") {
                    return (
                      <DropdownMenuLabel
                        key={i}
                        className="text-xs text-zinc-400 font-normal py-1"
                      >
                        {action.label}
                      </DropdownMenuLabel>
                    );
                  }
                  const Icon = action.icon;
                  return (
                    <DropdownMenuItem
                      key={i}
                      asChild={!!action.href}
                      onClick={!action.href ? action.onClick : undefined}
                      className="cursor-pointer gap-2"
                    >
                      {action.href ? (
                        <Link href={action.href} className="flex items-center gap-2 w-full">
                          {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
                          {action.label}
                        </Link>
                      ) : (
                        <>
                          {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
                          {action.label}
                        </>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div
              className={cn(
                "flex items-center gap-3 flex-1 min-w-0 px-2 py-1.5",
                collapsed && "w-full justify-center px-0",
              )}
            >
              <Avatar className="h-9 w-9 flex-shrink-0">
                <AvatarImage src={userImage || ""} alt={userName || ""} />
                <AvatarFallback className="bg-primary text-primary-foreground font-semibold text-xs">
                  {fallbackChar}
                </AvatarFallback>
              </Avatar>
              {!collapsed && (
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                    {userName || title}
                  </p>
                  {(userSubtitle ?? userEmail) && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate leading-tight mt-0.5">
                      {userSubtitle ?? userEmail}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Collapse toggle — icon-only, sits next to the switcher */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="h-7 w-7 flex-shrink-0 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-4">
        <TooltipProvider delayDuration={0}>
          {groups ? (
            // Grouped render — used by the per-org sidebar. Each group
            // gets an optional clickable header that toggles its items'
            // visibility. When the whole sidebar is in icon-only mode,
            // group headers hide and all items render flat so the user
            // can still navigate via tooltips.
            <div className="space-y-3 px-3">
              {groups.map((group, gi) => {
                const isHeaderless = !group.label;
                const isGroupCollapsed =
                  !collapsed && !isHeaderless && groupCollapsed[group.label!];

                return (
                  <div key={group.label ?? `__group_${gi}`}>
                    {!collapsed && group.label && (
                      <button
                        type="button"
                        onClick={() =>
                          setGroupCollapsed((prev) => ({
                            ...prev,
                            [group.label!]: !prev[group.label!],
                          }))
                        }
                        className="flex items-center gap-1 w-full px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                        aria-expanded={!isGroupCollapsed}
                      >
                        <ChevronDown
                          className={cn(
                            "h-3 w-3 transition-transform",
                            isGroupCollapsed && "-rotate-90",
                          )}
                        />
                        {group.label}
                      </button>
                    )}

                    {!isGroupCollapsed && (
                      <ul className="space-y-1">
                        {group.items.map((item) => (
                          <li key={item.path}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Link
                                  href={`${basePath}/${item.path}`}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    goToNavPath(item.path);
                                  }}
                                  aria-label={collapsed ? item.name : undefined}
                                  aria-current={
                                    isActive(item.path) ? "page" : undefined
                                  }
                                  className={cn(
                                    "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                                    isActive(item.path)
                                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                                      : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
                                  )}
                                >
                                  <LinkPendingIcon Icon={item.icon} />
                                  {collapsed ? (
                                    <span className="sr-only">{item.name}</span>
                                  ) : (
                                    <span className="flex-1 min-w-0 truncate">
                                      {item.name}
                                    </span>
                                  )}
                                  {item.badge !== undefined &&
                                    (collapsed ? (
                                      <span
                                        className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-red-500"
                                        aria-hidden
                                      />
                                    ) : (
                                      <span className="ml-auto shrink-0 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white min-w-[18px]">
                                        {item.badge}
                                      </span>
                                    ))}
                                </Link>
                              </TooltipTrigger>
                              {collapsed && (
                                <TooltipContent side="right">
                                  {item.name}
                                </TooltipContent>
                              )}
                            </Tooltip>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <ul className="space-y-1.5 px-3">
              {(items ?? []).map((item) => (
                <li key={item.path}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={`${basePath}/${item.path}`}
                        onClick={(e) => {
                          e.preventDefault();
                          goToNavPath(item.path);
                        }}
                        aria-label={collapsed ? item.name : undefined}
                        aria-current={isActive(item.path) ? "page" : undefined}
                        className={cn(
                          "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                          isActive(item.path)
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800",
                        )}
                      >
                        <LinkPendingIcon Icon={item.icon} />
                        {collapsed ? (
                          <span className="sr-only">{item.name}</span>
                        ) : (
                          <span className="flex-1 min-w-0 truncate">
                            {item.name}
                          </span>
                        )}
                        {item.badge !== undefined &&
                          (collapsed ? (
                            <span
                              className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-red-500"
                              aria-hidden
                            />
                          ) : (
                            <span className="ml-auto shrink-0 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white min-w-[18px]">
                              {item.badge}
                            </span>
                          ))}
                      </Link>
                    </TooltipTrigger>
                    {collapsed && (
                      <TooltipContent side="right">{item.name}</TooltipContent>
                    )}
                  </Tooltip>
                </li>
              ))}
            </ul>
          )}
        </TooltipProvider>
      </nav>

{/* Footer */}
      <div className="border-t border-zinc-200 dark:border-zinc-800 p-2 space-y-1">
        {/* Personal chip — a dropdown only when there is somewhere to go (the
            org switcher lives here), otherwise a static strip. Sign Out remains
            a separate standalone red button below. */}
        {bottomUserChip && hasChipActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300",
                  collapsed && "justify-center px-0 border-transparent bg-transparent",
                )}
                aria-label="Switch context"
              >
                <Avatar className="h-7 w-7 flex-shrink-0">
                  <AvatarImage src={bottomUserChip.image || ""} alt={bottomUserChip.name || ""} />
                  <AvatarFallback className="bg-zinc-700 text-white text-xs font-semibold">
                    {(bottomUserChip.name ?? "U").charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                        {bottomUserChip.name}
                      </p>
                      <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate leading-tight mt-0.5">
                        {bottomUserChip.role}
                      </p>
                    </div>
                    <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-60">
              {(bottomUserChipActions ?? []).map((action, i) => {
                if (action.type === "separator") {
                  return <DropdownMenuSeparator key={i} />;
                }
                if (action.type === "label") {
                  return (
                    <DropdownMenuLabel
                      key={i}
                      className="text-xs text-zinc-400 font-normal py-1"
                    >
                      {action.label}
                    </DropdownMenuLabel>
                  );
                }
                const Icon = action.icon;
                return (
                  <DropdownMenuItem
                    key={i}
                    asChild={!!action.href}
                    onClick={!action.href ? action.onClick : undefined}
                    className="cursor-pointer gap-2"
                  >
                    {action.href ? (
                      <Link href={action.href} className="flex items-center gap-2 w-full">
                        {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
                        {action.label}
                      </Link>
                    ) : (
                      <>
                        {Icon && <Icon className="h-4 w-4 text-zinc-500" />}
                        {action.label}
                      </>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : bottomUserChip ? (
          <div
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40",
              collapsed && "justify-center px-0 border-transparent bg-transparent",
            )}
          >
            <Avatar className="h-7 w-7 flex-shrink-0">
              <AvatarImage src={bottomUserChip.image || ""} alt={bottomUserChip.name || ""} />
              <AvatarFallback className="bg-zinc-700 text-white text-xs font-semibold">
                {(bottomUserChip.name ?? "U").charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                  {bottomUserChip.name}
                </p>
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate leading-tight mt-0.5">
                  {bottomUserChip.role}
                </p>
              </div>
            )}
          </div>
        ) : null}

        {/* Sign Out — always rendered below the chip/dropdown */}
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onSignOut}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950",
                  collapsed && "justify-center",
                )}
              >
                <LogOut className="h-5 w-5 flex-shrink-0" />
                {!collapsed && <span>Sign Out</span>}
              </button>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right">Sign Out</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>

        {!collapsed && footerLabel && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3 px-3">
            {footerLabel}
          </p>
        )}
      </div>
    </aside>
  );
}

/**
 * Full-page loading skeleton that matches {@link CollapsibleSidebar}'s
 * visual footprint (sidebar + content column).
 *
 * Use only as a *layout* fallback — when the shell itself has not mounted
 * yet (e.g. admin/staff/org client layouts before session data). Do NOT use
 * inside a segment `loading.tsx` whose parent layout already renders a
 * shell; that nests a second `h-screen-maintenance` viewport. For those
 * routes use a content-only skeleton such as `PageSkeleton`.
 */
export function CollapsibleSidebarSkeleton() {
  return (
    <div className="flex h-screen-maintenance overflow-hidden bg-muted">
      {/* Sidebar skeleton — mirrors the expanded w-64 layout */}
      <aside className="h-full w-64 border-r border-border bg-card p-4">
        <Skeleton className="h-8 w-32 mb-6" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </aside>
      {/* Main content skeleton */}
      <main className="min-h-0 flex-1 p-6">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </main>
    </div>
  );
}
