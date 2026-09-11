"use client";

/**
 * Platform-wide document review log — shared by the admin and staff trees.
 *
 * The back-office had no document surface at all, so a ticket like "why was
 * my document rejected?" couldn't be answered without asking the consultant.
 * This shows the document, its review status, the reviewer's notes, and the
 * appointment (and org, when there is one) it belongs to.
 *
 * Read-only by design. Whether a document passes is the consultant's call
 * about their own session; the back-office needs to *see* that decision to
 * explain it, not to overturn it.
 */

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

const REVIEW_STATUSES = [
  "PENDING",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
] as const;

const STATUS_CLASS: Record<string, string> = {
  APPROVED:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  NEEDS_REVISION:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  IN_REVIEW: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  PENDING: "bg-muted text-muted-foreground",
};

interface DocumentRow {
  id: string;
  originalName: string;
  reviewStatus: string;
  reviewNotes: string | null;
  reviewedAt: string | null;
  uploadedByRole: string;
  uploadedAt: string;
  isStorageMissing: boolean;
  responseToDocumentId: string | null;
  appointment: {
    id: string;
    appointmentType: string;
    organizationId: string | null;
    organization: { id: string; name: string; slug: string } | null;
  } | null;
}

interface DocumentsResponse {
  items: DocumentRow[];
  total: number;
  page: number;
  perPage: number;
}

const COLUMNS: Column<DocumentRow>[] = [
  {
    header: "Document",
    accessor: (r) => (
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">
          {r.originalName}
        </p>
        {/* A revision reads as an unrelated row otherwise — the reviewer sees
            two files and no indication one supersedes the other. */}
        {r.responseToDocumentId && (
          <p className="text-xs text-muted-foreground">↳ revision / response</p>
        )}
        {r.isStorageMissing && (
          <p className="text-xs text-red-600 dark:text-red-400">
            file missing from storage
          </p>
        )}
      </div>
    ),
  },
  {
    header: "Status",
    accessor: (r) => (
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
          STATUS_CLASS[r.reviewStatus] ?? "bg-muted text-muted-foreground"
        }`}
      >
        {r.reviewStatus.replace(/_/g, " ")}
      </span>
    ),
  },
  {
    header: "Review notes",
    accessor: (r) =>
      r.reviewNotes ? (
        // The single most useful column for a support ticket, and the reason
        // this page exists — truncated, full text on hover.
        <span
          className="block max-w-xs truncate text-sm text-muted-foreground"
          title={r.reviewNotes}
        >
          {r.reviewNotes}
        </span>
      ) : (
        <span className="text-muted-foreground/70">—</span>
      ),
  },
  {
    header: "Uploaded by",
    accessor: (r) => <Badge variant="outline">{r.uploadedByRole}</Badge>,
  },
  {
    header: "Context",
    accessor: (r) =>
      r.appointment ? (
        <div className="text-sm">
          <p className="text-foreground">{r.appointment.appointmentType}</p>
          <p className="text-xs text-muted-foreground">
            {r.appointment.organization?.name ?? "Personal (B2C)"}
          </p>
        </div>
      ) : (
        <span className="text-muted-foreground/70">—</span>
      ),
  },
  {
    header: "Uploaded",
    accessor: (r) => format(new Date(r.uploadedAt), "PP"),
  },
];

export function DocumentsPage() {
  // `ScopedListTable` paginates by pushing `?page=N`, so the URL is the source
  // of truth. Holding it in local state meant every deep link and every
  // pagination click still fetched page 1 while the footer claimed otherwise.
  // Same derivation the org recordings/documents clients already use.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;
  const [status, setStatus] = useState<string>("all");

  const { data, isLoading, isError } = useQuery<DocumentsResponse>({
    queryKey: ["operator-documents", page, status],
    queryFn: async () => {
      const sp = new URLSearchParams({ page: String(page) });
      if (status !== "all") sp.set("reviewStatus", status);
      const res = await fetch(`/api/admin/documents?${sp.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const toolbar = (
    <Select
      value={status}
      onValueChange={(v) => {
        setStatus(v);
        // Drop the page param rather than setting it to 1 — a filter change
        // makes the old offset meaningless.
        const sp = new URLSearchParams(searchParams?.toString() ?? "");
        sp.delete("page");
        const qs = sp.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      }}
    >
      <SelectTrigger className="w-full sm:w-56">
        <SelectValue placeholder="Any review status" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Any review status</SelectItem>
        {REVIEW_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {s.replace(/_/g, " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-6">
      <DashboardHeader
        title="Documents"
        subtitle="Every document uploaded against an appointment, with its review outcome"
      />
      <ScopedListTable
        title="Document review log"
        description="Read-only. Reviewing is the consultant's call on their own session; this is here so support can explain an outcome."
        isLoading={isLoading}
        isError={isError}
        items={data?.items ?? []}
        total={data?.total ?? 0}
        page={data?.page ?? page}
        perPage={data?.perPage ?? 20}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        toolbar={toolbar}
        emptyMessage="No documents match this filter."
      />
    </div>
  );
}
