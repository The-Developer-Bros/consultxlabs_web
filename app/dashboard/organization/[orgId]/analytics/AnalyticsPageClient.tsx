"use client";

import { useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import {
  Users,
  Briefcase,
  Wallet,
  AlertCircle,
  FileText,
  TrendingUp,
  UserCheck,
} from "lucide-react";
import type { FundingSource, MemberRole } from "@prisma/client";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { formatCurrencyAmount } from "@/utils/formatting";

// ---------------------------------------------------------------------------
// Types — match GET /api/organizations/[orgId]/analytics
// ---------------------------------------------------------------------------

interface OrgAnalytics {
  capabilities: {
    canSponsor: boolean;
    canHost: boolean;
    fundingSource: FundingSource | null;
    walletBalance: number | null;
    currency: string | null;
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
  earnings: Array<{
    status: string;
    count: number;
    orgSharePaise: number;
    refundedPaise: number;
  }> | null;
}

async function fetchAnalytics(orgId: string): Promise<OrgAnalytics> {
  const res = await fetch(`/api/organizations/${orgId}/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

function countByRole(
  byRole: OrgAnalytics["members"]["byRole"],
  role: MemberRole,
): number {
  return byRole.find((r) => r.role === role)?.count ?? 0;
}

export function AnalyticsPageClient({ orgId }: { orgId: string }) {
  const { allowed } = useRequireOrgAccess(orgId, { permission: "operations.read" });
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["org-analytics", orgId],
    queryFn: () => fetchAnalytics(orgId),
    enabled: allowed,
  });

  if (!allowed) return null;

  // On failure `isLoading` is false, so the `!data` skeleton below would
  // hang forever — surface an explicit error + retry instead.
  if (isError && !data) {
    return (
      <>
        <DashboardHeader title="Analytics" subtitle="Activity at a glance" />
        <DashboardContent>
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            <p className="font-medium">Failed to load analytics.</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-2 inline-flex items-center rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
            >
              Retry
            </button>
          </div>
        </DashboardContent>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        <DashboardHeader title="Analytics" subtitle="Activity at a glance" />
        <DashboardContent>
          <DashboardGrid columns={3}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        </DashboardContent>
      </>
    );
  }

  const currency = data.capabilities.currency ?? "INR";
  const learners = countByRole(data.members.byRole, "LEARNER");
  const experts = countByRole(data.members.byRole, "EXPERT");

  // Earnings "paid" cell: sum the orgShare of PAID rows, net of refunds.
  const paidEarnings =
    data.earnings?.find((e) => e.status === "PAID")?.orgSharePaise ?? 0;
  const refundedEarnings = (data.earnings ?? []).reduce(
    (sum, e) => sum + e.refundedPaise,
    0,
  );

  return (
    <>
      <DashboardHeader title="Analytics" subtitle="Activity at a glance" />
      <DashboardContent>
        <DashboardGrid columns={3}>
          <StatCard
            title="Members"
            value={data.members.total}
            subtitle={`${data.members.active} active`}
            icon={Users}
            variant="info"
          />
          {data.capabilities.canSponsor && (
            <StatCard
              title="Learners"
              value={learners}
              subtitle={
                data.programs.activeAssignments > 0
                  ? `${data.programs.activeAssignments} active assignments`
                  : "No active assignments"
              }
              icon={UserCheck}
            />
          )}
          {data.capabilities.canHost && (
            <StatCard title="Experts" value={experts} icon={UserCheck} />
          )}
          <StatCard
            title="Active programs"
            value={data.programs.active}
            subtitle={`${data.programs.total} total`}
            icon={Briefcase}
          />
          {data.wallet && (
            <StatCard
              title="Wallet balance"
              value={formatCurrencyAmount(data.wallet.balancePaise, currency)}
              icon={Wallet}
              variant="success"
            />
          )}
          {data.invoices && (
            <>
              <StatCard
                title="Outstanding invoices"
                value={data.invoices.outstandingCount}
                subtitle={formatCurrencyAmount(
                  data.invoices.outstandingPaise,
                  currency,
                )}
                icon={FileText}
                variant={data.invoices.pastDueCount > 0 ? "warning" : "info"}
              />
              <StatCard
                title="Paid (last 30 days)"
                value={data.invoices.paidLast30dCount}
                subtitle={formatCurrencyAmount(
                  data.invoices.paidLast30dPaise,
                  currency,
                )}
                icon={TrendingUp}
                variant="success"
              />
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
          {data.earnings && data.earnings.length > 0 && (
            <StatCard
              title="Earnings — paid"
              value={formatCurrencyAmount(paidEarnings, currency)}
              subtitle={
                refundedEarnings > 0
                  ? `${formatCurrencyAmount(refundedEarnings, currency)} refunded`
                  : undefined
              }
              icon={Wallet}
              variant="success"
            />
          )}
        </DashboardGrid>
      </DashboardContent>
    </>
  );
}
