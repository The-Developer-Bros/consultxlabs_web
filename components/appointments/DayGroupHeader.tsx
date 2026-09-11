"use client";

import { format, isToday, isTomorrow, isYesterday } from "date-fns";

export function dayGroupLabel(date: Date | null): string {
  if (!date) return "Unscheduled";
  if (isToday(date)) return `Today · ${format(date, "EEE, d MMM")}`;
  if (isTomorrow(date)) return `Tomorrow · ${format(date, "EEE, d MMM")}`;
  if (isYesterday(date)) return `Yesterday · ${format(date, "EEE, d MMM")}`;
  return format(date, "EEEE, d MMM yyyy");
}

export function DayGroupHeader({ date }: { date: Date | null }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
        {dayGroupLabel(date)}
      </p>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
