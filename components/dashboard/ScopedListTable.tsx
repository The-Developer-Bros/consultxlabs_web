"use client";

/**
 * ScopedListTable — generic table wrapper shared by dashboard list pages
 * (originally the org list pages from #674 / B1-hybrid: appointments,
 * trials, documents, recordings; now also the personal
 * dashboards). Each consumer passes its own column config + row renderer;
 * this component handles the loading state, empty state, pagination, and
 * pages-of-X count.
 *
 * Deliberately minimal — no virtualization, no sorting in v1. Org
 * dashboards rarely have >a few thousand rows; we ship pagination via
 * query params and revisit if a customer hits the ceiling.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface Column<T> {
  header: string;
  accessor: (row: T) => React.ReactNode;
}

export interface ScopedListTableProps<T> {
  title: string;
  description?: string;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  items: T[];
  total: number;
  page: number;
  perPage: number;
  columns: Column<T>[];
  emptyMessage?: string;
  rowKey: (row: T) => string;
  /** Optional toolbar (filters etc.) rendered above the table. */
  toolbar?: React.ReactNode;
}

export function ScopedListTable<T>({
  title,
  description,
  isLoading,
  isError,
  errorMessage,
  items,
  total,
  page,
  perPage,
  columns,
  emptyMessage = "No records found.",
  rowKey,
  toolbar,
}: ScopedListTableProps<T>) {
  const searchParams = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const buildPageHref = (newPage: number): string => {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    sp.set("page", String(newPage));
    return `?${sp.toString()}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </CardHeader>
      <CardContent>
        {toolbar && <div className="mb-4">{toolbar}</div>}

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            {errorMessage ?? "Failed to load. Please retry."}
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  {columns.map((c) => (
                    <th key={c.header} className="px-3 py-2 font-medium">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={rowKey(row)}
                    className="border-b last:border-0 hover:bg-muted/40"
                  >
                    {columns.map((c) => (
                      <td key={c.header} className="px-3 py-2 align-top">
                        {c.accessor(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading && !isError && total > 0 && (
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {(page - 1) * perPage + 1}–
              {Math.min(page * perPage, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" disabled={page <= 1}>
                <Link href={buildPageHref(Math.max(1, page - 1))}>Prev</Link>
              </Button>
              <Button
                asChild
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
              >
                <Link href={buildPageHref(Math.min(totalPages, page + 1))}>
                  Next
                </Link>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
