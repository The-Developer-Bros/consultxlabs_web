"use client";

import { Badge } from "@/components/ui/badge";
import { ResponsiveTable } from "@/components/ui/responsive-table";
import type { OrgPendingRequest } from "@/lib/data/org-pending-requests";

/**
 * The payer's read-only view of unallocated org-funded requests (#1166 B2B
 * gap 8).
 *
 * Deliberately has no allocate control. Choosing a session's times is the
 * delivering expert's act, and giving an OWNER a button that books someone
 * else's calendar would be worse than the blind spot this replaces. What the
 * payer needs is the fact itself: this org paid for a session and nobody has
 * scheduled it yet.
 */
export function PayerRequestsView({
  requests,
}: Readonly<{ requests: OrgPendingRequest[] }>) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        These sessions are funded by your organization and are waiting for the
        assigned expert to propose times. Allocation is theirs to do — this view
        is here so an unscheduled booking is never invisible to the people
        paying for it.
      </p>
      <ResponsiveTable<OrgPendingRequest>
        rows={requests}
        getRowId={(row) => `${row.kind}:${row.id}`}
        empty="Nothing is waiting to be scheduled."
        columns={[
          {
            key: "plan",
            header: "Session",
            primary: true,
            cell: (row) => row.planTitle,
          },
          {
            key: "learner",
            header: "Requested by",
            cell: (row) => row.learnerName ?? "—",
          },
          {
            key: "expert",
            header: "Expert",
            cell: (row) => row.expertName ?? "—",
          },
          {
            key: "kind",
            header: "Type",
            cell: (row) => (
              <Badge variant="secondary">
                {row.kind === "CONSULTATION" ? "Consultation" : "Subscription"}
              </Badge>
            ),
          },
          {
            key: "requestedAt",
            header: "Requested",
            cell: (row) => new Date(row.requestedAt).toLocaleDateString(),
          },
        ]}
      />
    </div>
  );
}
