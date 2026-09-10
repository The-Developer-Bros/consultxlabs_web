"use client";

/**
 * FinanceLeadViewCard — the BILLING_ADMIN-tuned landing on /home.
 *
 * Why this exists separate from the consumer + operator branches in
 * HomePageClient: BILLING_ADMIN is finance-only — they don't need the
 * operator's member/seat/checklist surface, and the consumer's
 * "your sponsored bookings" card is wrong for them. The card here
 * speaks to a finance lead's daily workflow: outstanding invoices,
 * pending payouts, wallet headroom, recent receipts. Deep-links into
 * the existing /billing + /payouts + /integrations pages so this
 * remains a summary, not a duplicate of those screens.
 *
 * Data shape: reads from the same `/api/organizations/[orgId]/analytics`
 * endpoint the operator view uses — analytics is MANAGER+ at the API
 * layer, and BILLING_ADMIN (rank 70) > MANAGER (60) so the read is
 * authorized. We just render a different layout from the same payload.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  CreditCard,
  Wallet,
  FileText,
  Receipt,
  ArrowRight,
  AlertCircle,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/dashboard/StatCard";
import { Button } from "@/components/ui/button";
import { DashboardGrid } from "@/components/dashboard/PageScaffold";
import { formatCurrencyAmount } from "@/utils/formatting";
import { BillingBlockBanner } from "@/components/billing/BillingBlockBanner";

/**
 * Shape mirrors the live `/api/organizations/[orgId]/analytics` payload
 * — paise units, null for "feature not configured". Keeping the card
 * a pure presentational component over the live payload avoids a
 * transform layer that would drift out of sync.
 *
 * Pending-payout count + PO burndown are intentionally NOT pulled
 * today: the analytics endpoint doesn't ship them yet, so we render
 * deep-link CTAs instead of fabricated numbers. When analytics gains
 * those fields, swap the static cards for live counts in this file
 * only.
 */
interface FinanceLeadViewProps {
  orgId: string;
  data: {
    capabilities: { currency: string | null };
    wallet: { balancePaise: number } | null;
    invoices: {
      outstandingCount: number;
      outstandingPaise: number;
      pastDueCount: number;
    } | null;
  };
}

export function FinanceLeadViewCard({ orgId, data }: FinanceLeadViewProps) {
  const router = useRouter();
  const currency = data.capabilities.currency ?? "INR";

  const billingHref = `/dashboard/organization/${orgId}/billing`;
  const pastDueCount = data.invoices?.pastDueCount ?? 0;

  // #1427/#1430 — same query key as BillingPageClient's `fetchBilling`
  // (["org-billing", orgId]), so the two share react-query's cache instead
  // of double-fetching when a finance lead lands here first. The route is
  // a cheap DB-side aggregate, not the heavier analytics payload above.
  const billingBlock = useQuery({
    queryKey: ["org-billing", orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/billing`);
      if (!res.ok) throw new Error("Failed to load billing status");
      return (await res.json()) as {
        walletFrozen: boolean;
        walletFrozenReason: string | null;
        dunningSuspended: boolean;
      };
    },
  });

  const stats: Array<{
    label: string;
    value: string;
    subtitle?: string;
    icon: typeof CreditCard;
    href: string;
    cta: string;
  }> = [
    {
      label: "Outstanding invoices",
      value: data.invoices
        ? formatCurrencyAmount(data.invoices.outstandingPaise, currency)
        : "—",
      subtitle: data.invoices
        ? `${data.invoices.outstandingCount} unpaid${data.invoices.pastDueCount > 0 ? ` (${data.invoices.pastDueCount} past due)` : ""}`
        : undefined,
      icon: FileText,
      href: `/dashboard/organization/${orgId}/billing`,
      cta: "Review invoices",
    },
    {
      label: "Wallet balance",
      value: data.wallet
        ? formatCurrencyAmount(data.wallet.balancePaise, currency)
        : "—",
      subtitle: data.wallet ? "Available to debit" : "No wallet configured",
      icon: Wallet,
      href: `/dashboard/organization/${orgId}/billing?tab=wallet`,
      cta: "Top up wallet",
    },
    {
      label: "Payouts",
      value: "Open →",
      subtitle: "Review pending + recent runs",
      icon: CreditCard,
      href: `/dashboard/organization/${orgId}/payouts`,
      cta: "Open payouts",
    },
    {
      label: "Purchase orders",
      value: "Open →",
      subtitle: "PO balance + utilization",
      icon: Receipt,
      href: `/dashboard/organization/${orgId}/purchase-orders`,
      cta: "Manage POs",
    },
  ];

  return (
    <>
      {billingBlock.data && (
        <BillingBlockBanner
          walletFrozen={billingBlock.data.walletFrozen}
          walletFrozenReason={billingBlock.data.walletFrozenReason}
          dunningSuspended={billingBlock.data.dunningSuspended}
          supportHref={`/dashboard/organization/${orgId}/support`}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Finance overview</CardTitle>
          <CardDescription>
            Everything you can act on as the finance lead — invoices to chase,
            payouts to approve, wallet headroom, PO burndown. Member and SSO
            surfaces are intentionally hidden; coordinate with your OWNER for
            those.
          </CardDescription>
        </CardHeader>
      </Card>

      <DashboardGrid className="mt-4">
        {stats.map((stat) => {
          // Outstanding + wallet deep-link into /billing; the other two
          // already carry CTA buttons below, so leave them non-clickable
          // to avoid two competing affordances on the same card.
          const deepLinks =
            stat.label === "Outstanding invoices" ||
            stat.label === "Wallet balance";
          const isOutstanding = stat.label === "Outstanding invoices";
          return (
            <div key={stat.label}>
              <StatCard
                // StatCard names its primary text `title` (not `label`);
                // we keep the local stat object's `.label` for symmetry
                // with the CTA buttons below and just remap at render.
                title={stat.label}
                value={stat.value}
                subtitle={stat.subtitle}
                icon={stat.icon}
                variant={
                  isOutstanding && pastDueCount > 0 ? "danger" : "default"
                }
                onClick={deepLinks ? () => router.push(stat.href) : undefined}
              />
              {/* Past-due needs more than a number — give the finance lead a
                  one-click jump to the invoices they have to chase. */}
              {isOutstanding && pastDueCount > 0 && (
                <Link
                  href={billingHref}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                >
                  <AlertCircle className="h-3.5 w-3.5" />
                  {pastDueCount} past due — pay now
                </Link>
              )}
            </div>
          );
        })}
      </DashboardGrid>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Quick actions</CardTitle>
          <CardDescription>
            Jump to the page you most likely need next.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {stats.map((stat) => (
            <Button
              key={stat.label}
              asChild
              variant="outline"
              className="justify-between"
            >
              <Link href={stat.href}>
                <span>{stat.cta}</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          ))}
          <Button asChild variant="outline" className="justify-between">
            <Link
              href={`/dashboard/organization/${orgId}/settings?tab=webhooks`}
            >
              <span>Manage outbound webhooks</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="justify-between">
            <Link
              href={`/dashboard/organization/${orgId}/settings?tab=data-exports`}
            >
              <span>Request a data export</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
