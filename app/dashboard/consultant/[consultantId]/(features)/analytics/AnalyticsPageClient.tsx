"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parse } from "date-fns";
import {
  BarChart3,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  IndianRupee,
  Wallet,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import {
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { DataCard, EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createConsultantQueries } from "@/lib/dashboard-queries";
import { useSession } from "@/lib/auth-client";
import { getAppointmentStatus } from "../../utils/appointmentHelpers";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { MonthlyEarning } from "@/lib/data/consultant-earnings-analytics";

interface EarningsAnalyticsResponse {
  summary: {
    totalEarnings: number;
    pendingEarnings: number;
    readyEarnings: number;
    paidEarnings: number;
    heldEarnings: number;
    pendingTrustEarnings: number;
  };
  monthlyEarnings?: MonthlyEarning[];
}

const formatInr = (paise: number) => formatCurrencyAmount(paise, "INR");

const monthLabel = (month: string) =>
  format(parse(month, "yyyy-MM", new Date()), "MMM");

export default function AnalyticsPageClient({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data: session } = useSession();
  // GET /api/consultant/earnings is strictly session-scoped (it resolves
  // the profile from the signed-in user), while the SSR prefetch keys this
  // cache entry by the URL's consultantId. For a privileged viewer
  // (ADMIN/STAFF on someone else's dashboard) a client refetch would fetch
  // the WRONG record — so refetching is gated to the profile owner and
  // non-owners render the server-prefetched data only.
  const isOwnDashboard =
    (session?.user as { consultantProfileId?: string } | undefined)
      ?.consultantProfileId === consultantId;

  // queryKey MUST match the server prefetch in ./page.tsx.
  const {
    data: earningsData,
    isLoading: earningsLoading,
    isError: earningsError,
    refetch: refetchEarnings,
  } = useQuery<EarningsAnalyticsResponse>({
    queryKey: ["consultant-earnings-analytics", consultantId],
    queryFn: async () => {
      const res = await fetch(
        "/api/consultant/earnings?includeMonthly=1&limit=1",
      );
      if (!res.ok) throw new Error("Failed to fetch earnings analytics");
      return res.json();
    },
    staleTime: 60_000,
    retry: 2,
    enabled: isOwnDashboard,
  });

  // react-query's refetch() bypasses `enabled`, so the Retry buttons must
  // re-apply the owner gate — otherwise a privileged viewer's retry would
  // fetch THEIR session-scoped earnings under this consultant's cache key.
  const retryEarnings = () => {
    if (isOwnDashboard) void refetchEarnings();
  };

  // Personal-scope appointments — same key + payload as the appointments
  // page's #890 SSR prefetch, so the two pages share one cache entry.
  const appointmentsQuery = createConsultantQueries(
    consultantId,
    "personal",
  ).appointments;
  const {
    data: appointments,
    isLoading: appointmentsLoading,
    isError: appointmentsError,
    refetch: refetchAppointments,
  } = useQuery(appointmentsQuery);

  const sessionStats = useMemo(() => {
    const all = appointments ?? [];
    let completed = 0;
    let cancelled = 0;
    let upcoming = 0;
    for (const appointment of all) {
      const status = getAppointmentStatus(appointment);
      if (status === "Completed") completed += 1;
      else if (status === "Cancelled") cancelled += 1;
      else if (status !== "Not Scheduled") upcoming += 1;
    }
    const settled = completed + cancelled;
    return {
      completed,
      upcoming,
      completionRate:
        settled > 0 ? Math.round((completed / settled) * 100) : null,
    };
  }, [appointments]);

  const monthly = earningsData?.monthlyEarnings ?? [];
  const chartData = monthly.map((m) => ({
    label: monthLabel(m.month),
    totalInr: m.totalPaise / 100,
    count: m.count,
  }));
  const thisMonth = monthly.at(-1);
  const hasAnyEarnings =
    (earningsData?.summary.totalEarnings ?? 0) > 0 ||
    monthly.some((m) => m.count > 0);

  const summary = earningsData?.summary;

  return (
    // No DashboardHeader — this is the Analytics tab of the Earnings page now,
    // which renders one header above the tab strip.
    <DashboardErrorBoundary>
      <DashboardContent className="px-0 lg:px-0">
        {/* KPI grid */}
        {earningsLoading || appointmentsLoading ? (
          <DashboardGrid columns={3}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : earningsError && appointmentsError ? (
          <EmptyState
            icon={BarChart3}
            title="Couldn't load analytics"
            description="Both the earnings and session reads failed. Please retry."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  retryEarnings();
                  void refetchAppointments();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <DashboardGrid columns={3}>
            <StatCard
              title="Total Earnings"
              value={formatInr(summary?.totalEarnings ?? 0)}
              icon={IndianRupee}
              tooltip="All cleared earnings (pending + ready + paid + held). Excludes refunds and org-trust holds."
            />
            <StatCard
              title="This Month"
              value={formatInr(thisMonth?.totalPaise ?? 0)}
              icon={CalendarCheck}
              subtitle={
                thisMonth ? `${thisMonth.count} earning sessions` : undefined
              }
            />
            <StatCard
              title="Ready for Payout"
              value={formatInr(summary?.readyEarnings ?? 0)}
              icon={Wallet}
              variant="success"
            />
            <StatCard
              title="Sessions Completed"
              value={appointmentsError ? "—" : sessionStats.completed}
              icon={CheckCircle2}
              tooltip="Completed appointments in your personal practice."
            />
            <StatCard
              title="Upcoming Sessions"
              value={appointmentsError ? "—" : sessionStats.upcoming}
              icon={CalendarClock}
            />
            <StatCard
              title="Completion Rate"
              value={
                appointmentsError || sessionStats.completionRate === null
                  ? "—"
                  : `${sessionStats.completionRate}%`
              }
              icon={BarChart3}
              tooltip="Completed sessions as a share of all settled (completed + cancelled) sessions."
            />
          </DashboardGrid>
        )}

        {/* Charts */}
        <div className="mt-6 grid gap-4 lg:gap-6 grid-cols-1 lg:grid-cols-2">
          <DataCard title="Earnings — last 6 months">
            {earningsLoading ? (
              <Skeleton className="h-[220px] w-full rounded-lg" />
            ) : earningsError ? (
              <EmptyState
                icon={BarChart3}
                title="Couldn't load earnings trend"
                action={
                  <Button variant="outline" size="sm" onClick={retryEarnings}>
                    Retry
                  </Button>
                }
              />
            ) : !hasAnyEarnings ? (
              <EmptyState
                icon={IndianRupee}
                title="No earnings yet"
                description="Once you complete paid sessions, your monthly earnings trend shows up here."
              />
            ) : (
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                    <XAxis
                      dataKey="label"
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) =>
                        value >= 1000
                          ? `${(value / 1000).toFixed(1)}k`
                          : String(value)
                      }
                    />
                    <Tooltip
                      formatter={(value) =>
                        // Recharts can hand the formatter undefined/arrays
                        // on empty data points — never call toLocaleString
                        // on a non-number.
                        typeof value === "number"
                          ? value.toLocaleString(undefined, {
                              style: "currency",
                              currency: "INR",
                              maximumFractionDigits: 0,
                            })
                          : ""
                      }
                    />
                    <Bar
                      dataKey="totalInr"
                      name="Earnings"
                      fill="#71717a"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </DataCard>

          <DataCard title="Earning sessions — last 6 months">
            {earningsLoading ? (
              <Skeleton className="h-[220px] w-full rounded-lg" />
            ) : earningsError ? (
              <EmptyState
                icon={BarChart3}
                title="Couldn't load session trend"
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    // Session trend derives from the appointments query —
                    // the earnings refetch was the wrong retry target.
                    onClick={() => void refetchAppointments()}
                  >
                    Retry
                  </Button>
                }
              />
            ) : !hasAnyEarnings ? (
              <EmptyState
                icon={CalendarCheck}
                title="No sessions yet"
                description="Session volume per month appears here once earnings start flowing."
              />
            ) : (
              <div style={{ width: "100%", height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
                    <XAxis
                      dataKey="label"
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="count"
                      name="Sessions"
                      stroke="#18181b"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </DataCard>
        </div>
      </DashboardContent>
    </DashboardErrorBoundary>
  );
}
