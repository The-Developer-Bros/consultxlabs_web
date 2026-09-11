"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { EarningStatus } from "@prisma/client";
import {
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard } from "@/components/dashboard/StatCard";
import { EmptyState } from "@/components/dashboard/DataCard";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { earningStatusBadge } from "@/lib/labels/session-labels";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { Button } from "@/components/ui/button";
import {
  Wallet,
  Clock,
  CheckCircle,
  AlertTriangle,
  IndianRupee,
  ArrowUpRight,
  Loader2,
  ShieldQuestion,
} from "lucide-react";
import { formatCurrencyAmount } from "@/utils/formatting";
import { IndiaOnlyPayoutNotice } from "@/components/payouts/IndiaOnlyPayoutNotice";

interface EarningsSummary {
  consultantProfileId: string;
  totalEarnings: number;
  pendingEarnings: number;
  readyEarnings: number;
  batchedEarnings: number;
  paidEarnings: number;
  heldEarnings: number;
  pendingTrustEarnings: number;
}

interface EarningRecord {
  id: string;
  consultantSharePaise: number;
  platformFeePaise: number;
  status: EarningStatus;
  holdUntil: string | null;
  createdAt: string;
  role: "OWNER" | "COLLABORATOR";
  // #772 B5 — basis points (10000 = 100%); divide by 100 for display.
  shareBps: number;
  payment: {
    id: string;
    amount: number;
    originalAmount: number;
    currency: string;
    createdAt: string;
    appointment: {
      id: string;
      appointmentType: string;
    } | null;
  };
  payout: {
    id: string;
    status: string;
    processedAt: string | null;
  } | null;
}

