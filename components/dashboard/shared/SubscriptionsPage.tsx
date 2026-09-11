"use client";

import { useState, useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
  RefreshCw,
  Loader2,
  CheckCircle,
  Clock,
  XCircle,
  AlertTriangle,
  Users,
} from "lucide-react";
import type {
  SubscriptionListItem,
  SubscriptionListResponse,
} from "@/types/subscriptions";

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "expiring_soon":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "expired":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case "active":
      return <CheckCircle className="h-3 w-3" />;
    case "expiring_soon":
      return <AlertTriangle className="h-3 w-3" />;
    case "expired":
      return <XCircle className="h-3 w-3" />;
    default:
      return <Clock className="h-3 w-3" />;
  }
};

const formatCurrency = (amount: number, currency: string = "INR") => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency,
    maximumFractionDigits: 0,
  }).format(amount / 100);
};

const formatDate = (dateString: string | null) => {
  if (!dateString) return "-";
  return new Date(dateString).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const EMPTY_STATS = { activeCount: 0, expiringCount: 0, expiredCount: 0 };
const LIMIT = 20;

export interface SubscriptionsPageProps {
  /** API endpoint for fetching subscriptions */
  apiEndpoint?: string;
  /** Page title */
  title?: string;
  /** Page description */
  description?: string;
}

export function SubscriptionsPage({
  apiEndpoint = "/api/admin/subscriptions",
  title = "Subscriptions",
  description = "View platform subscriptions (read-only)",
}: SubscriptionsPageProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
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
      "admin-subscriptions",
      apiEndpoint,
      page,
      debouncedSearch,
      statusFilter,
    ],
    queryFn: async (): Promise<SubscriptionListResponse> => {
      const params = new URLSearchParams();
      params.set("limit", LIMIT.toString());
      params.set("offset", ((page - 1) * LIMIT).toString());
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter !== "all") params.set("status", statusFilter);

      const response = await fetch(`${apiEndpoint}?${params}`);
      if (!response.ok) throw new Error("Failed to fetch subscriptions");
      return response.json();
    },
    // Keep the previous page visible while the next one loads instead of
    // flashing a spinner over the whole table on every page/filter change.
    placeholderData: keepPreviousData,
  });

  const subscriptions = data?.subscriptions ?? [];
  const stats = data?.stats ?? EMPTY_STATS;
  const total = data?.pagination.total ?? 0;
  const hasMore = data?.pagination.hasMore ?? false;
  const totalPages = Math.ceil(total / LIMIT);

  const columns: ResponsiveColumn<SubscriptionListItem>[] = [
    {
      key: "user",
      header: "User",
      primary: true,
      cell: (subscription) => (
        <div>
          <p className="font-medium">{subscription.userName}</p>
          <p className="text-xs text-muted-foreground/70">
            {subscription.userEmail}
          </p>
        </div>
      ),
    },
    {
      key: "consultant",
      header: "Consultant",
      className: "text-sm text-muted-foreground",
      cell: (subscription) => subscription.consultantName || "-",
    },
    {
      key: "amount",
      header: "Amount",
      className: "font-medium",
      cell: (subscription) =>
        formatCurrency(subscription.amount, subscription.currency),
    },
    {
      key: "period",
      header: "Period",
      cell: (subscription) => (
        <div className="text-sm">
          <p>{formatDate(subscription.startDate)}</p>
          <p className="text-muted-foreground/70">
            to {formatDate(subscription.endDate)}
          </p>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (subscription) => (
        <Badge
          className={`${getStatusColor(subscription.status)} gap-1`}
          variant="secondary"
        >
          {getStatusIcon(subscription.status)}
          {subscription.status.replace(/_/g, " ")}
        </Badge>
      ),
    },
    {
      key: "gateway",
      header: "Gateway",
      className: "text-sm text-muted-foreground",
      cell: (subscription) => subscription.gateway,
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

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.activeCount}</p>
              <p className="text-sm text-muted-foreground">Active</p>
            </div>
          </CardContent>
        </Card>
        <Card
          className={
            stats.expiringCount > 0
              ? "border-yellow-200 bg-yellow-50 dark:bg-yellow-950/20"
              : ""
          }
        >
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-yellow-100 dark:bg-yellow-900">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-yellow-600">
                {stats.expiringCount}
              </p>
              <p className="text-sm text-muted-foreground">Expiring Soon</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <XCircle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{stats.expiredCount}</p>
              <p className="text-sm text-muted-foreground">Expired</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Users className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{total}</p>
              <p className="text-sm text-muted-foreground">
                Total Subscriptions
              </p>
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
                placeholder="Search by user name or email..."
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
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="expiring_soon">Expiring Soon</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Subscriptions Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-foreground" />
            Subscriptions ({total})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {isError && !data ? (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load subscriptions.</span>
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
            <ResponsiveTable<SubscriptionListItem>
              columns={columns}
              rows={subscriptions}
              getRowId={(s) => s.id}
              empty={
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <RefreshCw className="h-12 w-12 mb-4 text-muted-foreground/40" />
                  <p>No subscriptions found</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Showing {(page - 1) * LIMIT + 1} to {Math.min(page * LIMIT, total)}{" "}
            of {total}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!hasMore}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
