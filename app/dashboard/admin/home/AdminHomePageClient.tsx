"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { DataCard, EmptyState } from "@/components/dashboard/DataCard";
import {
  CreditCard,
  Clock,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  ChevronRight,
  Zap,
} from "lucide-react";
import { cn } from "@/utils/tailwind";
import { formatCurrencyAmount } from "@/utils/formatting";
import type {
  AdminDashboardStats,
  RecentPayment,
  RecentRefund,
} from "@/types/payments";

// Fetch admin dashboard stats
async function fetchAdminStats(): Promise<AdminDashboardStats> {
  const response = await fetch("/api/admin/stats");
  if (!response.ok) {
    throw new Error("Failed to fetch admin stats");
  }
  return response.json() as Promise<AdminDashboardStats>;
}

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

export default function AdminHomePageClient() {
  // queryKey ["admin-stats"] MUST match the getAdminStats prefetch key in
  // app/dashboard/admin/home/page.tsx so SSR hydration feeds this useQuery. #890
  const {
    data: stats,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: fetchAdminStats,
    staleTime: 1 * 60 * 1000,
    // Focus rather than a timer: an admin dashboard left open on a second
    // screen refetched forever for nobody. The global default is
    // refetchOnWindowFocus:false, so freshness has to be asked for here — and
    // without it this query would never refresh at all, since refetchOnMount
    // is off too.
    refetchOnWindowFocus: true,
  });

  // Surface a real error rather than rendering zeros/"₹0", which an admin
  // would read as "no platform activity / gateways down" when the fetch
  // simply failed. Only when there's no cached payload to fall back on.
  if (isError && !stats) {
    return (
      <>
        <DashboardHeader
          title="Admin Dashboard"
          subtitle="Overview of platform payments and transactions"
        />
        <DashboardContent>
          <EmptyState
            icon={AlertTriangle}
            title="Unable to load admin stats"
            description="Something went wrong fetching platform stats. Please retry."
            action={
              <button
                type="button"
                onClick={() => refetch()}
                className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </button>
            }
          />
        </DashboardContent>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <DashboardHeader
          title="Admin Dashboard"
          subtitle="Overview of platform payments and transactions"
        />
        <DashboardContent>
          <div className="space-y-6">
            <DashboardGrid columns={4}>
              {[1, 2, 3, 4].map((i) => (
                <StatCardSkeleton key={i} />
              ))}
            </DashboardGrid>
          </div>
        </DashboardContent>
      </>
    );
  }

  return (
    <>
      <DashboardHeader
        title="Admin Dashboard"
        subtitle="Overview of platform payments and transactions"
      />

      <DashboardContent>
        <motion.div
          variants={staggerChildren}
          initial="hidden"
          animate="visible"
          className="space-y-6"
        >
          {/* Stats Grid */}
          <motion.div variants={fadeInUp}>
            <DashboardGrid columns={4}>
              <StatCard
                title="Total Payments"
                value={stats?.totalPayments || 0}
                subtitle={`${formatCurrencyAmount(stats?.totalPaymentsValue ?? 0, "INR")} total value`}
                icon={CreditCard}
                variant="default"
              />
              <StatCard
                title="Pending Payments"
                value={stats?.pendingPayments || 0}
                subtitle={`${formatCurrencyAmount(stats?.pendingPaymentsValue ?? 0, "INR")} pending`}
                icon={Clock}
                variant="warning"
              />
              <StatCard
                title="Refunds"
                value={stats?.totalRefunds || 0}
                subtitle={`${formatCurrencyAmount(stats?.totalRefundsValue ?? 0, "INR")} refunded`}
                icon={RefreshCw}
                variant="default"
              />
              <StatCard
                title="Active Disputes"
                value={stats?.activeDisputes || 0}
                subtitle={`${stats?.totalDisputes || 0} total disputes`}
                icon={AlertTriangle}
                variant="danger"
              />
            </DashboardGrid>
          </motion.div>

          {/* Recent Activity Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <motion.div variants={fadeInUp}>
              <DataCard
                title="Recent Payments"
                icon={TrendingUp}
                viewAllLink="/dashboard/admin/payments"
                viewAllText="View all payments"
              >
                {stats?.recentPayments && stats.recentPayments.length > 0 ? (
                  <div className="space-y-3">
                    {stats.recentPayments.map((payment: RecentPayment) => (
                      <Link
                        key={payment.id}
                        href={`/dashboard/admin/payments/${payment.id}`}
                        className="group flex items-center justify-between p-3 rounded-xl border border-border hover:border-border hover:bg-muted transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                            <CreditCard className="h-5 w-5 text-foreground" />
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {formatCurrencyAmount(
                                payment.amount,
                                payment.currency,
                              )}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {payment.paymentGateway} •{" "}
                              {payment.appointment?.appointmentType ?? "N/A"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              "text-xs px-2.5 py-1 rounded-full font-medium",
                              payment.paymentStatus === "SUCCEEDED"
                                ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400"
                                : payment.paymentStatus === "PENDING"
                                  ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                                  : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
                            )}
                          >
                            {payment.paymentStatus}
                          </span>
                          <ChevronRight className="h-4 w-4 text-muted-foreground/70 group-hover:text-muted-foreground transition-colors" />
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={CreditCard}
                    title="No recent payments"
                    description="Payments will appear here once they're processed"
                  />
                )}
              </DataCard>
            </motion.div>

            <motion.div variants={fadeInUp}>
              <DataCard
                title="Recent Refunds"
                icon={RefreshCw}
                viewAllLink="/dashboard/admin/refunds"
                viewAllText="View all refunds"
              >
                {stats?.recentRefunds && stats.recentRefunds.length > 0 ? (
                  <div className="space-y-3">
                    {stats.recentRefunds.map((refund: RecentRefund) => (
                      <Link
                        key={refund.id}
                        href={`/dashboard/admin/refunds/${refund.id}`}
                        className="group flex items-center justify-between p-3 rounded-xl border border-border hover:border-border hover:bg-muted transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                            <RefreshCw className="h-5 w-5 text-foreground" />
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {formatCurrencyAmount(
                                refund.amountPaise,
                                refund.currency,
                              )}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {refund.paymentGateway}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span
                            className={cn(
                              "text-xs px-2.5 py-1 rounded-full font-medium",
                              refund.status === "SUCCEEDED"
                                ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400"
                                : refund.status === "PENDING"
                                  ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                                  : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
                            )}
                          >
                            {refund.status}
                          </span>
                          <ChevronRight className="h-4 w-4 text-muted-foreground/70 group-hover:text-muted-foreground transition-colors" />
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={RefreshCw}
                    title="No recent refunds"
                    description="Refund requests will appear here"
                  />
                )}
              </DataCard>
            </motion.div>
          </div>

          {/* Payment Gateway Status */}
          <motion.div variants={fadeInUp}>
            <DataCard title="Payment Gateway Status" icon={Zap}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {["STRIPE", "RAZORPAY"].map(
                  (gateway) => {
                    const isActive =
                      gateway === "STRIPE" || gateway === "RAZORPAY";
                    const count = stats?.gatewayStats?.[gateway]?.count || 0;

                    return (
                      <div
                        key={gateway}
                        className="p-4 rounded-xl border border-border hover:border-border transition-all"
                      >
                        <div className="flex items-center justify-between mb-3">
                          <span className="font-medium text-foreground">
                            {gateway}
                          </span>
                          <div className="flex items-center gap-2">
                            <div
                              className={cn(
                                "h-2.5 w-2.5 rounded-full",
                                isActive
                                  ? "bg-green-500 dark:bg-green-400"
                                  : "bg-muted-foreground/30",
                              )}
                            />
                            <span
                              className={cn(
                                "text-xs font-medium",
                                isActive
                                  ? "text-green-600 dark:text-green-400"
                                  : "text-muted-foreground/70",
                              )}
                            >
                              {isActive ? "Active" : "Inactive"}
                            </span>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <p className="text-2xl font-bold text-foreground">
                            {count}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            payment{count !== 1 ? "s" : ""} processed
                          </p>
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            </DataCard>
          </motion.div>
        </motion.div>
      </DashboardContent>
    </>
  );
}