interface EarningsResponse {
  summary: EarningsSummary;
  /**
   * #776 §B — server-only ENABLE_LIVE_PAYOUTS, relayed because this page is a
   * client component with no RSC wrapper. With disbursement gated, a BATCHED
   * earning is reserved at the platform rather than in transit, and the UI must
   * not imply otherwise (same posture as the org payouts page).
   */
  livePayoutsEnabled?: boolean;
  eligibility: {
    isEligible: boolean;
    reason?: string;
    readyAmount: number;
    minimumAmount: number;
  };
  earnings: EarningRecord[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/**
 * Format currency using the shared utility.
 * Summary amounts don't carry a currency (backend aggregates across all),
 * so we default to INR. Individual earning rows use payment.currency.
 */
const formatSummaryAmount = (amount: number) =>
  formatCurrencyAmount(amount, "INR");

const formatEarningAmount = (amount: number, currency: string) =>
  formatCurrencyAmount(amount, currency);

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The Summary panel of the Earnings page.
 *
 * Was the whole `earnings/page.tsx` until ADR 19's "a nav entry is a
 * destination" rule was applied to the consultant sidebar: Analytics read the
 * very same `/api/consultant/earnings` endpoint with `?includeMonthly=1`, so
 * two nav entries pointed at one object. It is now the sibling tab, and the
 * route wrapper owns the tab strip.
 */
export function EarningsSummaryPanel({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const [statusFilter, setStatusFilter] = useState<EarningStatus | "ALL">(
    "ALL",
  );
  const [page, setPage] = useState(0);
  const limit = 15;

  const { data, isLoading, isPlaceholderData, error, refetch } =
    useQuery<EarningsResponse>({
      queryKey: ["consultant-earnings", consultantId, statusFilter, page],
      queryFn: async () => {
        const params = new URLSearchParams();
        if (statusFilter !== "ALL") params.set("status", statusFilter);
        params.set("limit", String(limit));
        params.set("offset", String(page * limit));
        const res = await fetch(`/api/consultant/earnings?${params}`);
        if (!res.ok) throw new Error("Failed to fetch earnings");
        return res.json();
      },
      staleTime: 30_000,
      // `statusFilter` and `page` are in the key, so every tab and every page
      // is a separate query. Without this, switching to a tab you have not
      // opened in the last 30s left `data` undefined and `isLoading` true, and
      // the branch below replaced the entire page — header, stat cards, tabs —
      // with a centred spinner. Keeping the previous result means the outgoing
      // rows stay put, dimmed, while the new ones load.
      placeholderData: keepPreviousData,
    });

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your earnings"
        description={
          error instanceof Error ? error.message : "Please try again later."
        }
        action={
          <Button variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const summary = data?.summary;
  const earnings = data?.earnings ?? [];
  const eligibility = data?.eligibility;
  // Default to FALSE, not true: if the flag is missing for any reason the
  // honest reading is "disbursement may not be live", never "your money is on
  // its way".
  const livePayoutsEnabled = data?.livePayoutsEnabled ?? false;
  const pagination = data?.pagination;

  const filterTabs: { label: string; value: EarningStatus | "ALL" }[] = [
    { label: "All", value: "ALL" },
    { label: "Pending", value: "PENDING" },
    { label: "Ready", value: "READY" },
    { label: "Processing", value: "BATCHED" }, // #837 — batched, cash not yet disbursed
    { label: "Paid", value: "PAID" },
    { label: "On Hold", value: "HELD" },
    { label: "Org Trust", value: "PENDING_TRUST" },
    { label: "Refunded", value: "REFUNDED" },
  ];

  const columns: ResponsiveColumn<EarningRecord>[] = [
    {
      key: "type",
      header: "Type",
      primary: true,
      cell: (earning) => (
        <span className="capitalize text-zinc-800">
          {(
            earning.payment?.appointment?.appointmentType ?? "N/A"
          ).toLowerCase()}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (earning) => (
        <span className="text-zinc-600">{formatDate(earning.createdAt)}</span>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (earning) => (
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${
            earning.role === "COLLABORATOR"
              ? "bg-purple-50 text-purple-700"
              : "bg-zinc-100 text-zinc-600"
          }`}
        >
          {earning.role === "COLLABORATOR"
            ? `Collab ${earning.shareBps / 100}%`
            : earning.shareBps < 10000
              ? `Owner ${earning.shareBps / 100}%`
              : "Owner"}
        </span>
      ),
    },
    {
      key: "planPrice",
      header: "Plan Price",
      headClassName: "text-right",
      className: "text-right text-zinc-600",
      cell: (earning) =>
        formatEarningAmount(
          earning.payment?.originalAmount ?? 0,
          earning.payment?.currency ?? "INR",
        ),
    },
    {
      key: "yourEarnings",
      header: "Your Earnings",
      headClassName: "text-right",
      className: "text-right font-medium text-zinc-900",
      cell: (earning) =>
        formatEarningAmount(
          earning.consultantSharePaise,
          earning.payment?.currency ?? "INR",
        ),
    },
    {
      key: "platformFee",
      header: "Platform Fee",
      headClassName: "text-right",
      className: "text-right text-zinc-400",
      hideOnCard: true,
      cell: (earning) =>
        formatEarningAmount(
          earning.platformFeePaise,
          earning.payment?.currency ?? "INR",
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (earning) => (
        <StatusBadge {...earningStatusBadge(earning.status)} />
      ),
    },
    {
      key: "payout",
      header: "Payout",
      cell: (earning) =>
        earning.payout ? (
          <span className="flex items-center gap-1 text-xs text-zinc-500">
            {earning.payout.status === "COMPLETED" ? (
              <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Clock className="w-3.5 h-3.5 text-amber-500" />
            )}
            {earning.payout.processedAt
              ? formatDate(earning.payout.processedAt)
              : earning.payout.status}
          </span>
        ) : (
          <span className="text-xs text-zinc-400">-</span>
        ),
    },
  ];

  // No DashboardHeader here — the route wrapper renders one header above the
  // tab strip, so both panels sit under a single "Earnings" title.
  return (
    <>
      <DashboardContent>
        {/* Summary Cards */}
        <DashboardGrid columns={4}>
          <StatCard
            title="Net Earnings"
            value={formatSummaryAmount(summary?.totalEarnings ?? 0)}
            icon={IndianRupee}
            variant="default"
            tooltip="Total of all cleared earnings (pending + ready + processing + paid + held). Excludes refunded amounts."
          />
          <StatCard
            title="Ready for Payout"
            value={formatSummaryAmount(summary?.readyEarnings ?? 0)}
            icon={CheckCircle}
            variant="success"
            subtitle={
              eligibility?.isEligible
                ? "Eligible for payout"
                : `${formatSummaryAmount(eligibility?.readyAmount ?? 0)} / ${formatSummaryAmount(eligibility?.minimumAmount ?? 50000)} minimum`
            }
          />
          <StatCard
            title="Pending (In Hold)"
            value={formatSummaryAmount(summary?.pendingEarnings ?? 0)}
            icon={Clock}
            variant="warning"
            subtitle="Released after hold period"
            tooltip="Earnings in hold period (24h–7 days depending on service type). Automatically released when hold expires."
          />
          <StatCard
            title="Already Paid Out"
            value={formatSummaryAmount(summary?.paidEarnings ?? 0)}
            icon={Wallet}
            variant="info"
          />
          {summary && summary.batchedEarnings > 0 && (
            <StatCard
              title="Processing Payout"
              value={formatSummaryAmount(summary.batchedEarnings)}
              icon={ArrowUpRight}
              variant="info"
              subtitle={
                livePayoutsEnabled
                  ? "In a payout batch"
                  : "Reserved — disbursement not live yet"
              }
              tooltip={
                livePayoutsEnabled
                  ? "Cleared earnings locked into an in-flight payout batch. Cash is on its way to your bank; this releases as Paid once the payout settles."
                  : "Cleared earnings reserved into a payout batch. Disbursement isn't switched on yet, so this money is held at the platform — calculated and reserved, not failed, and not yet in transit to your bank."
              }
            />
          )}
          {summary && summary.pendingTrustEarnings > 0 && (
            <StatCard
              title="Pending Org Trust"
              value={formatSummaryAmount(summary.pendingTrustEarnings)}
              icon={ShieldQuestion}
              variant="info"
              subtitle="From unverified organizations"
              tooltip="Earnings from organizations that haven't completed verification or paid their first invoice yet. They unlock automatically once the organization is verified or pays."
            />
          )}
        </DashboardGrid>

        {/* Held earnings alert */}
        {summary && summary.heldEarnings > 0 && (
          <div className="mt-4 flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-800">
                {formatSummaryAmount(summary.heldEarnings)} is on hold
              </p>
              <p className="text-xs text-red-600">
                Earnings may be held due to disputes or policy review. Contact
                support if you have questions.
              </p>
            </div>
          </div>
        )}

        {/* Filter Tabs */}
        <div className="mt-6 flex items-center gap-2 border-b border-zinc-200 pb-0 overflow-x-auto">
          {filterTabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => {
                setStatusFilter(tab.value);
                setPage(0);
              }}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                statusFilter === tab.value
                  ? "border-zinc-900 text-zinc-900"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Earnings Table — dimmed while the tab being switched to is still
            in flight, so the rows on screen are visibly stale rather than
            silently wrong. */}
        <div
          className={`mt-4 bg-white rounded-xl border border-zinc-200 overflow-hidden transition-opacity ${
            isPlaceholderData ? "opacity-60" : "opacity-100"
          }`}
          aria-busy={isPlaceholderData}
        >
          <ResponsiveTable
            columns={columns}
            rows={earnings}
            getRowId={(earning) => earning.id}
            className="[&>ul]:p-3"
            empty={
              <EmptyState
                icon={Wallet}
                title="No earnings found"
                description={
                  statusFilter !== "ALL"
                    ? `No ${statusFilter.toLowerCase().replace(/_/g, " ")} earnings to display.`
                    : "Earnings will appear here after your appointments are completed and paid."
                }
              />
            }
          />

          {/* Pagination */}
          {pagination && pagination.total > limit && (
            <div className="flex flex-col gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-zinc-500">
                Showing {page * limit + 1}–
                {Math.min((page + 1) * limit, pagination.total)} of{" "}
                {pagination.total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={!pagination.hasMore}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Payout eligibility info */}
        {eligibility && (
          <div className="mt-4 p-4 bg-zinc-50 rounded-lg border border-zinc-200">
            <div className="flex items-start gap-3">
              <ArrowUpRight className="w-5 h-5 text-zinc-400 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-zinc-700">
                  Payout Information
                </p>
                <IndiaOnlyPayoutNotice variant="compact" className="mt-1" />
                {eligibility.isEligible ? (
                  <p className="text-xs text-zinc-500 mt-1">
                    {formatSummaryAmount(eligibility.readyAmount)} ready —
                    payouts are processed weekly
                  </p>
                ) : (
                  <div className="mt-2">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs text-zinc-500">
                        {formatSummaryAmount(eligibility.readyAmount)} of{" "}
                        {formatSummaryAmount(eligibility.minimumAmount)} minimum
                        reached
                      </p>
                      <p className="text-xs font-medium text-zinc-600">
                        {Math.min(
                          100,
                          Math.round(
                            (eligibility.readyAmount /
                              eligibility.minimumAmount) *
                              100,
                          ),
                        )}
                        %
                      </p>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{
                          width: `${Math.min(100, (eligibility.readyAmount / eligibility.minimumAmount) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </DashboardContent>
    </>
  );
}
