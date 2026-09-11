"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { CheckCircle, Download } from "lucide-react";

import type { Payout } from "@/types/payouts";

interface PayoutListResponse {
  payouts: Payout[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

async function fetchCompletedPayouts(
  page: number,
  limit: number,
  search: string,
): Promise<PayoutListResponse> {
  const offset = (page - 1) * limit;
  const params = new URLSearchParams({
    status: "COMPLETED",
    limit: limit.toString(),
    offset: offset.toString(),
  });
  if (search) {
    params.set("search", search);
  }
  const response = await fetch(`/api/admin/payouts?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json() as Promise<PayoutListResponse>;
}

export default function CompletedPayoutsSection() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const limit = 20;

  // Debounced search for API calls
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset to page 1 when search changes
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payouts-completed", page, debouncedSearch],
    queryFn: () => fetchCompletedPayouts(page, limit, debouncedSearch),
    staleTime: 60 * 1000,
  });

  // Payouts are now filtered server-side
  const filteredPayouts = data?.payouts;

  const exportToCSV = () => {
    if (!data?.payouts?.length) return;

    const headers = [
      "ID",
      "Consultant",
      "Email",
      "Amount",
      "Currency",
      "Method",
      "Provider",
      "Processed At",
    ];
    const rows = data.payouts.map((p: Payout) => [
      p.id,
      p.consultantName,
      p.consultantEmail,
      (p.amount / 100).toFixed(2),
      p.currency,
      p.method,
      p.provider,
      p.processedAt ? new Date(p.processedAt).toISOString() : "",
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r: string[]) => r.join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payouts-completed-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: ResponsiveColumn<Payout>[] = [
    {
      key: "consultant",
      header: "Consultant",
      primary: true,
      cell: (payout) => (
        <div>
          <p className="text-sm font-medium text-foreground">
            {payout.consultantName}
          </p>
          <p className="text-xs text-muted-foreground">
            {payout.consultantEmail}
          </p>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      cell: (payout) => (
        <span className="text-sm font-semibold text-green-700 dark:text-green-400">
          {(payout.amount / 100).toLocaleString("en-IN", {
            style: "currency",
            currency: payout.currency,
          })}
        </span>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      cell: (payout) => (
        <span className="text-sm text-muted-foreground">{payout.provider}</span>
      ),
    },
    {
      key: "method",
      header: "Method",
      cell: (payout) => (
        <span className="text-sm text-muted-foreground">{payout.method}</span>
      ),
    },
    {
      key: "earnings",
      header: "Earnings",
      cell: (payout) => (
        <span className="text-sm text-muted-foreground">
          {payout.earningsCount} earnings
        </span>
      ),
    },
    {
      key: "processed",
      header: "Processed",
      cell: (payout) => (
        <span className="text-sm text-muted-foreground">
          {payout.processedAt
            ? new Date(payout.processedAt).toLocaleString()
            : "-"}
        </span>
      ),
    },
  ];

  if (error) {
    return (
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-red-600 dark:text-red-400">
            Error
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            {error instanceof Error
              ? error.message
              : "Failed to load payouts"}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button variant="outline" onClick={exportToCSV}>
          <Download className="w-4 h-4 mr-2" />
          Export CSV
        </Button>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-4">
          <Input
            placeholder="Search by consultant name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 max-w-md"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
            Completed ({data?.pagination?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || !data ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <>
              <ResponsiveTable<Payout>
                columns={columns}
                rows={filteredPayouts ?? []}
                getRowId={(p) => p.id}
                empty={
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">
                      {search
                        ? "No payouts match your search"
                        : "No completed payouts"}
                    </p>
                  </div>
                }
              />

              {/* Pagination */}
              {data?.pagination &&
                filteredPayouts &&
                filteredPayouts.length > 0 && (
                  <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm text-muted-foreground">
                      Showing {(page - 1) * limit + 1} to{" "}
                      {Math.min(page * limit, data.pagination.total)} of{" "}
                      {data.pagination.total} payouts
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
                        disabled={!data.pagination.hasMore}
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
