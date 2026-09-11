"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { formatCurrencyAmount } from "@/utils/formatting";
import type {
  PaymentDetail,
  PaymentDetailRefund,
  PaymentDetailDispute,
} from "@/types/payments";

// Manual refunds ship with the live checkout/program wiring — the admin
// refund flow will rebuild on top of `WalletEntry` + `SettlementLedgerEntry`
// + `OrganizationEarnings.refundedAmountPaise`. Until then this page is
// read-only: operators can see refund history that the system wrote from
// automated paths (gateway-originated refunds, dispute resolutions).

/**
 * Dispute states with a verdict behind them. Everything else is a proceeding
 * still in motion, and the gateway can advance it at any moment without the
 * operator doing anything — which is what the poll below is for.
 */
const TERMINAL_DISPUTE_STATUSES = new Set([
  "WON",
  "LOST",
  "CHARGE_REFUNDED",
  "CLOSED",
  "WARNING_CLOSED",
]);

async function fetchPaymentDetails(paymentId: string): Promise<PaymentDetail> {
  const response = await fetch(`/api/admin/payments/${paymentId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch payment details");
  }
  return response.json() as Promise<PaymentDetail>;
}

export interface PaymentDetailPageProps {
  paymentId: string;
  /** Base URL for back-navigation and cross-links (e.g. "/dashboard/admin",
   *  "/dashboard/staff/abc"). Same convention as DisputeDetailPage. */
  basePath: string;
}

export function PaymentDetailPage({
  paymentId,
  basePath,
}: PaymentDetailPageProps) {
  const resolvedParams = { paymentId };

  const {
    data: payment,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["admin-payment", resolvedParams.paymentId],
    queryFn: () => fetchPaymentDetails(resolvedParams.paymentId),
    staleTime: 30 * 1000,
    // #1352 — a live dispute moves on the gateway's clock, not ours: the
    // webhook advances the row while the operator is sitting on this page
    // deciding whether to refund, and a 30-second stale window with no refetch
    // meant they could act on a status the platform had already superseded.
    // Poll only while a verdict is still outstanding; a resolved dispute never
    // changes again, so it goes back to costing nothing.
    refetchInterval: (query) =>
      query.state.data?.disputes?.some(
        (dispute) => !TERMINAL_DISPUTE_STATUSES.has(dispute.status),
      )
        ? 15 * 1000
        : false,
  });

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
                : "Failed to load payment details"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !payment) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`${basePath}/payments`}
            className="text-sm text-muted-foreground hover:text-foreground mb-2 inline-block"
          >
            ← Back to Payments
          </Link>
          <h1 className="text-fluid-3xl font-bold tracking-tight text-foreground">
            Payment Details
          </h1>
        </div>
      </div>

      {/* Payment Info */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Payment Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground">Payment Intent ID</Label>
              <p className="font-mono text-sm text-foreground break-all">
                {payment.paymentIntent}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Amount</Label>
              <p className="text-2xl font-bold text-foreground">
                {formatCurrencyAmount(payment.amount, payment.currency)}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Status</Label>
              <div className="mt-1">
                <span
                  className={`px-3 py-1 rounded text-sm font-medium ${
                    payment.paymentStatus === "SUCCEEDED"
                      ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
                      : payment.paymentStatus === "PENDING"
                        ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-400"
                        : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
                  }`}
                >
                  {payment.paymentStatus}
                </span>
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground">Payment Gateway</Label>
              <p className="font-medium text-foreground">
                {payment.paymentGateway}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Payment Type</Label>
              <p className="font-medium text-foreground">
                {payment.isMockPayment ? (
                  <span className="px-2 py-1 rounded text-sm font-medium bg-muted text-foreground">
                    MOCK PAYMENT
                  </span>
                ) : (
                  "Real Payment"
                )}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Created At</Label>
              <p className="text-foreground">
                {new Date(payment.createdAt).toLocaleString()}
              </p>
            </div>
            {payment.expiresAt && (
              <div>
                <Label className="text-muted-foreground">Expires At</Label>
                <p className="text-foreground">
                  {new Date(payment.expiresAt).toLocaleString()}
                </p>
              </div>
            )}
            {/* #1365 — the statutory B2C tax invoice. Absent for org-funded
                payments, which are invoiced to the organization instead. */}
            <div>
              <Label className="text-muted-foreground">Tax invoice</Label>
              {payment.consumerInvoice ? (
                <div className="mt-1 flex items-center gap-3">
                  <span className="font-mono text-sm text-foreground">
                    {payment.consumerInvoice.invoiceNumber}
                  </span>
                  <a
                    href={`/api/payments/${payment.id}/invoice/pdf`}
                    className="text-sm font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
                  >
                    Download
                  </a>
                </div>
              ) : (
                <p className="text-muted-foreground">Not issued</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Appointment Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {payment.appointment ? (
              <>
                <div>
                  <Label className="text-muted-foreground">
                    Appointment Type
                  </Label>
                  <p className="font-medium text-foreground">
                    {payment.appointment.appointmentType}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">
                    Appointment ID
                  </Label>
                  <p className="font-mono text-sm text-foreground break-all">
                    {payment.appointment.id}
                  </p>
                </div>
                <div>
                  <Label className="text-muted-foreground">User</Label>
                  <p className="text-foreground">
                    {payment.user?.name || "N/A"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {payment.user?.email}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                No appointment associated yet
              </p>
            )}

            {payment.discountCode && (
              <div>
                <Label className="text-muted-foreground">Discount Code</Label>
                <p className="font-medium text-foreground">
                  {payment.discountCode.code}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Refunds List */}
      {payment.refunds && payment.refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Refunds</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {payment.refunds.map((refund: PaymentDetailRefund) => (
                <div
                  key={refund.id}
                  className="p-4 border border-border rounded-lg flex justify-between items-start gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {formatCurrencyAmount(
                        refund.amountPaise,
                        refund.currency,
                      )}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {refund.reason}
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                      {new Date(refund.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 px-2 py-1 rounded text-xs font-medium ${
                      refund.status === "SUCCEEDED"
                        ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
                        : refund.status === "PENDING"
                          ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-400"
                          : "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
                    }`}
                  >
                    {refund.status}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Disputes List */}
      {payment.disputes && payment.disputes.length > 0 && (
        <Card className="border-red-200 dark:border-red-900/60">
          <CardHeader>
            <CardTitle className="text-red-600 dark:text-red-400">
              Disputes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {payment.disputes.map((dispute: PaymentDetailDispute) => (
                <Link
                  key={dispute.id}
                  href={`${basePath}/disputes/${dispute.id}`}
                  className="block p-4 border border-border rounded-lg hover:bg-muted transition-colors"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {formatCurrencyAmount(
                          dispute.amountPaise,
                          dispute.currency,
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {dispute.reason}
                      </p>
                      <p className="text-xs text-muted-foreground/70 mt-1">
                        {new Date(dispute.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 px-2 py-1 rounded text-xs font-medium ${
                        dispute.status === "WON"
                          ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-400"
                          : dispute.status === "LOST"
                            ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-400"
                            : "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-400"
                      }`}
                    >
                      {dispute.status}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
