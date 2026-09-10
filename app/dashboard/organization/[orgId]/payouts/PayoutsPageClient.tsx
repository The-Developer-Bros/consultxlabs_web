"use client";

import { use, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Wallet,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  PauseCircle,
} from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";

interface PayoutItem {
  id: string;
  amountPaise: number;
  netPayoutPaise: number;
  grossRevenuePaise: number;
  platformFeePaise: number;
  refundsPaise: number;
  tdsAmountPaise: number | null;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  processedAt: string | null;
  createdAt: string;
}

interface PayoutsResponse {
  data: PayoutItem[];
  pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  // #997 secondary findings — server-aggregated, org-wide (ignores the
  // status filter/page) so the summary cards don't shift as the table is
  // narrowed/paged.
  stats: {
    totalPaidPaise: number;
    pendingPaise: number;
    counts: Record<string, number>;
  };
}

const PAGE_SIZE = 25;

async function fetchPayouts(
  orgId: string,
  offset: number,
  status: StatusFilter,
): Promise<PayoutsResponse> {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  if (status !== "ALL") params.set("status", status);
  const res = await fetch(`/api/organizations/${orgId}/payouts?${params}`);
  if (!res.ok) throw new Error("Failed to load payouts");
  return res.json();
}

// POST /payouts expects `{ periodStart, periodEnd }`. The dashboard
// "Create batch" button rolls up everything earned in the last 30 days
// since that matches the default cron cadence; admins running catch-up
// payouts can adjust via the API directly.
function defaultPayoutWindow(): { periodStart: Date; periodEnd: Date } {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd);
  periodStart.setDate(periodStart.getDate() - 30);
  return { periodStart, periodEnd };
}

// Mirrors prisma `enum PayoutStatus`. Keep in sync if new states are
// added — defaulting an unknown status to PENDING below means a missing
// entry here would silently mis-label payouts.
const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: typeof Clock }
> = {
  PENDING: { label: "Pending approval", variant: "secondary", icon: Clock },
  APPROVED: { label: "Approved", variant: "secondary", icon: CheckCircle2 },
  PROCESSING: { label: "Processing", variant: "outline", icon: Loader2 },
  COMPLETED: { label: "Completed", variant: "default", icon: CheckCircle2 },
  FAILED: { label: "Failed", variant: "destructive", icon: XCircle },
  CANCELLED: { label: "Cancelled", variant: "outline", icon: AlertCircle },
};

