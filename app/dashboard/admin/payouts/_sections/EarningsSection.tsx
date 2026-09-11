"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Wallet,
  TrendingUp,
  Clock,
  CheckCircle,
  AlertTriangle,
  Send,
} from "lucide-react";
import type { EarningsStats, Earning } from "@/types/payments";

interface EarningsStatsResponse {
  stats: EarningsStats;
}

interface EarningsListResponse {
  earnings: Earning[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

async function fetchEarningsStats(): Promise<EarningsStatsResponse> {
  const response = await fetch("/api/admin/earnings/stats");
  if (!response.ok) {
    throw new Error("Failed to fetch earnings stats");
  }
  return response.json() as Promise<EarningsStatsResponse>;
}

async function fetchEarnings(
  status?: string,
  page = 1,
  limit = 20,
): Promise<EarningsListResponse> {
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: ((page - 1) * limit).toString(),
  });
  if (status) params.set("status", status);

  const response = await fetch(`/api/admin/earnings?${params}`);
  if (!response.ok) {
    throw new Error("Failed to fetch earnings");
  }
  return response.json() as Promise<EarningsListResponse>;
}

export default function EarningsSection() {
  const [status, setStatus] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const limit = 20;

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["admin-earnings-stats"],
    queryFn: fetchEarningsStats,
    staleTime: 60 * 1000,
  });

  const { data: earningsData, isLoading: earningsLoading } = useQuery({
    queryKey: ["admin-earnings", status, page],
    // Filter/page live in the key, so each value is its own query. Without
    // this, switching to one not yet fetched dropped `data` to undefined and
    // re-showed the loading branch. Same fix as #346 on the appointments list.
    placeholderData: keepPreviousData,
    queryFn: () => fetchEarnings(status, page, limit),
    staleTime: 30 * 1000,
  });

  const stats: EarningsStats = statsData?.stats || {
    pending: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    ready: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    batched: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    paid: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    held: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    refunded: { count: 0, consultantSharePaise: 0, platformFeePaise: 0 },
    totalPlatformRevenue: 0,
  };

  const formatAmount = (amount: number) =>
    (amount / 100).toLocaleString("en-IN", {
      style: "currency",
      currency: "INR",
    });

  const getStatusBadge = (status: string) => {
    const badges: Record<string, { bg: string; text: string }> = {
      PENDING: {
        bg: "bg-yellow-100 dark:bg-yellow-950/40",
        text: "text-yellow-800 dark:text-yellow-400",
      },
      READY: { bg: "bg-muted", text: "text-foreground" },
      PAID: {
        bg: "bg-green-100 dark:bg-green-950/40",
        text: "text-green-800 dark:text-green-400",
      },
      HELD: { bg: "bg-muted", text: "text-foreground" },
      REFUNDED: {
        bg: "bg-red-100 dark:bg-red-950/40",
        text: "text-red-800 dark:text-red-400",
      },
    };
    const badge = badges[status] || {
      bg: "bg-muted",
      text: "text-muted-foreground",
    };
    return (
      <span
        className={`px-2 py-1 rounded text-xs font-medium ${badge.bg} ${badge.text}`}
      >
        {status}
      </span>
    );
  };

  const earningsColumns: ResponsiveColumn<Earning>[] = [
    {
      key: "consultant",
      header: "Consultant",
      primary: true,
      cell: (earning) => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {earning.consultantProfile?.user?.name || "Unknown"}
          </p>
          <p className="text-xs text-muted-foreground">
            {earning.consultantProfile?.user?.email}
          </p>
        </div>
      ),
    },
    {
      key: "gross",
      header: "Gross",
      cell: (earning) => (
        <span className="text-sm text-foreground">
          {formatAmount(earning.grossAmount)}
        </span>
      ),
    },
    {
      key: "platformFee",
      header: "Platform Fee",
      cell: (earning) => (
        <span className="text-sm text-muted-foreground">
          {formatAmount(earning.platformFeePaise)}
        </span>
      ),
    },
    {
      key: "consultantShare",
      header: "Consultant Share",
      cell: (earning) => (
        <span className="text-sm font-semibold text-green-700 dark:text-green-400">
          {formatAmount(earning.consultantSharePaise)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (earning) => getStatusBadge(earning.status),
    },
    {
      key: "date",
      header: "Date",
      cell: (earning) => (
        <span className="text-sm text-muted-foreground">
          {new Date(earning.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
        {statsLoading ? (
          <>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Pending (Hold)
                    </p>
                    <p className="text-xl font-bold text-yellow-700 dark:text-yellow-400">
                      {stats.pending.count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatAmount(stats.pending.consultantSharePaise)}
                    </p>
                  </div>
                  <Clock className="w-8 h-8 text-yellow-500 dark:text-yellow-400" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Ready for Payout
                    </p>
                    <p className="text-xl font-bold text-foreground">
                      {stats.ready.count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatAmount(stats.ready.consultantSharePaise)}
                    </p>
                  </div>
                  <Wallet className="w-8 h-8 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>

            {/* #837 split BATCHED out of READY. The producer has returned this
                bucket ever since; the dashboard was never given a card for it,
                so cleared earnings already committed to a payout batch stopped
                being counted under "Ready" and started appearing nowhere at
                all — money in transit, invisible. */}
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Batched (In Transit)
                    </p>
                    <p className="text-xl font-bold text-blue-700 dark:text-blue-400">
                      {stats.batched.count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatAmount(stats.batched.consultantSharePaise)}
                    </p>
                  </div>
                  <Send className="w-8 h-8 text-blue-500 dark:text-blue-400" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Paid Out</p>
                    <p className="text-xl font-bold text-green-700 dark:text-green-400">
                      {stats.paid.count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatAmount(stats.paid.consultantSharePaise)}
                    </p>
                  </div>
                  <CheckCircle className="w-8 h-8 text-green-500 dark:text-green-400" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Held (Dispute)
                    </p>
                    <p className="text-xl font-bold text-foreground">
                      {stats.held.count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatAmount(stats.held.consultantSharePaise)}
                    </p>
                  </div>
                  <AlertTriangle className="w-8 h-8 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-muted">
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">
                      Platform Revenue
                    </p>
                    <p className="text-xl font-bold text-foreground">
                      {formatAmount(stats.totalPlatformRevenue)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Total fees earned
                    </p>
                  </div>
                  <TrendingUp className="w-8 h-8 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Earnings List */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-lg">All Earnings</CardTitle>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value === "all" ? undefined : value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Filter status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="READY">Ready</SelectItem>
                <SelectItem value="PAID">Paid</SelectItem>
                <SelectItem value="HELD">Held</SelectItem>
                <SelectItem value="REFUNDED">Refunded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {earningsLoading || !earningsData ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <>
              <ResponsiveTable<Earning>
                columns={earningsColumns}
                rows={earningsData.earnings}
                getRowId={(e) => e.id}
                empty={
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">No earnings found</p>
                  </div>
                }
              />

              {/* Pagination */}
              {earningsData?.pagination &&
                earningsData.earnings.length > 0 && (
                  <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm text-muted-foreground">
                      Showing {(page - 1) * limit + 1} to{" "}
                      {Math.min(page * limit, earningsData.pagination.total)} of{" "}
                      {earningsData.pagination.total} earnings
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPage((p) => p + 1)}
                        disabled={!earningsData.pagination.hasMore}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
