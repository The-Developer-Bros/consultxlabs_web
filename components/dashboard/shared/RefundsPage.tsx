"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
// `formatCurrencyAmount`, not the old major-unit formatter (deleted in #1396):
// refunds carry paise. The old call had both halves wrong — a field the payload
// has never contained, passed to the rupees formatter — so it rendered ₹NaN
// rather than a number that was merely 100× too large.
import { formatCurrencyAmount } from "@/utils/formatting";
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
import {
  Search,
  RotateCcw,
  RefreshCw,
  Loader2,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  Ban,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Refund, RefundListResponse } from "@/types/payments";

const getStatusColor = (status: string) => {
  switch (status.toUpperCase()) {
    case "SUCCEEDED":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "PENDING":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "FAILED":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "CANCELLED":
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toUpperCase()) {
    case "SUCCEEDED":
      return <CheckCircle className="h-3 w-3" />;
    case "PENDING":
      return <Clock className="h-3 w-3" />;
    case "FAILED":
      return <XCircle className="h-3 w-3" />;
    case "CANCELLED":
      return <Ban className="h-3 w-3" />;
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

export interface RefundsPageProps {
  /** Base URL for navigation links (e.g. "/dashboard/admin", "/dashboard/staff/123") */
  basePath: string;
  /** API endpoint to fetch refunds from */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
  /** React Query key prefix */
  queryKeyPrefix?: string;
}

export function RefundsPage({
  basePath,
  apiEndpoint = "/api/admin/refunds",
  title = "Refunds",
  description = "View and track refund requests",
  queryKeyPrefix = "refunds",
}: RefundsPageProps) {
  const { toast } = useToast();
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

  const {
    data: refundsData,
    isLoading: loading,
    refetch: refetchRefunds,
    error: refundsError,
  } = useQuery<RefundListResponse>({
    queryKey: [
      queryKeyPrefix,
      page,
      debouncedSearch,
      statusFilter,
      gatewayFilter,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      params.set("limit", "20");
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (gatewayFilter !== "all") params.set("gateway", gatewayFilter);
      const response = await fetch(`${apiEndpoint}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch refunds");
      return response.json() as Promise<RefundListResponse>;
    },
  });

  // Show toast on error (React Query v5 removed onError callback)
  useEffect(() => {
    if (refundsError) {
      console.error("Error fetching refunds:", refundsError);
      toast({
        title: "Error",
        description: "Failed to load refunds",
        variant: "destructive",
      });
    }
  }, [refundsError, toast]);

  const refunds: Refund[] = refundsData?.refunds ?? [];
  const totalPages = refundsData?.totalPages ?? 1;
  const total = refundsData?.total ?? 0;

  // #997 secondary findings — server-computed, dashboard-wide (previously
  // `.filter()` over the current page's ≤20 rows, which undercounted).
  const stats = {
    total,
    pending: refundsData?.stats?.pendingCount ?? 0,
    succeeded: refundsData?.stats?.succeededCount ?? 0,
    failed: refundsData?.stats?.failedCount ?? 0,
  };

  const renderRowActions = (refund: Refund) =>
    refund.payment ? (
      <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
        <a
          href={`${basePath}/payments/${refund.payment.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    ) : null;

  const columns: ResponsiveColumn<Refund>[] = [
    {
      key: "refundId",
      header: "Refund ID",
      primary: true,
      cell: (refund) => (
        <div>
          <p className="font-mono text-sm">
            {refund.refundId?.slice(-12) || refund.id.slice(-8).toUpperCase()}
          </p>
          {refund.payment && (
            <p className="text-xs text-muted-foreground/70">
              Payment: {refund.payment.paymentIntent.slice(-12)}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      className: "font-medium",
      cell: (refund) =>
        formatCurrencyAmount(refund.amountPaise, refund.currency),
    },
    {
      key: "gateway",
      header: "Gateway",
      className: "text-sm text-muted-foreground",
      cell: (refund) => refund.paymentGateway,
    },
    {
      key: "status",
      header: "Status",
      cell: (refund) => (
        <Badge
          className={`${getStatusColor(refund.status)} gap-1`}
          variant="secondary"
        >
          {getStatusIcon(refund.status)}
          {refund.status.toLowerCase()}
        </Badge>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      className: "text-sm text-muted-foreground max-w-[200px] truncate",
      cell: (refund) => refund.reason || "-",
    },
    {
      key: "date",
      header: "Date",
      className: "text-sm text-muted-foreground",
      cell: (refund) => formatDate(refund.createdAt),
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
            onClick={() => refetchRefunds()}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <RotateCcw className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-sm text-muted-foreground">Total Refunds</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-50 dark:bg-yellow-950">
              <Clock className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.pending}</p>
              <p className="text-sm text-muted-foreground">Pending</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.succeeded}</p>
              <p className="text-sm text-muted-foreground">Succeeded</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.failed}</p>
              <p className="text-sm text-muted-foreground">Failed</p>
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
                placeholder="Search by refund ID..."
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
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
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

      {/* Refunds Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-foreground" />
            Refunds ({total})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/70" />
            </div>
          ) : (
            <ResponsiveTable<Refund>
              columns={columns}
              rows={refunds}
              getRowId={(r) => r.id}
              rowActions={renderRowActions}
              empty={
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <RotateCcw className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No refunds found</p>
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
