"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { formatCurrencyAmount } from "@/utils/formatting";

async function fetchAnalytics() {
  const response = await fetch("/api/admin/analytics");
  if (!response.ok) {
    throw new Error("Failed to fetch analytics");
  }
  return response.json();
}

export default function AdminAnalyticsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-analytics"],
    queryFn: fetchAnalytics,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <DashboardHeader title="Analytics" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-[100px]" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-[60px]" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <DashboardHeader title="Analytics" />
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-red-500 dark:text-red-400">
              Failed to load analytics. Please try again later.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DashboardHeader title="Analytics" subtitle="Platform usage and growth metrics" />

      {/* User Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {data?.totalUsers || 0}
            </div>
            <p className="text-xs text-green-600 dark:text-green-400 mt-1">
              +{data?.newUsersThisMonth || 0} this month
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Consultants
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {data?.totalConsultants || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {data?.activeConsultants || 0} active
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Consultees
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {data?.totalConsultees || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {data?.activeConsultees || 0} active
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-shadow">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Staff Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {data?.totalStaff || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Session Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sessions Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Sessions</span>
                <span className="font-bold">{data?.totalSessions || 0}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Completed Sessions</span>
                <span className="font-bold text-green-600 dark:text-green-400">
                  {data?.completedSessions || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Upcoming Sessions</span>
                <span className="font-bold text-foreground">
                  {data?.upcomingSessions || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Cancelled Sessions</span>
                <span className="font-bold text-red-600 dark:text-red-400">
                  {data?.cancelledSessions || 0}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Revenue Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Revenue</span>
                <span className="font-bold">
                  {formatCurrencyAmount(data?.totalRevenue ?? 0, "INR")}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">This Month</span>
                <span className="font-bold text-green-600 dark:text-green-400">
                  {formatCurrencyAmount(data?.revenueThisMonth ?? 0, "INR")}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">
                  Average Session Value
                </span>
                <span className="font-bold">
                  {formatCurrencyAmount(data?.avgSessionValue ?? 0, "INR")}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Refunds</span>
                <span className="font-bold text-red-600 dark:text-red-400">
                  {formatCurrencyAmount(data?.totalRefunds ?? 0, "INR")}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top Domains */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Top Consulting Domains</CardTitle>
        </CardHeader>
        <CardContent>
          {data?.topDomains?.length > 0 ? (
            <div className="space-y-3">
              {data.topDomains.map(
                (
                  domain: { name: string; consultantCount: number },
                  index: number,
                ) => (
                  <div
                    key={domain.name}
                    className="flex items-center justify-between p-3 border border-border rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-muted-foreground/70 text-sm w-6">
                        #{index + 1}
                      </span>
                      <span className="font-medium">{domain.name}</span>
                    </div>
                    <span className="text-muted-foreground">
                      {domain.consultantCount} consultants
                    </span>
                  </div>
                ),
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-center py-4">
              No domain data available
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
