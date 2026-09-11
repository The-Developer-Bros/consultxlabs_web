"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import dynamic from "next/dynamic";

import PendingPayoutsSection from "./_sections/PendingPayoutsSection";
import ProcessingPayoutsSection from "./_sections/ProcessingPayoutsSection";
import CompletedPayoutsSection from "./_sections/CompletedPayoutsSection";
import EarningsSection from "./_sections/EarningsSection";

// Lazy-load recharts so it stays out of this route's first-load JS.
const PayoutsChart = dynamic(() => import("./PayoutsChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[200px] w-full animate-pulse rounded-md bg-muted" />
  ),
});

type TabKey = "pending" | "processing" | "completed" | "earnings";

const VALID_TABS: readonly TabKey[] = [
  "pending",
  "processing",
  "completed",
  "earnings",
] as const;

interface PayoutTrendSeriesDatum {
  day: string;
  label: string;
  totalPaise: number;
}

interface PayoutTrendResponse {
  series: PayoutTrendSeriesDatum[];
}

// #997 secondary findings — the 7-day bucketing used to run client-side over
// a `?limit=100` guess (not 7-day-safe at scale). The server now returns an
// already-bucketed, bounded 7-day series via /api/admin/payouts/trend.
async function fetchPayoutTrend(): Promise<PayoutTrendResponse> {
  const response = await fetch("/api/admin/payouts/trend");
  if (!response.ok) {
    throw new Error("Failed to fetch payout trend");
  }
  return response.json() as Promise<PayoutTrendResponse>;
}

export default function AdminPayoutsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: TabKey = (VALID_TABS as readonly string[]).includes(
    tabParam ?? "",
  )
    ? (tabParam as TabKey)
    : "pending";

  const handleTabChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(Array.from(searchParams.entries()));
      next.set("tab", value);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const { data: trendData, isLoading: trendLoading } = useQuery({
    queryKey: ["admin-payout-trend"],
    queryFn: fetchPayoutTrend,
    staleTime: 60 * 1000,
  });

  const chartData = useMemo(
    () =>
      (trendData?.series ?? []).map((d) => ({
        day: d.day,
        label: d.label,
        // amounts are paise server-side — normalize to major units for display.
        total: d.totalPaise / 100,
      })),
    [trendData?.series],
  );

  const hasAnyTrendData = chartData.some((d) => d.total > 0);

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Payouts"
        subtitle="Manage consultant payouts and earnings"
      />

      {/* Payout trend chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Payouts - Last 7 Days</CardTitle>
        </CardHeader>
        <CardContent>
          {trendLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : hasAnyTrendData ? (
            <PayoutsChart data={chartData} />
          ) : (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
              Analytics coming soon
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="grid h-auto w-full max-w-xl grid-cols-2 gap-1 sm:h-9 sm:grid-cols-4">
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="processing">Processing</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="earnings">Earnings</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-6">
          <PendingPayoutsSection />
        </TabsContent>
        <TabsContent value="processing" className="mt-6">
          <ProcessingPayoutsSection />
        </TabsContent>
        <TabsContent value="completed" className="mt-6">
          <CompletedPayoutsSection />
        </TabsContent>
        <TabsContent value="earnings" className="mt-6">
          <EarningsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
