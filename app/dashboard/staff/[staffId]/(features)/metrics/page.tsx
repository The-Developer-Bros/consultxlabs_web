"use client";

import * as Sentry from "@sentry/nextjs";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AnalyticsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import {
  RefreshCw,
  BarChart3,
  Ticket,
  Users,
  Clock,
  CheckCircle,
  UserPlus,
  Activity,
  Calendar,
  TrendingUp,
  Info,
} from "lucide-react";

interface StaffMetrics {
  supportMetrics: {
    ticketsResolvedToday: number;
    ticketsResolvedThisWeek: number;
    ticketsResolvedThisMonth: number;
    openTickets: number;
    avgResponseTimeHours: number;
  };
  userMetrics: {
    usersHelpedThisWeek: number;
    activeUsers: number;
    newSignupsThisMonth: number;
    totalUsers: number;
  };
  platformMetrics: {
    totalAppointments: number;
    pendingPayments: number;
  };
}

export default function StaffMetricsPage() {
  const { data, isPending, isFetching, isError, refetch } =
    useQuery<StaffMetrics>({
      queryKey: ["staff-metrics"],
      queryFn: async (): Promise<StaffMetrics> => {
        try {
          const response = await fetch("/api/staff/metrics");
          if (!response.ok) throw new Error("Failed to fetch metrics");
          return response.json();
        } catch (error) {
          Sentry.captureException(
            error instanceof Error ? error : new Error(String(error)),
            { tags: { subsystem: "client" } },
          );
          throw error;
        }
      },
    });

  const metrics = data;

  if (isPending) {
    return <AnalyticsSkeleton />;
  }

  if (isError && !metrics) {
    return (
      <div className="space-y-6">
        <DashboardHeader
          title="Metrics"
          subtitle="Operational metrics and insights"
        />
        <Card>
          <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <BarChart3 className="h-12 w-12 mb-4 text-muted-foreground/40" />
            <p>Unable to load metrics</p>
            <Button
              variant="outline"
              onClick={() => refetch()}
              className="mt-4"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!metrics) {
    return null;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title="Metrics"
        subtitle="Operational metrics and insights"
        actions={
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Staff Access Notice */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Staff Metrics View</AlertTitle>
        <AlertDescription>
          This dashboard shows operational metrics relevant to staff activities.
          Revenue and financial data are available in the admin dashboard.
        </AlertDescription>
      </Alert>

      {/* Support Performance */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-foreground">
          <Ticket className="h-5 w-5 text-muted-foreground" />
          Support Performance
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Resolved Today</p>
                  <p className="text-3xl font-bold text-green-600 dark:text-green-400">
                    {metrics.supportMetrics.ticketsResolvedToday}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-green-50 dark:bg-green-950">
                  <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Resolved This Week
                  </p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.supportMetrics.ticketsResolvedThisWeek}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <TrendingUp className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Open Tickets</p>
                  <p
                    className={`text-3xl font-bold ${metrics.supportMetrics.openTickets > 10 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}
                  >
                    {metrics.supportMetrics.openTickets}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-full ${metrics.supportMetrics.openTickets > 10 ? "bg-red-50 dark:bg-red-950" : "bg-muted"}`}
                >
                  <Ticket
                    className={`h-6 w-6 ${metrics.supportMetrics.openTickets > 10 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Avg Response Time
                  </p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.supportMetrics.avgResponseTimeHours}h
                  </p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <Clock className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* User Metrics */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-foreground">
          <Users className="h-5 w-5 text-muted-foreground" />
          User Metrics
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Users Helped This Week
                  </p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.userMetrics.usersHelpedThisWeek}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <Users className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Active Users</p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.userMetrics.activeUsers}
                  </p>
                  <p className="text-xs text-muted-foreground/70">This month</p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <Activity className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">New Signups</p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.userMetrics.newSignupsThisMonth}
                  </p>
                  <p className="text-xs text-muted-foreground/70">This month</p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <UserPlus className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Users</p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.userMetrics.totalUsers.toLocaleString()}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <Users className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Platform Health */}
      <div>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-foreground">
          <Calendar className="h-5 w-5 text-muted-foreground" />
          Platform Activity
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Total Appointments
                  </p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.platformMetrics.totalAppointments.toLocaleString()}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <Calendar className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Pending Payments
                  </p>
                  <p
                    className={`text-3xl font-bold ${metrics.platformMetrics.pendingPayments > 20 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}
                  >
                    {metrics.platformMetrics.pendingPayments}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-full ${metrics.platformMetrics.pendingPayments > 20 ? "bg-amber-50 dark:bg-amber-950" : "bg-muted"}`}
                >
                  <Clock
                    className={`h-6 w-6 ${metrics.platformMetrics.pendingPayments > 20 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Monthly Resolved
                  </p>
                  <p className="text-3xl font-bold text-foreground">
                    {metrics.supportMetrics.ticketsResolvedThisMonth}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-muted">
                  <BarChart3 className="h-6 w-6 text-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
