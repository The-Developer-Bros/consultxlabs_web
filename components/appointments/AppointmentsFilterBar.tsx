"use client";

import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { AppointmentKind } from "@/lib/appointments/view-model";
import { cn } from "@/utils/tailwind";

export type TypeFilter =
  | "ALL"
  | "CONSULTATION"
  | "SUBSCRIPTION"
  | "TRIAL"
  | "WEBINAR"
  | "CLASS";

export function matchesTypeFilter(
  kind: AppointmentKind,
  filter: TypeFilter,
): boolean {
  if (filter === "ALL") return true;
  return kind === filter;
}

const TYPE_CHIPS: Array<{ value: TypeFilter; label: string }> = [
  { value: "ALL", label: "All types" },
  { value: "CONSULTATION", label: "Consultations" },
  { value: "SUBSCRIPTION", label: "Subscriptions" },
  { value: "TRIAL", label: "Trials" },
  { value: "WEBINAR", label: "Webinars" },
  { value: "CLASS", label: "Classes" },
];

export interface DateRange {
  from: string;
  to: string;
}

interface AppointmentsFilterBarProps {
  typeFilter: TypeFilter;
  onTypeChange: (value: TypeFilter) => void;
  search: string;
  onSearchChange: (value: string) => void;
  dateRange: DateRange;
  onDateRangeChange: (value: DateRange) => void;
  /** Role-specific filter control rendered at the end of the bar. */
  orgFilterSlot?: ReactNode;
}

export function AppointmentsFilterBar({
  typeFilter,
  onTypeChange,
  search,
  onSearchChange,
  dateRange,
  onDateRangeChange,
  orgFilterSlot,
}: AppointmentsFilterBarProps) {
  const hasRange = dateRange.from !== "" || dateRange.to !== "";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1">
        {TYPE_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            onClick={() => onTypeChange(chip.value)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              typeFilter === chip.value
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30",
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by name or plan…"
            className="h-9 pl-8 text-sm"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={dateRange.from}
            onChange={(e) =>
              onDateRangeChange({ ...dateRange, from: e.target.value })
            }
            // Wider and tighter than the default Input: at 140px with px-3,
            // "dd/mm/yyyy" plus Chrome's own calendar-picker indicator
            // overflows the content box and the icon sits on the border.
            className="h-9 w-[158px] px-2.5 text-xs"
            aria-label="From date"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <Input
            type="date"
            value={dateRange.to}
            onChange={(e) =>
              onDateRangeChange({ ...dateRange, to: e.target.value })
            }
            // Wider and tighter than the default Input: at 140px with px-3,
            // "dd/mm/yyyy" plus Chrome's own calendar-picker indicator
            // overflows the content box and the icon sits on the border.
            className="h-9 w-[158px] px-2.5 text-xs"
            aria-label="To date"
          />
          {hasRange && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => onDateRangeChange({ from: "", to: "" })}
              aria-label="Clear date range"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {orgFilterSlot && <div className="ml-auto">{orgFilterSlot}</div>}
      </div>
    </div>
  );
}
