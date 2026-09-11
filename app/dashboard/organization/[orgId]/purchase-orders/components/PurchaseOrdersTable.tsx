"use client";

/**
 * Table rendering for the PurchaseOrders dashboard.
 *
 * Pure presentational — parent owns query state, filter state, and
 * the edit/delete callback wiring. The table renders the rows it
 * receives and emits clicks back to the parent. Mutation buttons are
 * hidden when `canMutate` is false so a MANAGER session doesn't see
 * affordances they can't act on (the API still rejects from the
 * server side; this is the client-side mirror).
 */

import { FileText, Loader2, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";

import {
  STATUS_BADGE_CLASSNAME,
  fmtDate,
  fmtMoney,
} from "../utils/formatting";
import type { PoStatus, PurchaseOrderRow } from "../utils/types";

interface PurchaseOrdersTableProps {
  rows: PurchaseOrderRow[];
  isLoading: boolean;
  isError: boolean;
  canMutate: boolean;
  searchTerm: string;
  statusFilter: PoStatus | "ALL";
  onEdit: (po: PurchaseOrderRow) => void;
  onDelete: (po: PurchaseOrderRow) => void;
}

export function PurchaseOrdersTable({
  rows,
  isLoading,
  isError,
  canMutate,
  searchTerm,
  statusFilter,
  onEdit,
  onDelete,
}: PurchaseOrdersTableProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-sm text-red-600">
        Failed to load purchase orders. Try refreshing.
      </div>
    );
  }

  const empty = (
    <div className="text-center py-12 text-muted-foreground">
      <FileText className="h-10 w-10 mx-auto mb-3 text-muted-foreground/70" />
      <p className="text-sm">
        {searchTerm.trim()
          ? `No POs match “${searchTerm.trim()}”.`
          : statusFilter !== "ALL"
            ? `No ${statusFilter} POs.`
            : "No purchase orders yet."}
      </p>
      {canMutate && !searchTerm.trim() && statusFilter === "ALL" && (
        <p className="text-xs mt-2">
          Click <strong>New PO</strong> to register one issued by your
          AP team.
        </p>
      )}
    </div>
  );

  const columns: ResponsiveColumn<PurchaseOrderRow>[] = [
    {
      key: "poNumber",
      header: "PO #",
      primary: true,
      cell: (po) => (
        <span className="font-medium">
          {po.poNumber}
          {po.uploadedDocUrl && (
            <a
              href={po.uploadedDocUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-xs underline text-primary"
            >
              doc
            </a>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (po) => (
        <Badge
          variant="outline"
          className={STATUS_BADGE_CLASSNAME[po.status]}
        >
          {po.status}
        </Badge>
      ),
    },
    {
      key: "poDate",
      header: "PO date",
      className: "text-sm text-muted-foreground whitespace-nowrap",
      cell: (po) => fmtDate(po.poDate),
    },
    {
      key: "validUntil",
      header: "Valid until",
      className: "text-sm text-muted-foreground whitespace-nowrap",
      cell: (po) => (po.validUntil ? fmtDate(po.validUntil) : "—"),
    },
    {
      key: "total",
      header: "Total",
      className: "text-right text-sm tabular-nums",
      headClassName: "text-right",
      cell: (po) => fmtMoney(po.totalAmountPaise, po.currency),
    },
    {
      key: "remaining",
      header: "Remaining",
      className: "text-right text-sm tabular-nums",
      headClassName: "text-right",
      cell: (po) => fmtMoney(po.remainingAmountPaise, po.currency),
    },
    {
      key: "linked",
      header: "Linked",
      className: "text-center text-sm text-muted-foreground",
      headClassName: "text-center",
      cell: (po) =>
        po._count.contracts + po._count.invoices > 0 ? (
          <span
            title={`${po._count.contracts} contracts · ${po._count.invoices} invoices`}
          >
            {po._count.contracts}c · {po._count.invoices}i
          </span>
        ) : (
          <span className="text-muted-foreground/70">—</span>
        ),
    },
  ];

  return (
    <ResponsiveTable<PurchaseOrderRow>
      columns={columns}
      rows={rows}
      getRowId={(po) => po.id}
      empty={empty}
      rowActions={
        canMutate
          ? (po) => {
              const canDelete =
                po._count.contracts === 0 && po._count.invoices === 0;
              return (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(po)}
                    aria-label={`Edit PO ${po.poNumber}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canDelete}
                    title={
                      canDelete
                        ? "Delete PO"
                        : "Cannot delete — referenced by contracts or invoices. Cancel via edit."
                    }
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 disabled:opacity-30"
                    onClick={() => onDelete(po)}
                    aria-label={`Delete PO ${po.poNumber}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            }
          : undefined
      }
    />
  );
}
