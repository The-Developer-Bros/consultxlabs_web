"use client";

import { useMemo, useState } from "react";
import {
  addMonths,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isDeadSlot } from "@/lib/appointments/slots";
import type {
  AppointmentKind,
  AppointmentVM,
} from "@/lib/appointments/view-model";
import { cn } from "@/utils/tailwind";

/**
 * Shared interactive month calendar over AppointmentVM[]. Every session
 * slot renders as a clickable pill on its day; clicking opens the row's
 * Sheet via onSelect. Replaces the consultee's click-inert bespoke grid.
 */

const KIND_DOT: Record<AppointmentKind, string> = {
  CONSULTATION: "bg-blue-500",
  SUBSCRIPTION: "bg-violet-500",
  WEBINAR: "bg-emerald-500",
  CLASS: "bg-orange-500",
  TRIAL: "bg-pink-500",
};

interface CalendarEvent {
  vm: AppointmentVM;
  start: Date;
  isTentative: boolean;
  isPast: boolean;
}

interface AppointmentCalendarProps {
  vms: AppointmentVM[];
  onSelect: (vm: AppointmentVM) => void;
}

export function AppointmentCalendar({
  vms,
  onSelect,
}: AppointmentCalendarProps) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));

  const events = useMemo<CalendarEvent[]>(() => {
    const now = Date.now();
    return vms
      .filter((vm) => vm.bucket !== "cancelled")
      .flatMap((vm) =>
        vm.sessions
          .filter((s) => !isDeadSlot(s))
          .map((s) => ({
            vm,
            start: s.startsAt,
            isTentative: s.isTentative,
            isPast: (s.endsAt ?? s.startsAt).getTime() < now,
          })),
      );
  }, [vms]);

  // 42-cell grid: pad to the leading Sunday, always render 6 weeks.
  const cells = useMemo(() => {
    const first = startOfMonth(month);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + i);
      return date;
    });
  }, [month]);

  // #997 secondary findings — `eventsOf` used to re-filter+sort the whole
  // `events` array once per grid cell (42x per render). Pre-index once into
  // a Map keyed by local day, so each cell is an O(1) lookup.
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const key = format(event.start, "yyyy-MM-dd");
      const bucket = map.get(key);
      if (bucket) bucket.push(event);
      else map.set(key, [event]);
    }
    map.forEach((bucket) => {
      bucket.sort((a, b) => a.start.getTime() - b.start.getTime());
    });
    return map;
  }, [events]);

  const eventsOf = (date: Date) =>
    eventsByDay.get(format(date, "yyyy-MM-dd")) ?? [];

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-foreground">
          {format(month, "MMMM yyyy")}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMonth((m) => subMonths(m, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => setMonth(startOfMonth(new Date()))}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-border">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            className="py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((date) => {
          const dayEvents = eventsOf(date);
          const inMonth = isSameMonth(date, month);
          return (
            <div
              key={date.toISOString()}
              className={cn(
                "min-h-[86px] border-b border-r border-border p-1 last:border-r-0",
                !inMonth && "bg-muted/40",
              )}
            >
              <div
                className={cn(
                  "text-[11px] font-medium mb-1 h-5 w-5 flex items-center justify-center rounded-full",
                  isToday(date)
                    ? "bg-foreground text-background"
                    : inMonth
                      ? "text-foreground"
                      : "text-muted-foreground/60",
                )}
              >
                {date.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((event, i) => (
                  <button
                    key={`${event.vm.id}-${event.start.getTime()}-${i}`}
                    type="button"
                    onClick={() => onSelect(event.vm)}
                    title={`${format(event.start, "h:mm a")} · ${event.vm.title}${event.isTentative ? " (awaiting confirmation)" : ""}`}
                    className={cn(
                      "w-full flex items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] leading-tight transition-colors",
                      "bg-muted hover:bg-muted/70 text-foreground",
                      event.isPast && "opacity-50",
                      event.isTentative && "border border-dashed border-border",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        KIND_DOT[event.vm.kind],
                      )}
                    />
                    <span className="truncate">
                      {format(event.start, "h:mma").toLowerCase()}{" "}
                      {event.vm.title}
                    </span>
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <button
                    type="button"
                    onClick={() => onSelect(dayEvents[3].vm)}
                    className="w-full text-left px-1 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    +{dayEvents.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-t border-border">
        {(
          Object.entries(KIND_DOT) as Array<[AppointmentKind, string]>
        ).map(([kind, dot]) => (
          <span
            key={kind}
            className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", dot)} />
            {kind.charAt(0) + kind.slice(1).toLowerCase()}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="h-2.5 w-4 rounded border border-dashed border-border" />
          Awaiting confirmation
        </span>
      </div>
    </div>
  );
}
