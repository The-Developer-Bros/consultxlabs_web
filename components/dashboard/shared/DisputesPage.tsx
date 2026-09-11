"use client";

import { useState, useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
// Paise-aware and per-currency: the local helper this replaces divided by 100
// and rounded to whole rupees, so 12,345 paise printed as ₹123 rather than
// ₹123.45, and any currency with different minor-unit rules was wrong too.
import { formatCurrencyAmount } from "@/utils/formatting";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Search,
  AlertTriangle,
  RefreshCw,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle,
  XCircle,
  Eye,
} from "lucide-react";
import type { Dispute, DisputeListResponse } from "@/types/disputes";

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "LOST":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "UNDER_REVIEW":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "WON":
      return <CheckCircle className="h-3 w-3" />;
    case "LOST":
      return <XCircle className="h-3 w-3" />;
    case "NEEDS_RESPONSE":
    case "WARNING_NEEDS_RESPONSE":
      return <AlertTriangle className="h-3 w-3" />;
    case "UNDER_REVIEW":
      return <Clock className="h-3 w-3" />;
    default:
      return null;
  }
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getDaysUntilDue = (dueBy: string | null) => {
  if (!dueBy) return null;
  const now = new Date();
  const due = new Date(dueBy);
  const diffDays = Math.ceil(
    (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );
  return diffDays;
};

export interface DisputesPageProps {
  /** Base URL for navigation links to the dispute detail page (e.g. "/dashboard/admin", "/dashboard/staff/abc") */
  basePath: string;
  /** API endpoint for fetching disputes */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
}

export function DisputesPage({
  basePath,
  apiEndpoint = "/api/admin/disputes",
  title = "Disputes",
  description = "View and track payment disputes",
}: DisputesPageProps) {
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [gatewayFilter, setGatewayFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: [
      "admin-disputes",
      apiEndpoint,
      page,
      debouncedSearch,
      statusFilter,
      gatewayFilter,
    ],
    queryFn: async (): Promise<DisputeListResponse> => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "20");
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (gatewayFilter !== "all") params.set("gateway", gatewayFilter);

      const response = await fetch(`${apiEndpoint}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch disputes");
      return response.json();
    },
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });

  const disputes = data?.disputes ?? [];
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;
  const urgentCount = data?.urgentDisputes ?? 0;
  // #997 secondary findings — server-computed, dashboard-wide (not the
  // current page's rows via .filter()).
  const underReviewCount = data?.stats?.underReviewCount ?? 0;
  const wonCount = data?.stats?.wonCount ?? 0;

  const handleViewDispute = (disputeId: string) => {
    router.push(`${basePath}/disputes/${disputeId}`);
  };

  const renderRowActions = (dispute: Dispute) => (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={(e) => {
        e.stopPropagation();
        handleViewDispute(dispute.id);
      }}
    >
      <Eye className="h-4 w-4" />
    </Button>
  );

  const columns: ResponsiveColumn<Dispute>[] = [
    {
      key: "disputeId",
      header: "Dispute ID",
      primary: true,
      cell: (dispute) => (
        <div>
          <p className="font-mono text-sm">
            {dispute.disputeId?.slice(-12) || dispute.id.slice(-8).toUpperCase()}
          </p>
          {dispute.payment && (
            <p className="text-xs text-muted-foreground/70">
              Payment: {dispute.payment.paymentIntent.slice(-12)}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "font-medium",
      cell: (dispute) => formatCurrencyAmount(dispute.amountPaise, dispute.currency),
    },
    {
      key: "gateway",
      header: "Gateway",
      className: "text-sm text-muted-foreground",
      cell: (dispute) => dispute.paymentGateway,
    },
    {
      key: "status",
      header: "Status",
      cell: (dispute) => (
        <Badge
          className={`${getStatusColor(dispute.status)} gap-1`}
          variant="secondary"
        >
          {getStatusIcon(dispute.status)}
          {dispute.status.toLowerCase().replace(/_/g, " ")}
        </Badge>
      ),
    },
    {
      key: "dueBy",
      header: "Due By",
      cell: (dispute) => {
        const daysUntilDue = getDaysUntilDue(dispute.dueBy);
        const isUrgent =
          daysUntilDue !== null && daysUntilDue <= 3 && daysUntilDue >= 0;
        return dispute.dueBy ? (
          <div
            className={
              isUrgent ? "text-red-600 font-medium" : "text-muted-foreground"
            }
          >
            {formatDate(dispute.dueBy)}
            {daysUntilDue !== null && daysUntilDue >= 0 && (
              <p className="text-xs">
                {daysUntilDue === 0 ? "Due today!" : `${daysUntilDue} days left`}
              </p>
            )}
          </div>
        ) : (
          "-"
        );
      },
    },
    {
      key: "created",
      header: "Created",
      className: "text-sm text-muted-foreground",
      cell: (dispute) => formatDate(dispute.createdAt),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title={title}
        subtitle={description}
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

      {/* Urgent Disputes Alert */}
      {urgentCount > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Urgent Attention Required</AlertTitle>
          <AlertDescription>
            {urgentCount} dispute{urgentCount > 1 ? "s" : ""} require
            {urgentCount === 1 ? "s" : ""} response within 3 days. Please
            escalate to admin for evidence submission.
          </AlertDescription>
        </Alert>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <AlertTriangle className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{total}</p>
              <p className="text-sm text-muted-foreground">Total Disputes</p>
            </div>
          </CardContent>
        </Card>
        <Card
          className={
            urgentCount > 0 ? "border-red-200 bg-red-50 dark:bg-red-950/20" : ""
          }
        >
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900">
              <AlertCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-red-600">{urgentCount}</p>
              <p className="text-sm text-muted-foreground">
                Urgent (Due in 3 days)
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <Clock className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{underReviewCount}</p>
              <p className="text-sm text-muted-foreground">Under Review</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{wonCount}</p>
              <p className="text-sm text-muted-foreground">Won</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
              <Input
                placeholder="Search by dispute ID..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="NEEDS_RESPONSE">Needs Response</SelectItem>
                <SelectItem value="WARNING_NEEDS_RESPONSE">
                  Warning - Needs Response
                </SelectItem>
                <SelectItem value="UNDER_REVIEW">Under Review</SelectItem>
                <SelectItem value="WON">Won</SelectItem>
                <SelectItem value="LOST">Lost</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={gatewayFilter}
              onValueChange={(v) => {
                setGatewayFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Gateway" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Gateways</SelectItem>
                <SelectItem value="STRIPE">Stripe</SelectItem>
                <SelectItem value="RAZORPAY">Razorpay</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Disputes Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-600" />
            Disputes ({total})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {isError && !data ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load disputes.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : isPending ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          ) : (
            <ResponsiveTable<Dispute>
              columns={columns}
              rows={disputes}
              getRowId={(d) => d.id}
              onRowClick={(d) => handleViewDispute(d.id)}
              rowActions={renderRowActions}
              empty={
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <AlertTriangle className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No disputes found</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
