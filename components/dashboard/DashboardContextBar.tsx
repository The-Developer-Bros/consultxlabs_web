"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Building2, ChevronRight, type LucideIcon } from "lucide-react";
import { NotificationInbox } from "@/components/notifications/NotificationInbox";

export interface DashboardContextBarBadge {
  label: string;
  /** Colour classes resolved by the caller from a labels module (org-labels / session-labels). */
  className: string;
}

export type DashboardBreadcrumb =
  | string
  | {
      label: string;
      /** When set, the crumb is a clickable link (use for parents of the current page). */
      href?: string;
    };

export interface DashboardContextBarProps {
  identity: {
    name: string;
    image?: string | null;
    /** Fallback glyph when there is no image. Defaults to Building2. */
    FallbackIcon?: LucideIcon;
  };
  /**
   * Pre-resolved status pills rendered next to the identity — org
   * capability/funding badges, consultant verification state, etc. This
   * bar is the canonical "what am I looking at" indicator; neither the
   * sidebar nor page headers repeat these.
   */
  badges?: DashboardContextBarBadge[];
  /**
   * Ordered breadcrumb segments from root to current page.
   * The last entry is highlighted as the active page unless it has an href
   * (parent of a nested record id that was stripped from the trail).
   */
  breadcrumbs?: DashboardBreadcrumb[];
  /**
   * Escape hatch rendered at the far left (e.g. "← Personal" from an org
   * dashboard). Hidden when omitted — personal dashboards have nothing to
   * escape to.
   */
  leftLink?: { href: string; label: string } | null;
  /** Right-aligned actions. Defaults to the notification inbox bell. */
  rightSlot?: React.ReactNode;
}

function normalizeCrumb(crumb: DashboardBreadcrumb): {
  label: string;
  href?: string;
} {
  return typeof crumb === "string" ? { label: crumb } : crumb;
}

/**
 * Sticky info strip at the top of every dashboard page — the generalized
 * successor of the org-only OrgContextBar, shared by the organization,
 * consultant, and consultee shells.
 */
export function DashboardContextBar({
  identity,
  badges = [],
  breadcrumbs = [],
  leftLink,
  rightSlot,
}: DashboardContextBarProps) {
  const FallbackIcon = identity.FallbackIcon ?? Building2;

  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 h-14 px-4 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 text-sm min-w-0">
      {leftLink && (
        <Link
          href={leftLink.href}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 flex items-center gap-1 shrink-0 border-r border-zinc-200 dark:border-zinc-800 pr-3 mr-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {leftLink.label}
        </Link>
      )}

      <div className="flex items-center gap-2 min-w-0">
        <div className="w-6 h-6 rounded-md bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0">
          {identity.image ? (
            <Image
              src={identity.image}
              alt={identity.name}
              width={24}
              height={24}
              className="object-cover"
            />
          ) : (
            <FallbackIcon className="w-3.5 h-3.5 text-zinc-500" />
          )}
        </div>
        <span className="md:hidden font-medium text-zinc-800 dark:text-zinc-100 truncate">
          {identity.name}
        </span>
      </div>

      {badges.length > 0 && (
        <div className="flex items-center gap-1.5 shrink-0">
          {badges.map((badge) => (
            <span
              key={badge.label}
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${badge.className}`}
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}

      {breadcrumbs.length > 0 && (
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1 min-w-0 shrink"
        >
          {breadcrumbs.map((raw, i) => {
            const crumb = normalizeCrumb(raw);
            const isLast = i === breadcrumbs.length - 1;
            const className = isLast && !crumb.href
              ? "text-zinc-900 dark:text-zinc-100 font-semibold truncate"
              : "text-zinc-500 dark:text-zinc-400 truncate hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors";

            return (
              <span key={`${crumb.label}-${i}`} className="flex items-center gap-1 min-w-0">
                <ChevronRight className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600 shrink-0" />
                {crumb.href ? (
                  <Link href={crumb.href} className={className}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    className={className}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {crumb.label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
      )}

      <div className="flex-1" />
      {rightSlot ?? <NotificationInbox />}
    </div>
  );
}
