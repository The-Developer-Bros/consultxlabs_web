"use client";

/**
 * C4: Reimbursement-report dashboard for orgs on PERSONAL funding.
 * MANAGER+ at the org. Shows per-member totals and a paginated
 * payment list. CSV export downloads via /export endpoint.
 */

import { use, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

interface ReimbursementRow {
  id: string;
  amount: number;
  currency: string;
  description: string | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  /** Gross, refunded and net in paise — see the route's netting rationale. */
  grossPaise: number;
  refundedPaise: number;
  netReimbursablePaise: number;
}

interface ByMemberRow {
  userId: string;
  name: string | null;
  email: string | null;
  totalPaise: number;
  refundedPaise: number;
  netReimbursablePaise: number;
  paymentCount: number;
}

interface ReimbursementsResponse {
  items: ReimbursementRow[];
  total: number;
  page: number;
  perPage: number;
  totalPaise: number;
  totalRefundedPaise: number;
  totalNetPaise: number;
  byMember: ByMemberRow[];
}

const COLUMNS: Column<ReimbursementRow>[] = [
  {
    header: "Date",
    accessor: (r) => format(new Date(r.createdAt), "PP"),
  },
  {
    header: "Member",
    accessor: (r) => r.user.name || r.user.email,
  },
  { header: "Description", accessor: (r) => r.description ?? "—" },
  {
    header: "Amount",
    accessor: (r) => `${(r.grossPaise / 100).toFixed(2)} ${r.currency}`,
  },
  {
    header: "Refunded",
    accessor: (r) =>
      r.refundedPaise > 0 ? `−${(r.refundedPaise / 100).toFixed(2)}` : "—",
  },
  {
    // The payable figure. A fully refunded row stays visible at 0.00 rather
    // than vanishing from the report.
    header: "Net reimbursable",
    accessor: (r) =>
      `${(r.netReimbursablePaise / 100).toFixed(2)} ${r.currency}`,
  },
  {
    header: "Payment",
    accessor: (r) => (
      <Badge variant="outline" className="font-mono text-xs">
        {r.id.slice(0, 8)}
      </Badge>
    ),
  },
];

export default function OrgReimbursementsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  // Page-level mirror of the API gate — previously this page had NO
  // guard and rendered an error shell for unauthorized roles (#audit F8).
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "reimbursements.read",
    canSponsor: true,
    fundingSource: "PERSONAL",
  });
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // ISO-encode the date inputs so the server's z.string().datetime()
  // parser accepts them. Empty inputs are dropped — the API treats
  // missing from/to as "no bound".
  const fromIso = fromDate ? new Date(fromDate).toISOString() : undefined;
  const toIso = toDate
    ? new Date(`${toDate}T23:59:59.999`).toISOString()
    : undefined;

  const apiUrl = new URLSearchParams({ page: String(page) });
  if (fromIso) apiUrl.set("from", fromIso);
  if (toIso) apiUrl.set("to", toIso);

  const exportUrl = (() => {
    const q = new URLSearchParams();
    if (fromIso) q.set("from", fromIso);
    if (toIso) q.set("to", toIso);
    const qs = q.toString();
    return `/api/organizations/${orgId}/reimbursements/export${qs ? `?${qs}` : ""}`;
  })();

  const { data, isLoading, isError, error } =
    useQuery<ReimbursementsResponse>({
    enabled: allowed,
      queryKey: ["org-reimbursements", orgId, page, fromIso, toIso],
      queryFn: async () => {
        const res = await fetch(
          `/api/organizations/${orgId}/reimbursements?${apiUrl.toString()}`,
        );
        if (res.status === 404) {
          throw new Error(
            "This org is not on PERSONAL funding — reimbursements view is unavailable.",
          );
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
    });

  // The card is labelled "Total to reimburse", so it shows the NET. It used to
  // read the gross, which over-stated the payroll transfer by every refund.
  const totalNetRupees = ((data?.totalNetPaise ?? 0) / 100).toFixed(2);
  const totalRefundedRupees = ((data?.totalRefundedPaise ?? 0) / 100).toFixed(2);

  return (
    <>
      <DashboardHeader
        title="Reimbursements"
        subtitle="Members paid out of pocket on org bookings — pay them back via your payroll using this report."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={exportUrl} download>
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </a>
          </Button>
        }
      />
      <DashboardContent>
        <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md">
          <div className="space-y-1.5">
            <Label htmlFor="from-date">From</Label>
            <Input
              id="from-date"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              max={toDate || undefined}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="to-date">To</Label>
            <Input
              id="to-date"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              min={fromDate || undefined}
            />
          </div>
        </div>

        {data && (
          <div className="mb-4 flex flex-wrap gap-3">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase text-muted-foreground">
                Total to reimburse
              </p>
              <p className="mt-1 text-2xl font-semibold">₹{totalNetRupees}</p>
              {(data.totalRefundedPaise ?? 0) > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Net of ₹{totalRefundedRupees} refunded
                </p>
              )}
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase text-muted-foreground">
                Members owed
              </p>
              <p className="mt-1 text-2xl font-semibold">
                {
                  data.byMember.filter((m) => m.netReimbursablePaise > 0)
                    .length
                }
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-xs uppercase text-muted-foreground">
                Payments
              </p>
              <p className="mt-1 text-2xl font-semibold">{data.total}</p>
            </div>
          </div>
        )}

        <ScopedListTable
          title="Reimbursable payments"
          isLoading={isLoading}
          isError={isError}
          errorMessage={
            error instanceof Error ? error.message : "Failed to load."
          }
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No reimbursable payments yet — members on this org haven't paid out of pocket for any sessions."
        />
      </DashboardContent>
    </>
  );
}
