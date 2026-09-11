"use client";

import { useMemo } from "react";
import { Library, Archive, Undo2, Loader2 } from "lucide-react";

import { EmptyState } from "@/components/dashboard/DataCard";
import { Button } from "@/components/ui/button";
import {
  ResponsiveTable,
  type ResponsiveColumn,
} from "@/components/ui/responsive-table";
import { formatCurrencyAmount } from "@/utils/formatting";

import type { CatalogRow, Kind } from "./types";

const VISIBILITY_LABEL: Record<CatalogRow["visibility"], string> = {
  PUBLIC: "Public",
  ORG_ONLY: "Members only",
  ORG_AND_PUBLIC: "Public + members",
};

/**
 * One kind's table.
 *
 * Split out of `CatalogClient` for the reason `MembersTabs` and `SettingsTabs`
 * already pass component references rather than inline markup: `UrlTabs` writes
 * the active tab through `router.replace`, and Next 15's App Router re-renders
 * the tree via `useSearchParams` reactivity even with `{ scroll: false }` —
 * documented at `app/explore/hooks/useUrlSyncedFilters.ts:34`. When that
 * re-render lands, a tab body that is an element reference costs almost nothing
 * to reconcile, whereas the previous inline `renderList(...)` calls rebuilt
 * BOTH kinds' full row sets, columns array and cell closures on every tab
 * switch. Radix unmounts the inactive panel, so only the visible kind's rows
 * are built now.
 *
 * The router-level cause is filed separately — this removes the amplifier that
 * made the catalog the worst-hit consumer of it.
 */
export function CatalogPanel({
  kind,
  rows,
  isLoading,
  error,
  onToggleArchive,
  isMutating,
}: Readonly<{
  kind: Kind;
  rows: CatalogRow[];
  isLoading: boolean;
  error: unknown;
  onToggleArchive: (planId: string, restore: boolean) => void;
  isMutating: boolean;
}>) {
  // Memoized so the array and its cell closures survive re-renders that do not
  // change the handler — previously reallocated on every call, twice per render.
  const columns = useMemo<ResponsiveColumn<CatalogRow>[]>(
    () => [
      {
        key: "title",
        header: "Offering",
        primary: true,
        cell: (r) => <span className="font-medium">{r.title}</span>,
      },
      {
        key: "price",
        header: "Price",
        cell: (r) => formatCurrencyAmount(Number(r.price), "INR"),
      },
      {
        key: "visibility",
        header: "Visibility",
        cell: (r) => VISIBILITY_LABEL[r.visibility],
      },
      {
        key: "seats",
        header: "Seats",
        cell: (r) => r.maxParticipants,
      },
      {
        key: "actions",
        header: "",
        hideOnCard: true,
        cell: (r) => {
          const archived = r.archivedAt !== null;
          return (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${archived ? "Restore" : "Withdraw"} ${r.title}`}
              title={
                archived
                  ? "Put back on sale"
                  : "Withdraw from sale. Existing bookings are unaffected."
              }
              disabled={isMutating}
              onClick={() => onToggleArchive(r.id, archived)}
            >
              {archived ? (
                <Undo2 className="h-4 w-4" />
              ) : (
                <Archive className="h-4 w-4" />
              )}
            </Button>
          );
        },
      },
    ],
    [onToggleArchive, isMutating],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading the catalog…
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={Library}
        title="Couldn't load the catalog"
        description={error instanceof Error ? error.message : undefined}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Library}
        title={`No ${kind === "WEBINAR" ? "webinars" : "classes"} yet`}
        description="Offerings you publish here are owned by the organization and delivered by one of its experts."
      />
    );
  }

  return (
    <ResponsiveTable columns={columns} rows={rows} getRowId={(r) => r.id} />
  );
}
