"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import { Clock, AlertCircle, ExternalLink, RefreshCcw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { formatCurrencyAmount } from "@/utils/formatting";

interface ApprovalPayment {
  id: string;
  type: "consultation" | "subscription";
  title: string;
  consultantName: string;
  consulteeName: string;
  consulteeEmail: string;
  amount: number;
  currency: string;
  paymentUrl: string;
  approvedAt: string;
  expiresAt: string;
  isExpired: boolean;
  isExpiringSoon: boolean; // < 24 hours
  status: string;
}

// Fetch approval payments
async function fetchApprovalPayments() {
  const response = await fetch("/api/dashboard/admin/approval-payments");
  if (!response.ok) {
    throw new Error("Failed to fetch approval payments");
  }
  return response.json();
}

export default function ApprovalPaymentsPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-approval-payments", refreshKey],
    queryFn: fetchApprovalPayments,
    staleTime: 30 * 1000, // 30 seconds
    // See AdminHomePageClient: focus, not a timer. Explicit because the global
    // default disables BOTH focus and mount refetching, so dropping the
    // interval without this would freeze the list at first load.
    refetchOnWindowFocus: true,
  });

  const handleRefresh = () => {
    setRefreshKey((prev) => prev + 1);
    refetch();
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600 dark:text-red-400">
              Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              {error instanceof Error
                ? error.message
                : "Failed to load approval payments"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const approvalPayments: ApprovalPayment[] = data?.approvalPayments || [];
  const expiredCount = approvalPayments.filter((p) => p.isExpired).length;
  const expiringSoonCount = approvalPayments.filter(
    (p) => p.isExpiringSoon && !p.isExpired,
  ).length;
  const activeCount = approvalPayments.filter(
    (p) => !p.isExpired && !p.isExpiringSoon,
  ).length;

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Approval Payments Monitor"
        subtitle="Track consultations and subscriptions awaiting payment after approval"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isLoading}
            className="gap-2"
          >
            <RefreshCcw
              className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-foreground">
              {approvalPayments.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-green-600 dark:text-green-400">
              Active
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {activeCount}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Expiring Soon
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
              {expiringSoonCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              &lt; 24 hours remaining
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-red-600 dark:text-red-400">
              Expired
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600 dark:text-red-400">
              {expiredCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Requires manual intervention
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Payments List */}
      <Card>
        <CardHeader>
          <CardTitle>Pending Approval Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          ) : approvalPayments.length > 0 ? (
            <div className="space-y-4">
              {approvalPayments.map((payment) => (
                <div
                  key={payment.id}
                  className={`border rounded-lg p-4 ${
                    payment.isExpired
                      ? "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-950/30"
                      : payment.isExpiringSoon
                        ? "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30"
                        : "border-border bg-card"
                  }`}
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 space-y-2">
                      {/* Header */}
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-foreground">
                          {payment.title}
                        </h3>
                        <Badge variant="outline">
                          {payment.type.toUpperCase()}
                        </Badge>
                        {payment.isExpired && (
                          <Badge variant="destructive">EXPIRED</Badge>
                        )}
                        {payment.isExpiringSoon && !payment.isExpired && (
                          <Badge className="bg-amber-500 text-white dark:bg-amber-600">
                            EXPIRING SOON
                          </Badge>
                        )}
                      </div>

                      {/* Details Grid */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <p className="text-muted-foreground">Consultant</p>
                          <p className="font-medium text-foreground">
                            {payment.consultantName}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Consultee</p>
                          <p className="font-medium text-foreground">
                            {payment.consulteeName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {payment.consulteeEmail}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Amount</p>
                          <p className="font-medium text-foreground">
                            {formatCurrencyAmount(
                              payment.amount,
                              payment.currency,
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Status</p>
                          <p className="font-medium text-amber-700 dark:text-amber-400">
                            {payment.status}
                          </p>
                        </div>
                      </div>

                      {/* Time Information */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          <span>
                            Approved{" "}
                            {formatDistanceToNow(new Date(payment.approvedAt), {
                              addSuffix: true,
                            })}
                          </span>
                        </div>
                        {payment.isExpired ? (
                          <span className="text-red-600 dark:text-red-400 font-medium">
                            Expired{" "}
                            {formatDistanceToNow(new Date(payment.expiresAt), {
                              addSuffix: true,
                            })}
                          </span>
                        ) : (
                          <span
                            className={
                              payment.isExpiringSoon
                                ? "text-amber-600 dark:text-amber-400 font-medium"
                                : "text-muted-foreground"
                            }
                          >
                            Expires{" "}
                            {formatDistanceToNow(new Date(payment.expiresAt), {
                              addSuffix: true,
                            })}
                          </span>
                        )}
                      </div>

                      {/* Alert for Expired */}
                      {payment.isExpired && (
                        <Alert variant="destructive">
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription className="text-xs">
                            This payment link has expired. Manual intervention
                            required to either extend the deadline or revert the
                            request to pending status.
                          </AlertDescription>
                        </Alert>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2 sm:ml-4 sm:w-auto">
                      {payment.paymentUrl && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            window.open(payment.paymentUrl, "_blank")
                          }
                          className="gap-2"
                        >
                          View Payment Link
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          window.open(
                            `/dashboard/admin/${payment.type === "consultation" ? "consultations" : "subscriptions"}/${payment.id}`,
                            "_blank",
                          )
                        }
                      >
                        View Details
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                No pending approval payments
              </p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                All approved requests have been paid or are still in pending
                status
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
