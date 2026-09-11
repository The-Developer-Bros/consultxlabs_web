"use client";

import { useMemo, useState } from "react";
import { CalendarX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dashboard/DataCard";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type {
  AppointmentBucket,
  AppointmentVM,
} from "@/lib/appointments/view-model";
import { AppointmentRow } from "./AppointmentRow";
import { DayGroupHeader } from "./DayGroupHeader";

const PAGE_SIZE = 30;

interface DayGroup {
  key: string;
  date: Date | null;
  vms: AppointmentVM[];
}

function dayKey(date: Date | null): string {
  if (!date) return "unscheduled";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Day-grouped ordering per bucket:
 *  - upcoming / needsAction: soonest first, undated ("Unscheduled") first in
 *    needsAction (they need the user), last otherwise.
 *  - past / cancelled: most recent first.
 *  - all: future days ascending (today → later), then past days descending —
 *    "what's next, then history".
 */
function orderVms(
  vms: AppointmentVM[],
  bucket: AppointmentBucket | "all",
  now: Date,
): AppointmentVM[] {
  const time = (vm: AppointmentVM) => vm.nextAt?.getTime() ?? null;
  const sorted = [...vms];

  if (bucket === "past" || bucket === "cancelled") {
    return sorted.sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0));
  }

  if (bucket === "all") {
    const nowMs = now.getTime();
    const future = sorted.filter((vm) => (time(vm) ?? -Infinity) >= nowMs);
    const dateless = sorted.filter((vm) => time(vm) === null);
    const past = sorted.filter(
      (vm) => time(vm) !== null && (time(vm) as number) < nowMs,
    );
    future.sort((a, b) => (time(a) ?? 0) - (time(b) ?? 0));
    past.sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0));
    return [...future, ...dateless, ...past];
  }

  const undatedFirst = bucket === "needsAction";
  return sorted.sort((a, b) => {
    const ta = time(a);
    const tb = time(b);
    if (ta === null && tb === null) return 0;
    if (ta === null) return undatedFirst ? -1 : 1;
    if (tb === null) return undatedFirst ? 1 : -1;
    return ta - tb;
  });
}

function groupByDay(vms: AppointmentVM[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const vm of vms) {
    const key = dayKey(vm.nextAt);
    if (!current || current.key !== key) {
      current = { key, date: vm.nextAt, vms: [] };
      groups.push(current);
    }
    current.vms.push(vm);
  }
  return groups;
}

interface AppointmentListProps {
  vms: AppointmentVM[];
  bucket: AppointmentBucket | "all";
  adapter: AppointmentActionAdapter;
  resolveSponsoredLabel?: (orgId: string | null) => string | null;
  onOpen?: (vm: AppointmentVM) => void;
  /** Rows are only clickable when this returns true (default: all). */
  canOpen?: (vm: AppointmentVM) => boolean;
  highlightedId?: string | null;
  registerRowRef?: (id: string, el: HTMLDivElement | null) => void;
  emptyTitle: string;
  emptyDescription: string;
}

export function AppointmentList({
  vms,
  bucket,
  adapter,
  resolveSponsoredLabel,
  onOpen,
  canOpen,
  highlightedId,
  registerRowRef,
  emptyTitle,
  emptyDescription,
}: AppointmentListProps) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const ordered = useMemo(
    () => orderVms(vms, bucket, new Date()),
    [vms, bucket],
  );
  const visible = ordered.slice(0, visibleCount);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const hiddenCount = ordered.length - visible.length;

  if (ordered.length === 0) {
    return (
      <EmptyState
        icon={CalendarX}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <DayGroupHeader date={group.date} />
          {group.vms.map((vm) => (
            <AppointmentRow
              key={vm.id}
              vm={vm}
              adapter={adapter}
              sponsoredLabel={resolveSponsoredLabel?.(vm.organizationId) ?? null}
              onOpen={!canOpen || canOpen(vm) ? onOpen : undefined}
              highlighted={highlightedId === vm.id}
              registerRef={
                registerRowRef ? (el) => registerRowRef(vm.id, el) : undefined
              }
            />
          ))}
        </div>
      ))}
      {hiddenCount > 0 && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          >
            Load {Math.min(hiddenCount, PAGE_SIZE)} more ({hiddenCount}{" "}
            remaining)
          </Button>
        </div>
      )}
    </div>
  );
}
