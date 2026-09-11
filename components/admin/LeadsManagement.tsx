"use client";

/**
 * Enterprise leads pipeline (#1230 wave-4c). Lists `Lead` rows newest-first
 * with a status filter; each row's status is editable via the guarded PATCH
 * (CAS on allowed-from states, 409 on concurrent advance — surface the
 * reload hint rather than retrying blind).
 */

import { useCallback, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { LeadStatus } from "@prisma/client";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUSES: Array<LeadStatus | "ALL"> = [
  "ALL",
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CLOSED_WON",
  "CLOSED_LOST",
];

// Mirrors ALLOWED_FROM in the PATCH route — the dropdown offers only
// reachable targets so operators never see a 409 for picking NEW on an
// already-new lead or skipping the qualification step.
const NEXT_STATUSES: Record<LeadStatus, LeadStatus[]> = {
  NEW: ["CONTACTED", "CLOSED_LOST"],
  CONTACTED: ["QUALIFIED", "CLOSED_LOST"],
  QUALIFIED: ["CLOSED_WON", "CLOSED_LOST"],
  CLOSED_WON: [],
  CLOSED_LOST: [],
};

const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CLOSED_WON: "Won",
  CLOSED_LOST: "Lost",
};

interface LeadRow {
  id: string;
  sourceCategory: string;
  companyName: string | null;
  contactName: string;
  contactEmail: string;
  phone: string | null;
  subject: string;
  message: string;
  status: LeadStatus;
  createdAt: string;
}

export function LeadsManagement() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  // CR #1245 r1 — infinite scroll pagination: the API caps at 50 rows per
  // page and older leads were unreachable past that.
  const query = useInfiniteQuery({
    queryKey: ["admin-leads", statusFilter],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (pageParam) params.set("cursor", pageParam);
      const res = await fetch(`/api/admin/leads?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load leads");
      return (await res.json()) as {
        leads: LeadRow[];
        nextCursor: string | null;
      };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const leads = query.data?.pages.flatMap((p) => p.leads) ?? [];

  const transition = useCallback(
    async (id: string, status: LeadStatus) => {
      setRowError(null);
      setBusyId(id);
      try {
        const res = await fetch(`/api/admin/leads/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          throw new Error(b.error || "Update failed");
        }
        await queryClient.invalidateQueries({
          queryKey: ["admin-leads"],
        });
      } catch (err) {
        setRowError({
          id,
          msg: err instanceof Error ? err.message : "Update failed",
        });
      } finally {
        setBusyId(null);
      }
    },
    [queryClient],
  );

  return (
    <>
      <DashboardHeader
        title="Enterprise leads"
        subtitle="Inquiries from the enterprise funnel — work them to Won or Lost"
        actions={
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v)}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "ALL" ? "All statuses" : STATUS_LABEL[s as LeadStatus]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="space-y-3">
        {query.isError && (
          <p className="text-sm text-red-600">Failed to load leads.</p>
        )}
        {leads.length === 0 && !query.isFetching && (
          <p className="text-sm text-zinc-500">No leads in this view.</p>
        )}
        {leads.map((lead) => (
          <div
            key={lead.id}
            className="rounded-lg border bg-card p-4 space-y-2"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">
                  {lead.companyName ?? lead.contactName}{" "}
                  <span className="text-xs text-zinc-400">
                    · {lead.sourceCategory}
                  </span>
                </p>
                <a
                  href={`mailto:${lead.contactEmail}`}
                  className="text-sm text-blue-600 hover:underline"
                >
                  {lead.contactEmail}
                </a>
                {lead.phone && (
                  <span className="ml-2 text-sm text-zinc-500">
                    {lead.phone}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {NEXT_STATUSES[lead.status].length > 0 ? (
                  <Select
                    value={lead.status}
                    disabled={busyId === lead.id}
                    onValueChange={(v) =>
                      void transition(lead.id, v as LeadStatus)
                    }
                  >
                    <SelectTrigger className="w-36" id={`status-${lead.id}`}>
                      {/* Current status is excluded from the successor
                          items, so render its label as the trigger value. */}
                      <SelectValue>
                        {STATUS_LABEL[lead.status]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {/* Only reachable targets — mirrors the route's
                          ALLOWED_FROM table so the UI can't offer a move
                          the API would reject. */}
                      {NEXT_STATUSES[lead.status].map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-zinc-500">
                    {STATUS_LABEL[lead.status]} — closed
                  </span>
                )}
                <Button size="sm" variant="outline" asChild>
                  <a href={`mailto:${lead.contactEmail}`}>Reply</a>
                </Button>
              </div>
            </div>
            <p className="text-sm font-medium">{lead.subject}</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-600 line-clamp-3">
              {lead.message}
            </p>
            <p className="text-xs text-zinc-400">
              Received{" "}
              {new Date(lead.createdAt).toLocaleString("en-IN", {
                timeZone: "UTC",
              })}{" "}
              UTC
            </p>
            {rowError?.id === lead.id && (
              <p className="text-xs text-red-600">{rowError.msg}</p>
            )}
          </div>
        ))}
      </div>
      {query.hasNextPage && (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </>
  );
}
