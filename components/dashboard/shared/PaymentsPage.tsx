"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import {
  PaymentGateway,
  PaymentStatus,
  AppointmentsType,
} from "@prisma/client";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { PaymentListResponse, Payment } from "@/types/payments";

// Fetch payments with filters
async function fetchPayments(params: {
  page: number;
  limit: number;
  status?: PaymentStatus;
  gateway?: PaymentGateway;
  appointmentType?: AppointmentsType;
  search?: string;
}): Promise<PaymentListResponse> {
  const searchParams = new URLSearchParams({
    page: params.page.toString(),
    limit: params.limit.toString(),
    ...(params.status && { status: params.status }),
    ...(params.gateway && { gateway: params.gateway }),
    ...(params.appointmentType && { appointmentType: params.appointmentType }),
    ...(params.search && { search: params.search }),
  });

  const response = await fetch(`/api/admin/payments?${searchParams}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payments");
  }
  return response.json() as Promise<PaymentListResponse>;
}

export interface PaymentsPageProps {
  /** Base URL for links to the payment detail route (e.g. "/dashboard/admin",
   *  "/dashboard/staff/abc"). Matches the convention on RefundsPage /
   *  DisputesPage — without it a staff-tree row would link into the admin
   *  tree, which staff cannot enter. */
  basePath: string;
}

/**
 * #1365 — the B2C tax invoice for a payment. Defined at module scope, not
 * inside the page, so it is never re-created on a render (S6478). An empty
 * cell means the payment was org-funded and is invoiced to the organization
 * instead, which is the correct answer rather than a gap to chase.
 */
function renderInvoiceCell(payment: Payment) {
  if (!payment.consumerInvoice) {
    return <span className="text-muted-foreground/70">—</span>;
  }
  return (
    <a
      href={`/api/payments/${payment.id}/invoice/pdf`}
      className="text-sm font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
    >
      {payment.consumerInvoice.invoiceNumber}
    </a>
  );
}

export function PaymentsPage({ basePath }: PaymentsPageProps) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<PaymentStatus | undefined>();
  const [gateway, setGateway] = useState<PaymentGateway | undefined>();
  const [appointmentType, setAppointmentType] = useState<
    AppointmentsType | undefined
  >();
  const [search, setSearch] = useState("");
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "operator-payments",
      page,
      status,
      gateway,
      appointmentType,
      search,
    ],
    queryFn: () =>
      fetchPayments({ page, limit, status, gateway, appointmentType, search }),
    staleTime: 30 * 1000, // 30 seconds
  });

  const handleFilterChange = () => {
    setPage(1); // Reset to first page when filters change
  };

  const columns: ResponsiveColumn<Payment>[] = [
    {
      key: "paymentId",
      header: "Payment ID",
      primary: true,
      cell: (payment) => (
        <span className="font-mono text-sm text-foreground">
          {payment.paymentIntent?.substring(0, 20)}...
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      cell: (payment) => (
        <span className="text-sm text-foreground">
          {formatCurrencyAmount(payment.amount, payment.currency)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (payment) => (
        <span
          className={`px-2 py-1 rounded text-xs font-medium ${
            payment.paymentStatus === "SUCCEEDED"
              ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
              : payment.paymentStatus === "PENDING"
                ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-400"
                : payment.paymentStatus === "EXPIRED"
                  ? "bg-muted text-muted-foreground"
                  : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
          }`}
        >
          {payment.paymentStatus}
        </span>
      ),
    },
    {
      key: "gateway",
      header: "Gateway",
      cell: (payment) => (
        <span className="text-sm text-foreground">
          {payment.paymentGateway}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (payment) => (
        <span className="text-sm text-foreground">
          {payment.appointment?.appointmentType || "N/A"}
        </span>
      ),
    },
    {
      key: "mock",
      header: "Mock",
      cell: (payment) =>
        payment.isMockPayment ? (
          <span className="px-2 py-1 rounded text-xs font-medium bg-muted text-foreground">
            MOCK
          </span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        ),
    },
    {
      key: "invoice",
      header: "Invoice",
      cell: renderInvoiceCell,
    },
    {
      key: "date",
      header: "Date",
      cell: (payment) => (
        <span className="text-sm text-muted-foreground">
          {new Date(payment.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  const renderRowActions = (payment: Payment) => (
    <Link
      href={`${basePath}/payments/${payment.id}`}
      className="font-medium text-foreground hover:text-muted-foreground"
    >
      View
    </Link>
  );

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
                : "Failed to load payments"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Payments"
        subtitle="Manage and view all platform payments"
      />

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <Input
              placeholder="Search payment ID..."
              className="min-w-0"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                handleFilterChange();
              }}
            />

            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(
                  value === "all" ? undefined : (value as PaymentStatus),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                <SelectItem value="FAILED">Failed</SelectItem>
                <SelectItem value="EXPIRED">Expired</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={gateway}
              onValueChange={(value) => {
                setGateway(
                  value === "all" ? undefined : (value as PaymentGateway),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Gateway" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Gateways</SelectItem>
                <SelectItem value="STRIPE">Stripe</SelectItem>
                <SelectItem value="RAZORPAY">Razorpay</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={appointmentType}
              onValueChange={(value) => {
                setAppointmentType(
                  value === "all" ? undefined : (value as AppointmentsType),
                );
                handleFilterChange();
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="CONSULTATION">Consultation</SelectItem>
                <SelectItem value="SUBSCRIPTION">Subscription</SelectItem>
                <SelectItem value="WEBINAR">Webinar</SelectItem>
                <SelectItem value="CLASS">Class</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              onClick={() => {
                setStatus(undefined);
                setGateway(undefined);
                setAppointmentType(undefined);
                setSearch("");
                setPage(1);
              }}
            >
              Clear Filters
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Payments Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Payments ({data?.total || 0})
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
            <div className="space-y-2">
              <ResponsiveTable<Payment>
                columns={columns}
                rows={data.payments}
                getRowId={(p) => p.id}
                rowActions={renderRowActions}
                empty={
                  <div className="text-center py-12">
                    <p className="text-muted-foreground">No payments found</p>
                  </div>
                }
              />

              {/* Pagination */}
              {data.payments.length > 0 && (
                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-muted-foreground">
                    Showing {(page - 1) * limit + 1} to{" "}
                    {Math.min(page * limit, data.total)} of {data.total} payments
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
                      disabled={page * limit >= data.total}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
