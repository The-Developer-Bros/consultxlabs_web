"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  Users,
  UserCheck,
  Briefcase,
  CreditCard,
  AlertCircle,
  Mail,
  Settings,
  Check,
  Rocket,
  Clock,
  Wallet,
  FileText,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import type { FundingSource, MemberRole, OrgStatus } from "@prisma/client";

import {
  deriveActivationChecklist,
  deriveActionCenter,
  type OrgActivationSnapshot,
} from "@/lib/enterprise/org-activation";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useOrgRole } from "../useOrgRole";
import { ActionRequiredPanel } from "@/components/dashboard/ActionRequiredPanel";
import { FinanceLeadViewCard } from "./FinanceLeadViewCard";

// ---------------------------------------------------------------------------
// Types — shaped to match the actual analytics + activity APIs
// ---------------------------------------------------------------------------

interface OrgAnalytics {
  status: OrgStatus;
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    walletBalance: number | null;
    currency: string | null;
  };
  activation: {
    hasContract: boolean;
    hasActiveContract: boolean;
    contractExpiringSoonCount: number;
    kybVerified: boolean;
    pendingOverageCount: number;
    pendingOveragePaise: number;
    stuckPayoutCount: number;
    creditPoolMaxUtilizationPct: number | null;
  };
  members: {
    total: number;
    active: number;
    byRole: Array<{ role: MemberRole; count: number }>;
  };
  programs: {
    total: number;
    active: number;
    activeAssignments: number;
  };
  wallet: {
    balancePaise: number;
    recent: Array<{ reason: string; count: number; deltaPaise: number }>;
  } | null;
  invoices: {
    outstandingCount: number;
    outstandingPaise: number;
    pastDueCount: number;
    paidLast30dCount: number;
    paidLast30dPaise: number;
  } | null;
  subscription: {
    model: "PER_SEAT" | "FLAT_FEE";
    cycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
    flatFeePaise: number | null;
  } | null;
  reimbursements: {
    last30dCount: number;
    last30dPaise: number;
  } | null;
  earnings: Array<{
    status: string;
    count: number;
    orgSharePaise: number;
    refundedPaise: number;
  }> | null;
}