// Filter options for the status dropdown (#777 §B). "ALL" is the
// sentinel for "no filter"; the rest mirror `enum PayoutStatus`.
const STATUS_FILTERS = [
  "ALL",
  "PENDING",
  "APPROVED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  ALL: "All statuses",
  PENDING: "Pending approval",
  APPROVED: "Approved",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function PayoutsPageClient({
  params,
  livePayoutsEnabled,
}: {
  params: Promise<{ orgId: string }>;
  livePayoutsEnabled: boolean;
}) {
  const { orgId } = use(params);
  // #1132 — payout batches are `payouts.manage` (OWNER + BILLING_ADMIN).
  const { can } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "payouts.read",
    canHost: true,
  });
  const queryClient = useQueryClient();
  const [createError, setCreateError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [page, setPage] = useState(1);

  const { data, isPending, isError } = useQuery({
    queryKey: ["org-payouts", orgId, page, statusFilter],
    // Filter/page live in the key, so each value is its own query. Without
    // this, switching to one not yet fetched dropped `data` to undefined and
    // re-showed the loading branch. Same fix as #346 on the appointments list.
    placeholderData: keepPreviousData,
    queryFn: () => fetchPayouts(orgId, (page - 1) * PAGE_SIZE, statusFilter),
    enabled: allowed,
  });

  const createBatch = useMutation({
    mutationFn: async () => {
      const { periodStart, periodEnd } = defaultPayoutWindow();
      const res = await fetch(`/api/organizations/${orgId}/payouts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create payout batch");
      }
      return res.json();
    },
    onSuccess: () => {
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ["org-payouts", orgId] });
    },
    onError: (err: Error) => {
      setCreateError(err.message);
    },
  });

  const payouts = data?.data ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / PAGE_SIZE)) : 1;

  // #997 secondary findings — server-aggregated org-wide totals (was an
  // unbounded fetch-all + per-render reduce). Statuses come from prisma
  // `enum PayoutStatus`: PENDING / APPROVED / PROCESSING / COMPLETED /
  // FAILED / CANCELLED. "Total paid out" counts only fully-disbursed
  // COMPLETED payouts; "Pending" rolls up everything in flight.
  const stats = data?.stats;
  const totalPaid = stats?.totalPaidPaise ?? 0;
  const pendingAmount = stats?.pendingPaise ?? 0;
  const completedCount = stats?.counts.COMPLETED ?? 0;
  const totalPayoutsCount = stats?.counts.total ?? 0;
  const hasProcessingPayouts = (stats?.counts.PROCESSING ?? 0) > 0;

  // The list itself is now server-paginated + server-filtered (`status`
  // query param), so `payouts` is already the page to render — no more
  // client-side re-filtering over an unbounded fetch (#777 §B superseded).
  const visiblePayouts = payouts;

  if (!allowed) return null;

  return (
    <>
      <DashboardHeader
        title="Payouts"
        subtitle="Settlement history for the organization"
      />
      <DashboardContent>
        {isPending ? (
          <DashboardGrid columns={3}>
            {[1, 2, 3].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : isError || !data ? (
          /* Without this the failure path fell straight through to
             `stats?.totalPaidPaise ?? 0` and rendered "₹0.00 paid out ·
             ₹0.00 pending · No payouts yet." — a fetch error was
             indistinguishable from a genuinely empty settlement ledger.
             /home already handles this correctly; these surfaces did not. */
          <div className="rounded-lg border border-border bg-card p-6 text-sm">
            <p className="font-medium text-foreground">
              Couldn&apos;t load payouts
            </p>
            <p className="mt-1 text-muted-foreground">
              We couldn&apos;t reach the settlement ledger. This is a loading
              problem, not a zero balance — refresh to try again.
            </p>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <DashboardGrid columns={3}>
              <StatCard
                title="Total paid out"
                value={formatCurrencyAmount(totalPaid, "INR")}
                subtitle={`${completedCount} payouts`}
                icon={Wallet}
                variant="success"
              />
              <StatCard
                title="Pending"
                value={formatCurrencyAmount(pendingAmount, "INR")}
                icon={Clock}
                variant={pendingAmount > 0 ? "warning" : "default"}
              />
              <StatCard
                title="Total payouts"
                value={totalPayoutsCount}
                icon={CheckCircle2}
              />
            </DashboardGrid>

            {/* #776 §B: disbursement is gated until live payouts go-live;
                say so honestly rather than letting PROCESSING rows imply
                money is moving. */}
            {!livePayoutsEnabled && hasProcessingPayouts && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>
                    Disbursement isn&apos;t live yet. Approved payouts are
                    held — calculated and reserved, not failed — and will be
                    sent once the platform enables live payouts.
                  </p>
                </div>
              )}

            {/* Wave-4 (#1230) — CSV export for bank reconciliation. Plain
                anchor: the endpoint streams a download and auth rides the
                session cookie. */}
            <div className="mt-4">
              <a
                href={`/api/organizations/${orgId}/payouts/export`}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-zinc-50"
              >
                Export CSV
              </a>
            </div>

            {/* Create payout button */}
            {can("payouts.manage") && (
              <div className="mt-4 flex items-center gap-3">
                <Button
                  onClick={() => createBatch.mutate()}
                  disabled={createBatch.isPending}
                  size="sm"
                >
                  {createBatch.isPending && (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  )}
                  Create Payout Batch
                </Button>
                {createError && (
                  <p className="text-sm text-red-600">{createError}</p>
                )}
              </div>
            )}

            {/* Payout history table */}
            <Card className="mt-6">
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                <CardTitle className="text-base">Payout History</CardTitle>
                {totalPayoutsCount > 0 && (
                  <Select
                    value={statusFilter}
                    onValueChange={(v) => {
                      setStatusFilter(v as StatusFilter);
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_FILTERS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_FILTER_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </CardHeader>
              <CardContent>
                {totalPayoutsCount === 0 ? (
                  <p className="text-sm text-zinc-500 text-center py-8">
                    No payouts yet. Earnings will accumulate and you can create a
                    payout batch when ready.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-zinc-500">
                          <th className="text-left py-2 font-medium">Period</th>
                          <th className="text-right py-2 font-medium">Gross</th>
                          <th className="text-right py-2 font-medium">Net</th>
                          <th className="text-center py-2 font-medium">Status</th>
                          <th className="text-right py-2 font-medium">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePayouts.map((payout) => {
                          const cfg =
                            STATUS_CONFIG[payout.status] ??
                            STATUS_CONFIG.PENDING;
                          // #776 §B: while live payouts are off, a PROCESSING
                          // row is held at the platform, not in flight — label
                          // it as such so we never imply money is moving.
                          const heldForEnablement =
                            payout.status === "PROCESSING" &&
                            !livePayoutsEnabled;
                          // #1132 follow-up — the Net column shows the cash
                          // actually disbursed (amountPaise = net after TDS),
                          // not netPayoutPaise (pre-TDS org share). The
                          // tooltip itemizes every deduction the row carries;
                          // the rest is captioned, never faked.
                          const deduction =
                            payout.grossRevenuePaise - payout.amountPaise;
                          return (
                            <tr key={payout.id} className="border-b last:border-0">
                              <td className="py-3 text-zinc-700">
                                {new Date(payout.periodStart).toLocaleDateString()} -{" "}
                                {new Date(payout.periodEnd).toLocaleDateString()}
                              </td>
                              <td className="py-3 text-right text-zinc-500">
                                {formatCurrencyAmount(
                                  payout.grossRevenuePaise,
                                  payout.currency,
                                )}
                              </td>
                              <td className="py-3 text-right font-medium text-zinc-900">
                                {deduction > 0 ? (
                                  <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="cursor-help underline decoration-dotted underline-offset-2">
                                          {formatCurrencyAmount(
                                            payout.amountPaise,
                                            payout.currency,
                                          )}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="left"
                                        className="max-w-xs text-xs"
                                      >
                                        <div className="space-y-0.5">
                                          <div className="flex justify-between gap-4">
                                            <span>Platform fee</span>
                                            <span>
                                              −
                                              {formatCurrencyAmount(
                                                payout.platformFeePaise,
                                                payout.currency,
                                              )}
                                            </span>
                                          </div>
                                          {payout.refundsPaise > 0 && (
                                            <div className="flex justify-between gap-4">
                                              <span>Refunds</span>
                                              <span>
                                                −
                                                {formatCurrencyAmount(
                                                  payout.refundsPaise,
                                                  payout.currency,
                                                )}
                                              </span>
                                            </div>
                                          )}
                                          {(payout.tdsAmountPaise ?? 0) > 0 && (
                                            <div className="flex justify-between gap-4">
                                              <span>TDS withheld</span>
                                              <span>
                                                −
                                                {formatCurrencyAmount(
                                                  payout.tdsAmountPaise ?? 0,
                                                  payout.currency,
                                                )}
                                              </span>
                                            </div>
                                          )}
                                          <div className="pt-1 text-[11px] text-primary-foreground/70">
                                            Disbursed cash — net of platform
                                            fee, refunds and TDS.
                                          </div>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ) : (
                                  formatCurrencyAmount(
                                    payout.amountPaise,
                                    payout.currency,
                                  )
                                )}
                              </td>
                              <td className="py-3 text-center">
                                {heldForEnablement ? (
                                  <div className="flex flex-col items-center gap-0.5">
                                    <Badge variant="secondary">
                                      Pending platform enablement
                                    </Badge>
                                    <span className="text-[11px] text-zinc-400">
                                      Held — disbursement not live yet
                                    </span>
                                  </div>
                                ) : (
                                  <Badge variant={cfg.variant}>{cfg.label}</Badge>
                                )}
                              </td>
                              <td className="py-3 text-right text-zinc-500">
                                {payout.processedAt
                                  ? new Date(payout.processedAt).toLocaleDateString()
                                  : new Date(payout.createdAt).toLocaleDateString()}
                              </td>
                            </tr>
                          );
                        })}
                        {visiblePayouts.length === 0 && (
                          <tr>
                            <td
                              colSpan={5}
                              className="py-8 text-center text-sm text-zinc-500"
                            >
                              No {STATUS_FILTER_LABEL[statusFilter].toLowerCase()}{" "}
                              payouts.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Pagination — the list is now server-paginated (#997 secondary
                findings), so paging is a real fetch, not a client slice. */}
            {totalPages > 1 && (
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span className="flex items-center px-4 text-sm text-zinc-500">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </DashboardContent>
    </>
  );
}
