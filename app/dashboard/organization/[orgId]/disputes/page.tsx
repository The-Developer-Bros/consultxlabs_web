"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, AlertCircle, CheckCircle2, Clock } from "lucide-react";

import {
  DashboardHeader,
  DashboardContent,
  DashboardGrid,
} from "@/components/dashboard/PageScaffold";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/StatCard";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatCurrencyAmount } from "@/utils/formatting";
import { useRequireOrgAccess } from "../useOrgRole";

interface DisputeItem {
  id: string;
  disputeId: string;
  amountPaise: number;
  currency: string;
  reason: string | null;
  status: string;
  dueBy: string | null;
  createdAt: string;
  updatedAt: string;
  payment: { id: string; billingAccountId: string | null };
}

async function fetchDisputes(
  orgId: string,
): Promise<{ data: DisputeItem[] }> {
  const res = await fetch(`/api/organizations/${orgId}/disputes`);
  if (!res.ok) throw new Error("Failed to load disputes");
  return res.json();
}

// Mirrors prisma `enum DisputeStatus`. "Open" rolls up everything still
// needing action or under review; LOST/CHARGE_REFUNDED are settled against us
// (the org wallet bore the chargeback); WON/WARNING_CLOSED resolved in our
// favor.
const STATUS_CONFIG: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    open: boolean;
    lost: boolean;
  }
> = {
  WARNING_NEEDS_RESPONSE: { label: "Needs response", variant: "secondary", open: true, lost: false },
  WARNING_UNDER_REVIEW: { label: "Under review", variant: "outline", open: true, lost: false },
  WARNING_CLOSED: { label: "Closed", variant: "default", open: false, lost: false },
  NEEDS_RESPONSE: { label: "Needs response", variant: "destructive", open: true, lost: false },
  UNDER_REVIEW: { label: "Under review", variant: "outline", open: true, lost: false },
  CHARGE_REFUNDED: { label: "Charge refunded", variant: "destructive", open: false, lost: true },
  WON: { label: "Won", variant: "default", open: false, lost: false },
  LOST: { label: "Lost", variant: "destructive", open: false, lost: true },
  // Razorpay terminal for ended-without-verdict (refund issued / details
  // provided). Not "lost": the org wallet bore nothing beyond any refund
  // already accounted by the refund path.
  CLOSED: { label: "Closed", variant: "default", open: false, lost: false },
};

export default function OrgDisputesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const { allowed } = useRequireOrgAccess(orgId, { permission: "disputes.read" });

  const { data, isPending, isError } = useQuery({
    queryKey: ["org-disputes", orgId],
    queryFn: () => fetchDisputes(orgId),
    enabled: allowed,
  });

  const disputes = data?.data ?? [];
  const openCount = disputes.filter(
    (d) => STATUS_CONFIG[d.status]?.open,
  ).length;
  const lostAmount = disputes
    .filter((d) => STATUS_CONFIG[d.status]?.lost)
    .reduce((s, d) => s + d.amountPaise, 0);

  if (!allowed) return null;

  return (
    <>
      <DashboardHeader
        title="Disputes"
        subtitle="Chargebacks raised against org-funded bookings"
      />
      <DashboardContent>
        {isPending ? (
          <DashboardGrid columns={3}>
            {[1, 2, 3].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </DashboardGrid>
        ) : isError || !data ? (
          /* A failed fetch used to render "0 open · ₹0.00 lost to
             chargebacks · No disputes raised against this organization" —
             chargeback exposure reading as clean when it simply hadn't
             loaded. */
          <div className="rounded-lg border border-border bg-card p-6 text-sm">
            <p className="font-medium text-foreground">
              Couldn&apos;t load disputes
            </p>
            <p className="mt-1 text-muted-foreground">
              This is a loading problem, not a clean record — refresh to try
              again.
            </p>
          </div>
        ) : (
          <>
            <DashboardGrid columns={3}>
              <StatCard
                title="Open disputes"
                value={openCount}
                icon={Clock}
                variant={openCount > 0 ? "warning" : "default"}
              />
              <StatCard
                title="Lost to chargebacks"
                value={formatCurrencyAmount(lostAmount, "INR")}
                subtitle="Borne by the org wallet"
                icon={AlertCircle}
                variant={lostAmount > 0 ? "danger" : "default"}
              />
              <StatCard
                title="Total disputes"
                value={disputes.length}
                icon={CheckCircle2}
              />
            </DashboardGrid>

            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="h-4 w-4" />
                  Dispute history
                </CardTitle>
              </CardHeader>
              <CardContent>
                {disputes.length === 0 ? (
                  <p className="text-sm text-zinc-500 py-8 text-center">
                    No disputes raised against this organization.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-zinc-500 border-b">
                          <th className="py-2 pr-4 font-medium">Raised</th>
                          <th className="py-2 pr-4 font-medium">Amount</th>
                          <th className="py-2 pr-4 font-medium">Reason</th>
                          <th className="py-2 pr-4 font-medium">Due by</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {disputes.map((d) => {
                          const cfg = STATUS_CONFIG[d.status] ?? {
                            label: d.status,
                            variant: "outline" as const,
                          };
                          return (
                            <tr key={d.id} className="border-b last:border-0">
                              <td className="py-2 pr-4 whitespace-nowrap">
                                {new Date(d.createdAt).toLocaleDateString("en-IN")}
                              </td>
                              <td className="py-2 pr-4 whitespace-nowrap">
                                {formatCurrencyAmount(d.amountPaise, d.currency)}
                              </td>
                              <td className="py-2 pr-4 max-w-[20rem] truncate">
                                {d.reason ?? "—"}
                              </td>
                              <td className="py-2 pr-4 whitespace-nowrap">
                                {d.dueBy
                                  ? new Date(d.dueBy).toLocaleDateString("en-IN")
                                  : "—"}
                              </td>
                              <td className="py-2 pr-4">
                                <Badge variant={cfg.variant}>{cfg.label}</Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </DashboardContent>
    </>
  );
}