interface ActivityItem {
  category:
    | "MEMBER"
    | "CONTRACT"
    | "PROGRAM"
    | "WALLET"
    | "INVOICE"
    | "PAYOUT"
    | "SETTINGS"
    | "CONSENT"
    | "SYSTEM";
  description: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// API fetchers
// ---------------------------------------------------------------------------

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

async function fetchActivity(
  orgId: string,
): Promise<{ activity: ActivityItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/activity?limit=5`);
  if (!res.ok) return { activity: [] };
  const json = await res.json();
  return { activity: json.data ?? [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const ACTIVITY_ICONS: Partial<Record<ActivityItem["category"], LucideIcon>> = {
  MEMBER: Users,
  WALLET: CreditCard,
  INVOICE: Briefcase,
  PAYOUT: Wallet,
  CONTRACT: Briefcase,
  SETTINGS: Settings,
};

function countByRole(
  byRole: OrgAnalytics["members"]["byRole"],
  role: MemberRole,
): number {
  return byRole.find((r) => r.role === role)?.count ?? 0;
}

// #779 §F — the org's real next actions (overdue invoices, cap-near,
// expiring contracts, pending overages, stuck payouts, low wallet), not a
// generic dashboard. Severity drives tone.
//
// The panel that renders these moved to components/dashboard/
// ActionRequiredPanel when the consultant and consultee homes adopted the
// same idea — this was the only home page that led with what needed doing.

/** Map the analytics payload → the pure activation snapshot. */
function toActivationSnapshot(data: OrgAnalytics): OrgActivationSnapshot {
  return {
    status: data.status,
    canSponsor: data.capabilities.canSponsor,
    canHost: data.capabilities.canHost,
    fundingSource: data.capabilities.fundingSource,
    memberCount: data.members.total,
    activeProgramCount: data.programs.active,
    activeAssignmentCount: data.programs.activeAssignments,
    billingConfigured:
      data.wallet != null || data.invoices != null || data.subscription != null,
    hasContract: data.activation.hasContract,
    hasActiveContract: data.activation.hasActiveContract,
    kybVerified: data.activation.kybVerified,
    pastDueInvoiceCount: data.invoices?.pastDueCount ?? 0,
    outstandingInvoicePaise: data.invoices?.outstandingPaise ?? 0,
    contractExpiringSoonCount: data.activation.contractExpiringSoonCount,
    pendingOverageCount: data.activation.pendingOverageCount,
    pendingOveragePaise: data.activation.pendingOveragePaise,
    stuckPayoutCount: data.activation.stuckPayoutCount,
    walletLowBalancePaise: data.wallet ? data.wallet.balancePaise : null,
    creditPoolMaxUtilizationPct: data.activation.creditPoolMaxUtilizationPct,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomePageClient({ orgId }: { orgId: string }) {
  const { role, canSponsor, canHost, isAtLeast } = useOrgRole(orgId);
  // BILLING_ADMIN gets the finance-tuned overview. Operator surfaces
  // (member analytics, checklist, activity feed) are gated at MANAGER
  // and intentionally excluded for BILLING_ADMIN — see the role
  // description in lib/labels/org-labels.ts. The analytics API still
  // accepts BILLING_ADMIN reads (rank 70 > MANAGER 60), so the
  // payload comes back; we just render the finance card instead of
  // the operator dashboard.
  const isFinanceLead = role === "BILLING_ADMIN";
  // The operator surface (stat grid, checklist, activity feed) requires
  // MANAGER — that matches the analytics + activity API gates. Consumer
  // roles see the ConsumerView below instead of broken "Could not load"
  // cards. Sub-MANAGERs shouldn't normally reach /home anyway because
  // /[orgId]/page.tsx redirects them to /my-program (LEARNER) or
  // /compensation (EXPERT) — this is a deep-link safety net.
  // We exclude BILLING_ADMIN from `isOperator` so it doesn't fall into
  // the operator branch downstream.
  const isOperator = !isFinanceLead && isAtLeast("MANAGER");

  const analytics = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
    enabled: isOperator || isFinanceLead,
  });
  const activity = useQuery({
    queryKey: ["org-activity", orgId],
    queryFn: () => fetchActivity(orgId),
    enabled: isOperator,
  });

  // Render the BILLING_ADMIN-tuned finance overview ahead of the
  // operator branch. Bails out early so the operator-only stat grid +
  // checklist below don't render for the finance lead.
  if (isFinanceLead) {
    return (
      <>
        <DashboardHeader
          title="Finance overview"
          subtitle="Your day-to-day finance surfaces on this organization"
        />
        <DashboardContent>
          {analytics.isLoading ? (
            <p className="text-sm text-zinc-500">Loading finance summary...</p>
          ) : analytics.data ? (
            <FinanceLeadViewCard orgId={orgId} data={analytics.data} />
          ) : (
            <p className="text-sm text-zinc-500">
              Couldn&apos;t load the finance summary. Try refreshing the
              page or pinging the OWNER if this persists.
            </p>
          )}
        </DashboardContent>
      </>
    );
  }

  if (!isOperator) {
    // Per-role CTA — deep-link to the role's in-org page where one
    // exists. The "personal dashboard" link stays as a secondary
    // anchor so consumers can hop out without hunting for the sidebar
    // chip.
    const primary =
      role === "LEARNER" && canSponsor
        ? {
            title: "Your sponsored bookings live here",
            body:
              "This organisation covers your sessions through one or more programs. Open My Program to see your current cycle allocation and recent activity.",
            ctaLabel: "Open My Program",
            ctaHref: `/dashboard/organization/${orgId}/my-program`,
          }
        : role === "EXPERT" && canHost
          ? {
              title: "Your hosting arrangement with this organisation",
              body:
                "This organisation routes session payments through a shared rate card. Open Compensation to see the split and your recent earnings.",
              ctaLabel: "Open Compensation",
              ctaHref: `/dashboard/organization/${orgId}/compensation`,
            }
          : {
              title: "You're a member here",
              body:
                "Day-to-day activity — booking history, upcoming sessions, and account settings — lives on your personal dashboard.",
              ctaLabel: "Go to my personal dashboard",
              ctaHref: "/dashboard",
            };
    const secondaryHref = "/dashboard";
    const showSecondary = primary.ctaHref !== secondaryHref;

    return (
      <>
        <DashboardHeader
          title="Overview"
          subtitle="Your membership on this organization"
        />
        <DashboardContent>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{primary.title}</CardTitle>
              <CardDescription>{primary.body}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3">
              <Link
                href={primary.ctaHref}
                className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800"
              >
                {primary.ctaLabel}
              </Link>
              {showSecondary && (
                <Link
                  href={secondaryHref}
                  className="text-sm text-muted-foreground underline underline-offset-2 hover:text-zinc-900"
                >
                  Or go to my personal dashboard
                </Link>
              )}
            </CardContent>
          </Card>
        </DashboardContent>
      </>
    );
  }

  const isLoading = analytics.isLoading;
  const data = analytics.data;

  const currency = data?.capabilities.currency ?? "INR";
  const learners = data ? countByRole(data.members.byRole, "LEARNER") : 0;
  const experts = data ? countByRole(data.members.byRole, "EXPERT") : 0;

  // #777 §A — Getting-Started checklist + #779 §F action center, both derived
  // from one snapshot (see lib/enterprise/org-activation.ts). Auto-hides the
  // checklist once every applicable step is done.
  const snapshot = data ? toActivationSnapshot(data) : null;
  const checklist = snapshot ? deriveActivationChecklist(snapshot, orgId) : [];
  const actionItems = snapshot ? deriveActionCenter(snapshot, orgId) : [];
  const checklistDone = checklist.filter((c) => c.done).length;
  const allDone = checklist.length > 0 && checklistDone === checklist.length;
  const showChecklist =
    !isLoading && isAtLeast("MAINTAINER") && checklist.length > 0 && !allDone;

  // Earnings summary for host orgs — sum of PAID orgShare, net refunds.
  const paidEarnings =
    data?.earnings?.find((e) => e.status === "PAID")?.orgSharePaise ?? 0;

  // Quick action cards (role-gated). `satisfies` keeps every `minRole`
  // compile-time-checked against the real `MemberRole` enum.
  const quickActions = (
    [
      {
        title: "Invite member",
        description: "Add team members by email",
        icon: Mail,
        href: `/dashboard/organization/${orgId}/members?tab=invitations`,
        minRole: "MAINTAINER",
      },
      {
        title: "Create Program",
        description: "Set up a new licensed-seat or credit-pool program",
        icon: Briefcase,
        href: `/dashboard/organization/${orgId}/programs`,
        minRole: "MAINTAINER",
      },
      {
        title: "View billing",
        description: "Invoices and payment summary",
        icon: CreditCard,
        href: `/dashboard/organization/${orgId}/billing`,
        minRole: "MANAGER",
      },
      {
        title: "Org settings",
        description: "Profile, branding, and configuration",
        icon: Settings,
        href: `/dashboard/organization/${orgId}/settings`,
        minRole: "MAINTAINER",
      },
    ] as const satisfies readonly {
      title: string;
      description: string;
      icon: LucideIcon;
      href: string;
      minRole: MemberRole;
    }[]
  ).filter(
    (a) =>
      isAtLeast(a.minRole) &&
      (a.title !== "View billing" || canSponsor),
  );

  return (
    <>
      <DashboardHeader
        title="Overview"
        subtitle="Snapshot of your organization"
      />
      <DashboardContent>
        {/* #779 §F — action center: the org's real next actions, ahead of
            stats. Empty (renders nothing) for a healthy org. */}
        <ActionRequiredPanel items={actionItems} heading="Action required" />

        {/* #777 §A — Getting-Started checklist; auto-hides once every step is
            complete. */}
        {showChecklist && (
          <Card className="mb-6 border-amber-200 bg-amber-50">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Rocket className="h-5 w-5 text-amber-600" />
                <CardTitle className="text-base text-amber-900">
                  Get started — {checklistDone}/{checklist.length} done
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <Progress
                value={(checklistDone / checklist.length) * 100}
                className="mb-4 h-2"
              />
              <div className="space-y-2">
                {checklist.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={`flex items-center gap-3 rounded-lg p-2 text-sm transition-colors ${
                      item.done
                        ? "text-zinc-400"
                        : "text-amber-800 hover:bg-amber-100"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        item.done
                          ? "border-emerald-500 bg-emerald-500"
                          : "border-amber-400"
                      }`}
                    >
                      {item.done && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <span className={item.done ? "line-through" : ""}>
                      {item.label}
                    </span>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Unified stat grid — all cards share one 4-column responsive grid
            so every card has the same width regardless of how many are
            visible. Capability-dependent cards (wallet, invoices, earnings)
            are rendered inline once their section of the analytics payload
            is non-null. */}
        {analytics.isLoading || (isOperator && !analytics.isFetched) ? (
          <DashboardGrid columns={4}>
            {[1, 2, 3, 4].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : !data ? (
          <DashboardGrid columns={4}>
            <StatCard title="Members" value="—" subtitle="Could not load" icon={Users} variant="info" />
            <StatCard title="Active programs" value="—" subtitle="Could not load" icon={Briefcase} />
            <StatCard title="Experts" value="—" icon={UserCog} />
            <StatCard title="Learners" value="—" icon={UserCheck} />
          </DashboardGrid>
        ) : (
          <DashboardGrid columns={4}>
            <StatCard
              title="Members"
              value={data.members.total}
              subtitle={`${data.members.active} active`}
              icon={Users}
              variant="info"
            />
            {canSponsor && (
              <StatCard
                title="Learners"
                value={learners}
                subtitle={
                  data.programs.activeAssignments > 0
                    ? `${data.programs.activeAssignments} assignments`
                    : "No active assignments"
                }
                icon={UserCheck}
              />
            )}
            {canHost && (
              <StatCard title="Experts" value={experts} icon={UserCog} />
            )}
            <StatCard
              title="Active programs"
              value={data.programs.active}
              subtitle={`${data.programs.total} total`}
              icon={Briefcase}
            />

            {/* Wallet — only shown when BillingAccount.fundingSource=WALLET */}
            {data.wallet && isAtLeast("MANAGER") && (
              <StatCard
                title="Wallet balance"
                value={formatCurrencyAmount(data.wallet.balancePaise, currency)}
                icon={Wallet}
                variant="success"
              />
            )}

            {/* Invoices — only for INVOICE-funded orgs */}
            {data.invoices && isAtLeast("MANAGER") && (
              <>
                {data.invoices.outstandingCount > 0 && (
                  <StatCard
                    title="Outstanding invoices"
                    value={data.invoices.outstandingCount}
                    subtitle={formatCurrencyAmount(
                      data.invoices.outstandingPaise,
                      currency,
                    )}
                    icon={FileText}
                    variant={
                      data.invoices.pastDueCount > 0 ? "warning" : "info"
                    }
                  />
                )}
                {data.invoices.pastDueCount > 0 && (
                  <StatCard
                    title="Past-due invoices"
                    value={data.invoices.pastDueCount}
                    icon={AlertCircle}
                    variant="warning"
                  />
                )}
              </>
            )}

            {/* Reimbursements — PERSONAL-funded orgs only (#714) */}
            {data.reimbursements && isAtLeast("MANAGER") && (
              <Link
                href={`/dashboard/organization/${orgId}/reimbursements`}
                className="contents"
              >
                <StatCard
                  title="To reimburse (30d)"
                  value={formatCurrencyAmount(
                    data.reimbursements.last30dPaise,
                    currency,
                  )}
                  subtitle={`${data.reimbursements.last30dCount} payment${
                    data.reimbursements.last30dCount === 1 ? "" : "s"
                  } — view report`}
                  icon={Wallet}
                  variant={
                    data.reimbursements.last30dCount > 0 ? "info" : "default"
                  }
                />
              </Link>
            )}

            {/* Host-side earnings summary */}
            {canHost && data.earnings && data.earnings.length > 0 && (
              <StatCard
                title="Paid out"
                value={formatCurrencyAmount(paidEarnings, currency)}
                subtitle="Completed payouts"
                icon={Wallet}
                variant="success"
              />
            )}
          </DashboardGrid>
        )}

        {/* Quick actions */}
        {quickActions.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-zinc-700 mb-3">
              Quick actions
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {quickActions.map((action) => (
                <Link key={action.title} href={action.href}>
                  <Card className="h-full hover:border-zinc-400 transition-colors cursor-pointer">
                    <CardContent className="p-4">
                      <action.icon className="h-5 w-5 text-zinc-500 mb-2" />
                      <p className="text-sm font-medium text-zinc-900">
                        {action.title}
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5">
                        {action.description}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Recent activity */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>
              Latest events across your organization
            </CardDescription>
          </CardHeader>
          <CardContent>
            {activity.isLoading ? (
              <p className="text-sm text-zinc-500">Loading…</p>
            ) : activity.data && activity.data.activity.length > 0 ? (
              <div className="space-y-3">
                {activity.data.activity.map((item, i) => {
                  const Icon = ACTIVITY_ICONS[item.category] ?? Clock;
                  return (
                    <div
                      key={`${item.category}-${item.createdAt}-${i}`}
                      className="flex items-center gap-3 text-sm"
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0">
                        <Icon className="h-4 w-4 text-zinc-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-zinc-700 truncate">
                          {item.description}
                        </p>
                      </div>
                      <span className="text-xs text-zinc-400 shrink-0">
                        {timeAgo(item.createdAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 text-center py-4">
                No activity yet. Start by inviting your team!
              </p>
            )}
          </CardContent>
        </Card>
      </DashboardContent>
    </>
  );
}
