import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  BadgeCheck,
  BarChart3,
  Building2,
  CalendarCheck,
  CreditCard,
  FileText,
  Home,
  Landmark,
  ListChecks,
  Megaphone,
  MessagesSquare,
  Play,
  Receipt,
  RefreshCw,
  RotateCcw,
  Shield,
  Star,
  Ticket,
  Users,
  Wallet,
  Wrench,
  Target,
} from "lucide-react";
import type { UserRole } from "@prisma/client";

import type {
  CollapsibleSidebarGroup,
  CollapsibleSidebarItem,
} from "@/components/dashboard/CollapsibleSidebar";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

/**
 * The one nav definition behind both back-office trees.
 *
 * `/dashboard/admin` and `/dashboard/staff/[staffId]` stay separate URL trees
 * with their own chrome and landing pages, but they no longer maintain
 * separate nav arrays — that is how the two sidebars drifted into 18 and 16
 * flat items describing largely the same product.
 *
 * `buildBackofficeNav` filters this list through BACKOFFICE_PERMISSIONS for
 * the tree's audience. The admin tree builds for ADMIN and gets everything;
 * the staff tree builds for STAFF and gets the subset staff hold — even when
 * the viewer is an admin looking at the staff tree, because the point of that
 * view is to see what staff see.
 *
 * `metrics` is deliberately staff-only and `analytics` deliberately
 * admin-only: they are different pages against different endpoints (support
 * queue health vs platform revenue), not one page under two names.
 *
 * The sidebar is COSMETIC. Page guards and route handlers re-check the same
 * matrix keys; hiding an item only keeps the nav honest.
 */

type NavItemSpec = CollapsibleSidebarItem & {
  surface: BackofficeSurface;
  /** Structural condition (feature flags), ANDed with the matrix. */
  show?: boolean;
  /** Restrict this item to one tree when both can't host it. */
  only?: "admin" | "staff";
};

type NavGroupSpec = {
  label?: string;
  items: NavItemSpec[];
};

export interface BackofficeNavOptions {
  /** #863 — ENABLE_TDS_ADMIN_VIEW. Hides the item when the page would 404. */
  showTds?: boolean;
}

function groupSpecs({ showTds = false }: BackofficeNavOptions): NavGroupSpec[] {
  return [
    {
      items: [
        // Home is the tree's landing page; every operator has it, and it has
        // no matrix key of its own because reaching the tree at all is the
        // grant. `users.read` is the cheapest always-true stand-in.
        { name: "Overview", icon: Home, path: "home", surface: "users.read" },
      ],
    },
    {
      label: "Support",
      items: [
        {
          name: "Support Tickets",
          icon: Ticket,
          path: "tickets",
          surface: "tickets.manage",
        },
        {
          // #support-hub — the per-appointment conversation inbox.
          name: "Conversations",
          icon: MessagesSquare,
          path: "threads",
          surface: "threads.manage",
        },
        {
          name: "User Feedback",
          icon: Star,
          path: "feedback",
          surface: "feedback.manage",
        },
        {
          name: "Moderation",
          icon: Shield,
          path: "moderation",
          surface: "moderation.manage",
        },
      ],
    },
    {
      label: "Operations",
      items: [
        {
          name: "Appointments",
          icon: CalendarCheck,
          path: "appointments",
          surface: "appointments.manage",
        },
        {
          name: "Waitlist",
          icon: ListChecks,
          path: "waitlist",
          surface: "waitlist.manage",
        },
        {
          name: "Leads",
          icon: Target,
          path: "leads",
          surface: "leads.manage",
          // Only /dashboard/admin/leads exists — the staff tree would 404.
          only: "admin",
        },
        { name: "Users", icon: Users, path: "users", surface: "users.read" },
        // Support context for "why was my document rejected?" — read-only.
        {
          name: "Documents",
          icon: FileText,
          path: "documents",
          surface: "appointments.manage",
        },
      ],
    },
    {
      label: "Money",
      items: [
        {
          name: "Payments",
          icon: CreditCard,
          path: "payments",
          surface: "payments.read",
        },
        {
          name: "Refunds",
          icon: RotateCcw,
          path: "refunds",
          surface: "refunds.read",
        },
        {
          name: "Disputes",
          icon: AlertTriangle,
          path: "disputes",
          surface: "disputes.read",
        },
        {
          name: "Invoices",
          icon: Receipt,
          path: "invoices",
          surface: "invoices.read",
        },
        {
          name: "Subscriptions",
          icon: RefreshCw,
          path: "subscriptions",
          surface: "subscriptions.read",
        },
        {
          name: "Payouts",
          icon: Wallet,
          path: "payouts",
          surface: "payouts.read",
        },
        {
          name: "Approval Payments",
          icon: BadgeCheck,
          path: "approval-payments",
          surface: "approvalPayments.manage",
        },
        {
          name: "TDS",
          icon: Landmark,
          path: "tds",
          surface: "tds.read",
          show: showTds,
        },
      ],
    },
    {
      label: "Insights",
      items: [
        // Two different pages, one per tree — see the file header.
        {
          name: "Metrics",
          icon: BarChart3,
          path: "metrics",
          surface: "analytics.read",
          only: "staff",
        },
        {
          name: "Analytics",
          icon: BarChart3,
          path: "analytics",
          surface: "analytics.read",
          only: "admin",
        },
      ],
    },
    {
      label: "Platform",
      items: [
        {
          name: "Organizations",
          icon: Building2,
          path: "organizations",
          surface: "organizations.manage",
        },
        {
          name: "Announcements",
          icon: Megaphone,
          path: "announcements",
          surface: "announcements.manage",
        },
        {
          name: "System Jobs",
          icon: Play,
          path: "system-jobs",
          surface: "systemJobs.manage",
        },
        {
          name: "Maintenance",
          icon: Wrench,
          path: "maintenance",
          surface: "maintenance.manage",
        },
      ],
    },
  ];
}

export function buildBackofficeNav(
  tree: "admin" | "staff",
  options: BackofficeNavOptions = {},
): CollapsibleSidebarGroup[] {
  // The staff tree always renders the STAFF nav, even for an admin viewing it
  // — an admin who wants their own surfaces is one click away in their tree.
  const audience: UserRole = tree === "admin" ? "ADMIN" : "STAFF";

  return groupSpecs(options)
    .map((g) => ({
      label: g.label,
      items: g.items
        .filter(
          (it) =>
            it.show !== false &&
            (!it.only || it.only === tree) &&
            hasBackofficePermission(audience, it.surface),
        )
        .map(({ surface: _s, show: _show, only: _only, ...rest }) => rest),
    }))
    .filter((g) => g.items.length > 0);
}

/** Icon re-export so shells don't each import lucide for the chip. */
export type { LucideIcon };
