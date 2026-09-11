"use client";

import { cn } from "@/utils/tailwind";
import { ReactNode } from "react";

/**
 * PageScaffold — page-scaffold primitives shared by every dashboard role
 * (org, staff, admin, consultant, consultee): a page header band, a padded
 * content region, and a responsive KPI grid.
 *
 * Formerly DashboardShell.tsx; renamed when the legacy `DashboardShell`
 * layout wrapper (fixed sidebar + mobile drawer) died with the
 * shared-shell redesign — all dashboards now compose
 * `PersonalDashboardShell` / the org layout's CollapsibleSidebar chrome
 * instead, and only these scaffold primitives remain.
 */

interface DashboardHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}

export function DashboardHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
}: DashboardHeaderProps) {
  return (
    <div className="bg-card/80 backdrop-blur-xl border-b border-border/50">
      <div className="px-4 sm:px-6 py-3 sm:py-4 lg:px-8">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.label} className="flex items-center gap-2">
                {index > 0 && <span>/</span>}
                {crumb.href ? (
                  <a
                    href={crumb.href}
                    className="hover:text-zinc-900 transition-colors"
                  >
                    {crumb.label}
                  </a>
                ) : (
                  <span className="text-zinc-900">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-900 sm:truncate">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs sm:text-sm text-zinc-500 mt-0.5 sm:truncate">
                {subtitle}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3 sm:shrink-0">
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PanelHeaderProps {
  description?: string;
  actions?: ReactNode;
}

/**
 * Header for a tab panel, as opposed to a page.
 *
 * When the IA consolidation folded sidebar entries into tabs, the panels kept
 * their old `DashboardHeader` — which renders an `h1`. Inside a tab that reads
 * as a second page title directly under the tab you just clicked. This drops
 * the heading and keeps only what the panel still needs: a line of context and
 * its own actions.
 */
export function PanelHeader({ description, actions }: PanelHeaderProps) {
  if (!description && !actions) return null;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {actions && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:gap-3 sm:shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}

interface DashboardContentProps {
  children: ReactNode;
  className?: string;
  fullHeight?: boolean;
}

export function DashboardContent({
  children,
  className,
  fullHeight = false,
}: DashboardContentProps) {
  return (
    <div
      className={cn(
        "px-6 py-6 lg:px-8",
        fullHeight && "flex-1 flex flex-col overflow-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface DashboardGridProps {
  children: ReactNode;
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}

export function DashboardGrid({
  children,
  columns = 3,
  className,
}: DashboardGridProps) {
  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  };

  return (
    <div className={cn("grid gap-4 lg:gap-6", gridCols[columns], className)}>
      {children}
    </div>
  );
}
