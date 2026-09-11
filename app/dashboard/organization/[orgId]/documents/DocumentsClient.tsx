"use client";

/**
 * Org-scoped documents dashboard (#674 / B1-hybrid). MANAGER+ at the org.
 * Documents inherit org context via the parent Appointment.organizationId.
 */

import { useQuery } from "@tanstack/react-query";
import { useRequireOrgAccess } from "../useOrgRole";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

interface DocumentRow {
  id: string;
  fileName: string;
  reviewStatus: string;
  uploadedAt: string;
  uploadedByRole: string;
  reviewNotes: string | null;
  responseToDocumentId: string | null;
  isStorageMissing: boolean;
  appointment: {
    id: string;
    appointmentType: string;
    organizationId: string | null;
  };
}

interface DocumentsResponse {
  items: DocumentRow[];
  total: number;
  page: number;
  perPage: number;
}

const STATUS_CLASS: Record<string, string> = {
  APPROVED:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  NEEDS_REVISION:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  IN_REVIEW: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

const COLUMNS: Column<DocumentRow>[] = [
  {
    header: "File",
    accessor: (r) => (
      <div className="min-w-0">
        <p className="truncate text-foreground">{r.fileName}</p>
        {/* Without this a revision reads as an unrelated upload: the operator
            sees two rows and nothing saying one supersedes the other. */}
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
    header: "Review",
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
    header: "Type",
    accessor: (r) => r.appointment.appointmentType,
  },
  { header: "Uploaded by", accessor: (r) => <Badge variant="outline">{r.uploadedByRole}</Badge> },
  {
    header: "Uploaded",
    accessor: (r) => format(new Date(r.uploadedAt), "PP"),
  },
];

export function DocumentsClient({ orgId }: { orgId: string }) {
  // Page-level mirror of the API gate — previously this page had NO
  // guard and rendered an error shell for unauthorized roles (#audit F8).
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const searchParams = useSearchParams();
  const page = Number(searchParams?.get("page") ?? "1") || 1;

  const { data, isLoading, isError } = useQuery<DocumentsResponse>({
    enabled: allowed,
    queryKey: ["org-documents", orgId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/organizations/${orgId}/documents?page=${page}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <>
      <DashboardHeader
        title="Documents for review"
        subtitle="Documents attached to appointments under this organization, with the outcome of each review."
      />
      <DashboardContent>
        <ScopedListTable
          title="Org documents"
          isLoading={isLoading}
          isError={isError}
          items={data?.items ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          perPage={data?.perPage ?? 20}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          emptyMessage="No documents uploaded under this organization yet."
        />
      </DashboardContent>
    </>
  );
}
