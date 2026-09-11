"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X, Loader2 } from "lucide-react";

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

async function fetchPendingPayouts(): Promise<PayoutListResponse> {
  const response = await fetch("/api/admin/payouts?status=PENDING&limit=100");
  if (!response.ok) {
    throw new Error("Failed to fetch payouts");
  }
  return response.json() as Promise<PayoutListResponse>;
}

type PayoutActionResult = { success: boolean; message: string };

/**
 * The route answers with `{ success, message }`, not a Payout. These were typed
 * `Promise<Payout>` and cast to match, which no caller noticed only because
 * both mutations discard the value — the first `onSuccess: (data) => ...` to
 * read `data.amount` would have got undefined from a type promising a number.
 */
async function approvePayout(id: string): Promise<PayoutActionResult> {
  const response = await fetch(`/api/admin/payouts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "approve" }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to approve payout");
  }
  return response.json() as Promise<PayoutActionResult>;
}

async function rejectPayout(
  id: string,
  reason: string,
): Promise<PayoutActionResult> {
  const response = await fetch(`/api/admin/payouts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reject", reason }),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to reject payout");
  }
  return response.json() as Promise<PayoutActionResult>;
}

export default function PendingPayoutsSection() {
  const queryClient = useQueryClient();
  const [selectedPayout, setSelectedPayout] = useState<Payout | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [dialogType, setDialogType] = useState<"approve" | "reject" | null>(
    null,
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-payouts-pending"],
    queryFn: fetchPendingPayouts,
    staleTime: 30 * 1000,
  });

  const approveMutation = useMutation({
    mutationFn: approvePayout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-pending"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payout-stats"] });
      setDialogType(null);
      setSelectedPayout(null);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectPayout(id, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-payouts-pending"] });
      queryClient.invalidateQueries({ queryKey: ["admin-payout-stats"] });
      setDialogType(null);
      setSelectedPayout(null);
      setRejectReason("");
    },
  });

  const handleApprove = (payout: Payout) => {
    setSelectedPayout(payout);
    setDialogType("approve");
  };

  const handleReject = (payout: Payout) => {
    setSelectedPayout(payout);
    setDialogType("reject");
  };

  const confirmApprove = () => {
    if (selectedPayout) {
      approveMutation.mutate(selectedPayout.id);
    }
  };

  const confirmReject = () => {
    if (selectedPayout && rejectReason.trim()) {
      rejectMutation.mutate({ id: selectedPayout.id, reason: rejectReason });
    }
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
        <span className="text-sm font-semibold text-foreground">
          {(payout.amount / 100).toLocaleString("en-IN", {
            style: "currency",
            currency: payout.currency,
          })}
        </span>
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
      key: "dueBy",
      header: "Due by (MSME)",
      cell: (payout) => {
        if (!payout.mustPayByDate) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }
        const due = new Date(payout.mustPayByDate);
        const daysLeft = Math.ceil(
          (due.getTime() - Date.now()) / 86_400_000,
        );
        // <5 days (or overdue) is the §43B(h) alert window — flag it red.
        const urgent = daysLeft < 5;
        return (
          <span
            className={
              urgent
                ? "text-sm font-semibold text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {due.toLocaleDateString()}
            {urgent && (
              <span className="ml-1">
                ({daysLeft < 0 ? "overdue" : `${daysLeft}d`})
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: "date",
      header: "Date",
      cell: (payout) => (
        <span className="text-sm text-muted-foreground">
          {new Date(payout.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  const renderRowActions = (payout: Payout) => (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        className="text-green-600 border-green-600 hover:bg-green-50 dark:text-green-400 dark:border-green-400 dark:hover:bg-green-950/40"
        onClick={() => handleApprove(payout)}
      >
        <Check className="w-4 h-4 mr-1" />
        Approve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-red-600 border-red-600 hover:bg-red-50 dark:text-red-400 dark:border-red-400 dark:hover:bg-red-950/40"
        onClick={() => handleReject(payout)}
      >
        <X className="w-4 h-4 mr-1" />
        Reject
      </Button>
    </div>
  );

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
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Pending Payouts ({data?.payouts?.length || 0})
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
              rowActions={renderRowActions}
              empty={
                <div className="text-center py-12">
                  <p className="text-muted-foreground">No pending payouts</p>
                </div>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Approve Dialog */}
      <AlertDialog
        open={dialogType === "approve"}
        onOpenChange={() => setDialogType(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve Payout</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to approve this payout of{" "}
              {selectedPayout &&
                (selectedPayout.amount / 100).toLocaleString("en-IN", {
                  style: "currency",
                  currency: selectedPayout.currency,
                })}{" "}
              to {selectedPayout?.consultantName}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmApprove}
              disabled={approveMutation.isPending}
              className="bg-green-600 hover:bg-green-700 dark:bg-green-600 dark:hover:bg-green-700"
            >
              {approveMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog
        open={dialogType === "reject"}
        onOpenChange={() => setDialogType(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Payout</AlertDialogTitle>
            <AlertDialogDescription>
              Please provide a reason for rejecting this payout to{" "}
              {selectedPayout?.consultantName}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Input
              placeholder="Reason for rejection..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmReject}
              disabled={rejectMutation.isPending || !rejectReason.trim()}
              className="bg-red-600 hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
            >
              {rejectMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
