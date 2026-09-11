"use client";

import * as React from "react";
import { cn } from "@/utils/tailwind";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

export interface ResponsiveColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** Used as the card title on mobile. Mark exactly one column primary. */
  primary?: boolean;
  /** Omit this column from the mobile card view. */
  hideOnCard?: boolean;
  /** Label beside the value on the mobile card; defaults to `header`. */
  cardLabel?: React.ReactNode;
  className?: string;
  headClassName?: string;
}

export interface ResponsiveTableProps<T> {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  allSelected?: boolean;
  rowActions?: (row: T) => React.ReactNode;
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  /** Below this width rows render as stacked cards. Default "md". */
  breakpoint?: "sm" | "md" | "lg";
  className?: string;
}

// Static class pairs so Tailwind's JIT can see them.
const SWITCH: Record<string, { table: string; cards: string }> = {
  sm: { table: "hidden sm:block", cards: "grid gap-3 sm:hidden" },
  md: { table: "hidden md:block", cards: "grid gap-3 md:hidden" },
  lg: { table: "hidden lg:block", cards: "grid gap-3 lg:hidden" },
};

export function ResponsiveTable<T>({
  columns,
  rows,
  getRowId,
  selectable,
  selectedIds,
  onToggle,
  onToggleAll,
  allSelected,
  rowActions,
  onRowClick,
  empty,
  breakpoint = "md",
  className,
}: ResponsiveTableProps<T>) {
  const sw = SWITCH[breakpoint];
  const isSelected = (id: string) => selectedIds?.has(id) ?? false;

  if (rows.length === 0 && empty) {
    return <div className={className}>{empty}</div>;
  }

  const primary = columns.find((c) => c.primary);
  const cardColumns = columns.filter((c) => !c.primary && !c.hideOnCard);

  return (
    <div className={className}>
      {/* Desktop / tablet: real table */}
      <div className={sw.table}>
        <Table>
          <TableHeader>
            <TableRow>
              {selectable && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={() => onToggleAll?.()}
                    aria-label="Select all rows"
                  />
                </TableHead>
              )}
              {columns.map((col) => (
                <TableHead key={col.key} className={col.headClassName}>
                  {col.header}
                </TableHead>
              ))}
              {rowActions && <TableHead className="w-10 text-right" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const id = getRowId(row);
              return (
                <TableRow
                  key={id}
                  data-state={isSelected(id) ? "selected" : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={onRowClick ? "cursor-pointer" : undefined}
                >
                  {selectable && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected(id)}
                        onCheckedChange={() => onToggle?.(id)}
                        aria-label="Select row"
                      />
                    </TableCell>
                  )}
                  {columns.map((col) => (
                    <TableCell key={col.key} className={col.className}>
                      {col.cell(row)}
                    </TableCell>
                  ))}
                  {rowActions && (
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {rowActions(row)}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: stacked cards */}
      <ul className={cn(sw.cards, "list-none")}>
        {rows.map((row) => {
          const id = getRowId(row);
          return (
            <li key={id}>
              <Card
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "p-4 shadow-elevation-1",
                  isSelected(id) && "ring-2 ring-ring",
                  onRowClick && "cursor-pointer active:scale-[0.99]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {selectable && (
                      <span
                        className="pt-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected(id)}
                          onCheckedChange={() => onToggle?.(id)}
                          aria-label="Select row"
                        />
                      </span>
                    )}
                    {primary && (
                      <div className="min-w-0 text-sm font-medium text-foreground">
                        {primary.cell(row)}
                      </div>
                    )}
                  </div>
                  {rowActions && (
                    <span
                      className="-mr-2 -mt-1 shrink-0"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {rowActions(row)}
                    </span>
                  )}
                </div>

                {cardColumns.length > 0 && (
                  <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    {cardColumns.map((col) => (
                      <React.Fragment key={col.key}>
                        <dt className="text-muted-foreground">
                          {col.cardLabel ?? col.header}
                        </dt>
                        <dd className="min-w-0 text-right text-foreground">
                          {col.cell(row)}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
