"use client";

/**
 * Purchase Orders dashboard for India AP 3-way-match workflows.
 *
 * Thin orchestrator: state for filters + dialog open/close, plus the
 * list query. All UI primitives live in `./components/*` and shared
 * helpers in `./utils/*`. Page-level role gate mirrors the API
 * (MANAGER+canSponsor for read; BILLING_ADMIN-or-OWNER for mutations) —
 * the server-side enforcement is still authoritative.
 */

import { use, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { useOrgRole, useRequireOrgAccess } from "../useOrgRole";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { CreatePurchaseOrderDialog } from "./components/CreatePurchaseOrderDialog";
import { EditPurchaseOrderDialog } from "./components/EditPurchaseOrderDialog";
import { DeletePurchaseOrderDialog } from "./components/DeletePurchaseOrderDialog";
import {
  PurchaseOrderStatCards,
  type PurchaseOrderStats,
} from "./components/PurchaseOrderStatCards";
import { PurchaseOrdersTable } from "./components/PurchaseOrdersTable";
import { fetchPurchaseOrders } from "./utils/api";
import type { PoStatus, PurchaseOrderRow } from "./utils/types";

export default function PurchaseOrdersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  // #1132 — PO mutations are `purchaseOrders.manage` (OWNER + BILLING_ADMIN).
  // MAINTAINER previously saw create/edit/delete and ate a 403 on submit.
  const { can } = useOrgRole(orgId);
  const { allowed } = useRequireOrgAccess(orgId, {
    permission: "purchaseOrders.read",
    canSponsor: true,
  });

  const [statusFilter, setStatusFilter] = useState<PoStatus | "ALL">("ALL");
  const [searchTerm, setSearchTerm] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PurchaseOrderRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PurchaseOrderRow | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["org-purchase-orders", orgId, statusFilter],
    // Filter/page live in the key, so each value is its own query. Without
    // this, switching to one not yet fetched dropped `data` to undefined and
    // re-showed the loading branch. Same fix as #346 on the appointments list.
    placeholderData: keepPreviousData,
    queryFn: () => fetchPurchaseOrders(orgId, statusFilter),
    enabled: allowed,
  });

  // BILLING_ADMIN gate is enforced server-side; the client check uses
  // MAINTAINER-or-higher so OWNER and BILLING_ADMIN both pass without
  // the page reaching into the disjunction rules. A MANAGER session
  // never sees the affordances.
  const canMutate = can("purchaseOrders.manage");

  const rows = useMemo(() => {
    const data = list.data?.data ?? [];
    if (!searchTerm.trim()) return data;
    const needle = searchTerm.trim().toLowerCase();
    return data.filter((po) => po.poNumber.toLowerCase().includes(needle));
  }, [list.data, searchTerm]);

  const stats: PurchaseOrderStats = useMemo(() => {
    const data = list.data?.data ?? [];
    let activeCount = 0;
    let totalCommittedINR = 0;
    let totalRemainingINR = 0;
    for (const po of data) {
      if (po.status === "ACTIVE") {
        activeCount += 1;
        // Forex POs excluded from rollup — mixing currencies in a single
        // sum is misleading. The stat-card labels say "(INR only)".
        if (po.currency === "INR") {
          totalCommittedINR += po.totalAmountPaise;
          totalRemainingINR += po.remainingAmountPaise;
        }
      }
    }
    return {
      total: data.length,
      activeCount,
      totalCommittedINR,
      totalRemainingINR,
    };
  }, [list.data]);

  if (!allowed) return null;

  return (
    <>
      <DashboardHeader
        title="Purchase Orders"
        subtitle="India AP 3-way-match workflow. POs back contracts and invoices; mark CANCELLED to retire when no longer in use."
        actions={
          canMutate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> New PO
            </Button>
          )
        }
      />

      <DashboardContent>
        <PurchaseOrderStatCards stats={stats} />

        <Card className="mt-4">
          <CardHeader>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <CardTitle className="text-base">
                  {list.isLoading
                    ? "Loading…"
                    : `${rows.length} purchase order${rows.length === 1 ? "" : "s"}`}
                </CardTitle>
                <CardDescription>
                  Caller-issued PO numbers; uniqueness enforced per org.
                  POs with attached contracts or invoices can only be
                  CANCELLED, not deleted.
                </CardDescription>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <div className="w-40">
                  <Select
                    value={statusFilter}
                    onValueChange={(v) =>
                      setStatusFilter(v as PoStatus | "ALL")
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">All statuses</SelectItem>
                      <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                      <SelectItem value="CLOSED">CLOSED</SelectItem>
                      <SelectItem value="CANCELLED">CANCELLED</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-48">
                  <Input
                    placeholder="Search PO number…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <PurchaseOrdersTable
              rows={rows}
              isLoading={list.isLoading}
              isError={list.isError}
              canMutate={canMutate}
              searchTerm={searchTerm}
              statusFilter={statusFilter}
              onEdit={(po) => {
                setActionError(null);
                setEditTarget(po);
              }}
              onDelete={(po) => {
                setActionError(null);
                setDeleteTarget(po);
              }}
            />
            {actionError && (
              <p className="mt-3 text-sm text-red-600">{actionError}</p>
            )}
          </CardContent>
        </Card>
      </DashboardContent>

      <CreatePurchaseOrderDialog
        orgId={orgId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      <EditPurchaseOrderDialog
        orgId={orgId}
        po={editTarget}
        open={!!editTarget}
        onOpenChange={(v) => {
          if (!v) setEditTarget(null);
        }}
      />

      <DeletePurchaseOrderDialog
        orgId={orgId}
        po={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onError={(msg) => setActionError(msg)}
      />
    </>
  );
}
