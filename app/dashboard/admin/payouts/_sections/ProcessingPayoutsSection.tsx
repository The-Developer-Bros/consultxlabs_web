"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useQuery } from "@tanstack/react-query";
import { Loader } from "lucide-react";

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

async function fetchProcessingPayouts(): Promise<PayoutListResponse> {
  const response = await fetch(
    "/api/admin/payouts?status=PROCESSING&limit=100",
  );
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json() as Promise<PayoutListResponse>;
}

export default function ProcessingPayoutsSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payouts-processing"],
    queryFn: fetchProcessingPayouts,
    staleTime: 30 * 1000,
    // Focus, not a timer — and explicit, because the global default disables
    // focus AND mount refetching. Payout state is money-facing, so silently
    // freezing it at first load is the one outcome to avoid.
    refetchOnWindowFocus: true,
  });

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
        <span className="text-sm font-semibold text-foreground">
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
      key: "approved",
      header: "Approved",
      cell: (payout) => (
        <span className="text-sm text-muted-foreground">
          {payout.approvedAt
            ? new Date(payout.approvedAt).toLocaleString()
            : "-"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: () => (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted text-foreground">
          <Loader className="w-3 h-3 mr-1 animate-spin" />
          Processing
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
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Loader className="w-5 h-5 animate-spin text-muted-foreground" />
            Processing ({data?.payouts?.length || 0})
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
            <ResponsiveTable<Payout>
              columns={columns}
              rows={data.payouts}
              getRowId={(p) => p.id}
              empty={
                <div className="text-center py-12">
                  <p className="text-muted-foreground">
                    No payouts currently processing
                  </p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      <Card className="bg-muted border-border">
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground">
            <strong className="text-foreground">Note:</strong> Processing
            payouts are updated via webhooks from payment providers. The status
            will automatically change to Completed or Failed once the provider
            confirms the transfer.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
