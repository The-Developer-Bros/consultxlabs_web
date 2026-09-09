"use client";

import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { useCurrency } from "@/hooks/useCurrency";
import { cn } from "@/utils/tailwind";
import { CreditCard, Gift, Tag, ArrowUpDown, Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import {
  paymentStatusBadge,
  refundStatusBadge,
  resolveSponsoringOrgName,
} from "@/lib/labels/session-labels";

interface RefundItem {
  id: string;
  amountPaise: number;
  status: string;
  reason: string | null;
  createdAt: string;
}

interface PaymentItem {
  id: string;
  amount: number;
  originalAmount: number | null;
  taxAmount: number | null;
  currency: string;
  status: string;
  paymentMethod: string | null;
  paymentGateway: string;
  appointmentType: string | null;
  planTitle: string;
  organizationId: string | null;
  discount: {
    code: string;
    type: string;
    value: number;
  } | null;
  refunds: RefundItem[];
  refundedPaise: number;
  /** Server-derived: REFUNDED | PARTIALLY_REFUNDED | PaymentStatus. */
  displayStatus: string;
  /** #1365 — the statutory tax invoice, when one was issued for this payment. */
  consumerInvoice: {
    id: string;
    invoiceNumber: string;
    issuedAt: string;
  } | null;
  receiptUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface CreditItem {
  id: string;
  amount: number;
  source: string;
  usedAmount: number;
  remainingAmount: number;
  expiresAt: string | null;
  createdAt: string;
}

interface CreditUsageItem {
  id: string;
  amount: number;
  usedAt: string;
  credit: { source: string };
  payment: {
    id: string;
    amount: number;
    currency: string;
    createdAt: string;
  } | null;
}

interface PaymentsData {
  payments: PaymentItem[];
  credits: CreditItem[];
  creditUsages: CreditUsageItem[];
  creditSummary: {
    total: number;
    used: number;
    remaining: number;
  };
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const GATEWAY_LABELS: Record<string, string> = {
  STRIPE: "Stripe",
  RAZORPAY: "Razorpay",
};

function formatGateway(gateway: string): string {
  return GATEWAY_LABELS[gateway] || gateway;
}

function formatDateTime(date: string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const isPast = diffMs < 0;

  const minutes = Math.floor(absDiffMs / (1000 * 60));
  const hours = Math.floor(absDiffMs / (1000 * 60 * 60));
  const days = Math.floor(absDiffMs / (1000 * 60 * 60 * 24));

  let relative: string;
  if (minutes < 1) relative = "just now";
  else if (minutes < 60) relative = `${minutes}m`;
  else if (hours < 24) relative = `${hours}h ${minutes % 60}m`;
  else relative = `${days}d ago`;

  if (minutes < 1) return relative;
  return isPast ? `${relative} ago` : `in ${relative}`;
}

/**
 * Derive UI display status: start from the server's refund-aware
 * `displayStatus` (REFUNDED / PARTIALLY_REFUNDED / PaymentStatus); if
 * PENDING but expiresAt is past, show EXPIRED so the user doesn't see a
 * misleading amber "PENDING" badge while the cleanup cron hasn't run yet.
 */
function getDisplayStatus(payment: PaymentItem): string {
  const base = payment.displayStatus ?? payment.status;
  if (base !== "PENDING") return base;

  const expiresAt = payment.expiresAt
    ? new Date(payment.expiresAt)
    : new Date(new Date(payment.createdAt).getTime() + 30 * 60 * 1000);

  return expiresAt <= new Date() ? "EXPIRED" : "PENDING";
}

/**
 * Format an amount in ITS OWN currency (no cross-currency conversion) —
 * used by the per-currency summary so a USD payment is never summed or
 * displayed as INR.
 */
function formatAmountInCurrency(paise: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(paise / 100);
  } catch {
    return `${currency} ${(paise / 100).toFixed(2)}`;
  }
}

function getExpiryInfo(payment: PaymentItem): {
  datetime: string;
  relative: string;
  isExpired: boolean;
} | null {
  // Show expiry info for PENDING (countdown) and EXPIRED (how long ago)
  if (payment.status !== "PENDING" && payment.status !== "EXPIRED") return null;

  const expiresAt = payment.expiresAt
    ? new Date(payment.expiresAt)
    : new Date(new Date(payment.createdAt).getTime() + 30 * 60 * 1000);

  return {
    datetime: formatDateTime(expiresAt.toISOString()),
    relative: formatRelativeTime(expiresAt),
    isExpired: expiresAt <= new Date(),
  };
}

/**
 * #1365 — the buyer's own tax invoice for a payment. Defined at module scope
 * rather than inside the tab so it is not re-created on every render (S6478).
 * An empty cell means the booking was org-sponsored and is invoiced to the
 * organization instead, which is the correct answer rather than a missing
 * document.
 */
function renderInvoiceCell(payment: PaymentItem) {
  if (!payment.consumerInvoice) {
    return <span className="text-muted-foreground/70">&mdash;</span>;
  }
  return (
    <a
      href={`/api/payments/${payment.id}/invoice/pdf`}
      className="whitespace-nowrap text-sm font-medium text-foreground underline underline-offset-4 hover:text-muted-foreground"
    >
      {/* Explicit separator: JSX strips the newline between a text node and
          the element after it, so the words would otherwise run together. */}
      Download{" "}
      <span className="text-xs text-muted-foreground">
        {payment.consumerInvoice.invoiceNumber}
      </span>
    </a>
  );
}

export function PaymentsTab({ data }: { data: PaymentsData | undefined }) {
  const { formatPrice } = useCurrency();

  // #1396 — `formatPrice` assumes INR paise and applies the viewer's FX rate,
  // so a payment already denominated in another currency was converted a second
  // time and relabelled, while its refunds and the per-currency total right
  // below were rendered unconverted. The three disagreed on the same row. This
  // is the guard `PendingPaymentsWidget` already uses: only INR amounts go
  // through the converter, everything else renders in its own currency.
  const formatPaymentAmount = (paise: number, currency: string | null | undefined) =>
    currency && currency.toUpperCase() !== "INR"
      ? formatAmountInCurrency(paise, currency)
      : formatPrice(paise);
  const { data: session } = useSession();
  // Resolve a payment's `organizationId` to a displayable org name for
  // the "Sponsored · <Org>" badge — same convention as the appointments
  // / home surfaces.
  const orgMemberships = session?.user?.organizationMemberships ?? [];

  // Net successful spend grouped per currency — a USD payment must never be
  // summed into an INR total, and refunded amounts don't count as spend.
  const totalsByCurrency = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const p of data?.payments ?? []) {
      if (p.status !== "SUCCEEDED") continue;
      const currency = p.currency || "INR";
      const entry = map.get(currency) ?? { total: 0, count: 0 };
      entry.total += p.amount - (p.refundedPaise ?? 0);
      entry.count += 1;
      map.set(currency, entry);
    }
    return map;
  }, [data]);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const filteredPayments = useMemo(() => {
    let result = data?.payments ?? [];
    if (statusFilter !== "all") {
      result = result.filter((p) => getDisplayStatus(p) === statusFilter);
    }
    if (typeFilter !== "all") {
      result = result.filter(
        (p) => p.appointmentType?.toUpperCase() === typeFilter,
      );
    }
    result = [...result].sort((a, b) => {
      const diff =
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortDir === "asc" ? diff : -diff;
    });
    return result;
  }, [data, statusFilter, typeFilter, sortDir]);

  const paymentColumns: ResponsiveColumn<PaymentItem>[] = [
    {
      key: "plan",
      header: "Plan",
      primary: true,
      cell: (payment) => (
        <div className="max-w-[220px]">
          <div className="truncate font-medium text-foreground">
            {payment.planTitle}
          </div>
          {(() => {
            const sponsoringOrgName = resolveSponsoringOrgName(
              payment.organizationId,
              orgMemberships,
            );
            return sponsoringOrgName ? (
              <Badge
                className="mt-1 text-[10px] font-semibold px-2 py-0.5 bg-muted text-muted-foreground border-0 rounded-md inline-flex items-center gap-1 max-w-full"
                title={`Sponsored by ${sponsoringOrgName}`}
              >
                <Building2 className="h-3 w-3 shrink-0" />
                <span className="truncate">Sponsored · {sponsoringOrgName}</span>
              </Badge>
            ) : null;
          })()}
        </div>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (payment) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {formatDate(payment.createdAt)}
        </span>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (payment) => (
        <span className="text-muted-foreground whitespace-nowrap capitalize">
          {payment.appointmentType?.toLowerCase() || "—"}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      headClassName: "text-right",
      className: "text-right",
      cell: (payment) => (
        <span className="whitespace-nowrap">
          <span className="font-medium text-foreground">
            {formatPaymentAmount(payment.amount, payment.currency)}
          </span>
          {payment.taxAmount && payment.taxAmount > 0 && (
            <span className="block text-xs text-muted-foreground/70">
              incl.{" "}
              {formatPaymentAmount(payment.taxAmount ?? 0, payment.currency)} GST
            </span>
          )}
          {payment.discount && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center text-foreground ml-1 cursor-help">
                    <Tag className="w-3 h-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    &ldquo;{payment.discount.code}&rdquo;
                    {" — "}
                    {payment.discount.type === "PERCENTAGE"
                      ? `${payment.discount.value}% off`
                      : `${formatPaymentAmount(payment.discount.value, payment.currency)} off`}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </span>
      ),
    },
    {
      key: "method",
      header: "Method",
      cell: (payment) => (
        <span className="text-muted-foreground whitespace-nowrap text-xs">
          {formatGateway(payment.paymentGateway)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (payment) => {
        const displayStatus = getDisplayStatus(payment);
        return (
          <div className="space-y-1">
            <StatusBadge {...paymentStatusBadge(displayStatus)} size="sm" />
            {payment.refundedPaise > 0 && (
              <span className="block text-xs text-muted-foreground whitespace-nowrap">
                {formatAmountInCurrency(payment.refundedPaise, payment.currency)}{" "}
                refunded
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "refunds",
      header: "Refunds",
      cell: (payment) => {
        if (payment.refunds.length === 0) {
          return <span className="text-muted-foreground/70">&mdash;</span>;
        }
        return (
          <ul className="space-y-1.5">
            {payment.refunds.map((refund) => (
              <li key={refund.id} className="whitespace-nowrap">
                <StatusBadge {...refundStatusBadge(refund.status)} size="sm" />
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {formatAmountInCurrency(refund.amountPaise, payment.currency)}
                  {" · "}
                  {formatDate(refund.createdAt)}
                </span>
                {refund.reason && (
                  <span
                    className="block text-xs text-muted-foreground/70 max-w-[200px] truncate"
                    title={refund.reason}
                  >
                    {refund.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        );
      },
    },
    {
      key: "invoice",
      header: "Tax invoice",
      cell: renderInvoiceCell,
    },
    {
      key: "expires",
      header: "Expires",
      cell: (payment) => {
        const expiry = getExpiryInfo(payment);
        if (!expiry) {
          return <span className="text-muted-foreground/70">&mdash;</span>;
        }
        return (
          <div className="whitespace-nowrap">
            <span className="text-xs text-muted-foreground">
              {expiry.datetime}
            </span>
            <span
              className={cn(
                "block text-xs",
                expiry.isExpired
                  ? "text-muted-foreground/70"
                  : "text-amber-600 dark:text-amber-400",
              )}
            >
              {expiry.relative}
            </span>
          </div>
        );
      },
    },
  ];

  const creditColumns: ResponsiveColumn<CreditItem>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (credit) => (
        <span className="capitalize text-foreground">
          {credit.source.toLowerCase().replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (credit) => (
        <span className="text-muted-foreground whitespace-nowrap">
          {formatDate(credit.createdAt)}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      headClassName: "text-right",
      className: "text-right",
      cell: (credit) => (
        <span className="font-medium text-foreground">
          {formatPrice(credit.amount)}
        </span>
      ),
    },
    {
      key: "remaining",
      header: "Remaining",
      headClassName: "text-right",
      className: "text-right",
      cell: (credit) => (
        <span className="font-medium text-green-600 dark:text-green-400">
          {formatPrice(credit.remainingAmount)}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      cell: (credit) => (
        <span className="text-muted-foreground">
          {credit.expiresAt ? formatDate(credit.expiresAt) : "No expiry"}
        </span>
      ),
    },
  ];

  const creditUsageColumns: ResponsiveColumn<CreditUsageItem>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      cell: (usage) => (
        <span className="capitalize text-foreground">
          {usage.credit.source.toLowerCase().replace(/_/g, " ")}
        </span>
      ),
    },
    {
      key: "date",
      header: "Date",
      cell: (usage) => (
        <span className="text-muted-foreground">{formatDate(usage.usedAt)}</span>
      ),
    },
    {
      key: "used",
      header: "Used",
      headClassName: "text-right",
      className: "text-right",
      cell: (usage) => (
        <span className="font-medium text-red-600 dark:text-red-400">
          -{formatPrice(usage.amount)}
        </span>
      ),
    },
  ];

  if (!data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6">
        <DashboardHeader
          title="Payments"
          subtitle="Your payment history and credits"
        />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-xl border border-border p-4">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="text-sm text-muted-foreground cursor-help w-fit">
                  Total Spent{" "}
                  <span className="text-muted-foreground/70">&#9432;</span>
                </p>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Successful payments net of refunds. Multi-currency spend is
                  totalled per currency, never converted.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {totalsByCurrency.size === 0 ? (
            <p className="text-2xl font-bold text-foreground">
              {formatPrice(0)}
            </p>
          ) : (
            <div className="space-y-0.5">
              {Array.from(totalsByCurrency.entries()).map(([currency, entry]) => (
                <p
                  key={currency}
                  className="text-2xl font-bold text-foreground leading-tight"
                >
                  {formatAmountInCurrency(entry.total, currency)}
                </p>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground/70 mt-1">
            {(() => {
              const count = data.payments.filter(
                (p) => p.status === "SUCCEEDED",
              ).length;
              return `${count} successful ${count === 1 ? "transaction" : "transactions"} `;
            })()}
            &middot; {data.payments.length} total
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">Credits Earned</p>
          <p className="text-2xl font-bold text-foreground">
            {formatPrice(data.creditSummary.total)}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {formatPrice(data.creditSummary.used)} used
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">Credit Balance</p>
          <p className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatPrice(data.creditSummary.remaining)}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">Available to use</p>
        </div>
      </div>

      <Tabs defaultValue="payments" className="space-y-6">
        <TabsList>
          <TabsTrigger value="payments">
            <CreditCard className="w-4 h-4 mr-1.5" />
            Transactions
          </TabsTrigger>
          <TabsTrigger value="credits">
            <Gift className="w-4 h-4 mr-1.5" />
            Credits
          </TabsTrigger>
        </TabsList>

        {/* Payments (merged transactions + invoices) */}
        <TabsContent value="payments">
          {data.payments.length === 0 ? (
            <EmptyState message="No payments yet" />
          ) : (
            <div className="space-y-3">
              {/* Filter / Sort bar */}
              <div className="flex flex-wrap items-center gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-[150px]">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                    <SelectItem value="REFUNDED">Refunded</SelectItem>
                    <SelectItem value="PARTIALLY_REFUNDED">
                      Partially refunded
                    </SelectItem>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                    <SelectItem value="EXPIRED">Expired</SelectItem>
                  </SelectContent>
                </Select>

                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[170px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="CONSULTATION">Consultation</SelectItem>
                    <SelectItem value="SUBSCRIPTION">Subscription</SelectItem>
                    <SelectItem value="WEBINAR">Webinar</SelectItem>
                    <SelectItem value="CLASS">Class</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                  }
                  className="gap-1.5"
                >
                  <ArrowUpDown className="w-3.5 h-3.5" />
                  {sortDir === "desc" ? "Newest first" : "Oldest first"}
                </Button>
              </div>

              {filteredPayments.length === 0 ? (
                <EmptyState message="No transactions match the selected filters" />
              ) : (
                <div className="bg-card rounded-xl border border-border p-2 sm:p-3">
                  <ResponsiveTable<PaymentItem>
                    columns={paymentColumns}
                    rows={filteredPayments}
                    getRowId={(p) => p.id}
                  />
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* Credits */}
        <TabsContent value="credits">
          <div className="space-y-6">
            {/* Credits list */}
            {data.credits.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 bg-card rounded-xl border border-border">
                <Gift className="w-8 h-8 text-muted-foreground/70 mb-3" />
                <p className="text-muted-foreground">No credits yet</p>
                <p className="text-sm text-muted-foreground/70 mt-1">
                  Refer friends to earn credits you can use on future bookings.
                </p>
              </div>
            ) : (
              <div className="bg-card rounded-xl border border-border p-2 sm:p-3">
                <ResponsiveTable<CreditItem>
                  columns={creditColumns}
                  rows={data.credits}
                  getRowId={(c) => c.id}
                />
              </div>
            )}

            {/* Credit usage history */}
            {data.creditUsages.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  Usage History
                </h3>
                <div className="bg-card rounded-xl border border-border p-2 sm:p-3">
                  <ResponsiveTable<CreditUsageItem>
                    columns={creditUsageColumns}
                    rows={data.creditUsages}
                    getRowId={(u) => u.id}
                  />
                </div>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 bg-card rounded-xl border border-border">
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}
