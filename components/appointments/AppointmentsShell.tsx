"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, List } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import { resolveSponsoringOrgName } from "@/lib/labels/session-labels";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  CONSULTEE_JOIN_WINDOW_MS,
} from "@/lib/appointments/slots";
import type {
  AppointmentBucket,
  AppointmentVM,
} from "@/lib/appointments/view-model";
import { cn } from "@/utils/tailwind";
import { AppointmentCalendar } from "./AppointmentCalendar";
import { AppointmentList } from "./AppointmentList";
import { AppointmentSheet } from "./AppointmentSheet";
import {
  AppointmentsFilterBar,
  matchesTypeFilter,
  type DateRange,
  type TypeFilter,
} from "./AppointmentsFilterBar";
import { NextUpHero, type HeroStat } from "./NextUpHero";

type TabValue = AppointmentBucket | "all";

// "All" leads, matching AppointmentsFilterBar's "All types" chip: one rule for
// where the everything-option sits, so the two rows share a left edge. Order
// here is presentation only — `initialTab` switches on the value, and the
// default selection is still Upcoming.
const TABS: Array<{ value: TabValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "upcoming", label: "Upcoming" },
  { value: "needsAction", label: "Needs action" },
  { value: "past", label: "Past" },
  { value: "cancelled", label: "Cancelled" },
];

const EMPTY_COPY: Record<TabValue, { title: string; description: string }> = {
  upcoming: {
    title: "No upcoming appointments",
    description: "Sessions you book will show up here.",
  },
  needsAction: {
    title: "Nothing needs your attention",
    description:
      "Payments, approvals, and scheduling tasks will collect here.",
  },
  past: {
    title: "No past appointments",
    description: "Completed sessions will appear here.",
  },
  cancelled: {
    title: "No cancelled appointments",
    description: "Cancelled or rejected bookings will appear here.",
  },
  all: {
    title: "No appointments found",
    description: "Try clearing the filters, or book a session to get started.",
  },
};

/** Legacy deep-link values from the old consultee tabs. */
function initialTab(param: string | null): TabValue {
  switch (param) {
    case "past":
      return "past";
    case "cancelled":
      return "cancelled";
    case "all":
    case "history": // old BookingHistoryTab deep-links land on All
      return "all";
    case "needsAction":
      return "needsAction";
    default:
      return "upcoming";
  }
}

/**
 * A tab that is NOT a bucket of this shell's appointment VMs, appended after
 * the five standard ones and rendering its own content.
 *
 * Exists so the consultant dashboard can host Trials here — ADR 19 folded
 * trials onto Appointments on the org side because "a trial IS an appointment",
 * and this is the personal half of that move. It is opt-in rather than a sixth
 * entry in `TABS` because the consultee shares this shell and has no trials
 * concept; passing nothing leaves that side byte-identical.
 */
export interface AppointmentsExtraTab {
  value: string;
  label: string;
  content: ReactNode;
  /** Rendered beside the label like the bucket counts. */
  count?: number;
}

interface AppointmentsShellProps {
  vms: AppointmentVM[];
  adapter: AppointmentActionAdapter;
  orgFilterSlot?: ReactNode;
  /** Side-query error/retry banners (consultant trials/unscheduled). */
  notices?: ReactNode;
  /** Row id (VM id) to flash + scroll to (consultant ?highlight= deep-link). */
  highlightedId?: string | null;
  extraTabs?: AppointmentsExtraTab[];
}

export function AppointmentsShell({
  vms,
  adapter,
  orgFilterSlot,
  notices,
  highlightedId = null,
  extraTabs = [],
}: AppointmentsShellProps) {
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const [tab, setTab] = useState<TabValue | string>(() => {
    const param = searchParams?.get("tab") ?? null;
    // An extra tab's own value wins over the bucket fallback, so
    // `?tab=trials` deep-links land on it instead of silently on Upcoming.
    if (param && extraTabs.some((t) => t.value === param)) return param;
    return initialTab(param);
  });
  // Legacy consultee ?tab=calendar deep-links land on the calendar view.
  const [view, setView] = useState<"list" | "calendar">(() =>
    searchParams?.get("tab") === "calendar" ? "calendar" : "list",
  );
  const [sheetVm, setSheetVm] = useState<AppointmentVM | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>({ from: "", to: "" });
  const [flashId, setFlashId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Highlight deep-link: flash + scroll the row once it exists in the DOM.
  useEffect(() => {
    if (!highlightedId) return;
    setFlashId(highlightedId);
    const scrollTimer = setTimeout(() => {
      rowRefs.current
        .get(highlightedId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    const clearTimer = setTimeout(() => setFlashId(null), 3000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [highlightedId]);

  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoredLabel = (orgId: string | null) =>
    resolveSponsoringOrgName(orgId, orgMemberships);

  // Chip/search/date filters apply to every tab (counts included) so the tab
  // numbers always describe what the user would see on click.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromMs = dateRange.from ? new Date(dateRange.from).getTime() : null;
    const toMs = dateRange.to
      ? new Date(dateRange.to).getTime() + 86_400_000 - 1
      : null;
    return vms.filter((vm) => {
      if (!matchesTypeFilter(vm.kind, typeFilter)) return false;
      if (
        q &&
        !vm.title.toLowerCase().includes(q) &&
        !vm.counterpart.name.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (fromMs !== null || toMs !== null) {
        const t = vm.nextAt?.getTime();
        if (t === undefined) return false;
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      return true;
    });
  }, [vms, typeFilter, search, dateRange]);

  const byBucket = useMemo(() => {
    const map: Record<AppointmentBucket, AppointmentVM[]> = {
      upcoming: [],
      needsAction: [],
      past: [],
      cancelled: [],
    };
    for (const vm of filtered) map[vm.bucket].push(vm);
    return map;
  }, [filtered]);

  const countOf = (value: TabValue) =>
    value === "all" ? filtered.length : byBucket[value].length;

  // An extra tab owns its whole panel: the filter bar and the calendar toggle
  // both describe appointment VMs and do not apply to content this shell
  // doesn't own. The hero stays — "what's next" is page-level context, and
  // dropping it would shift the layout on every tab change.
  const onExtraTab = extraTabs.some((t) => t.value === tab);

  // Hero reads the UNFILTERED list — it answers "what's next", not "what's
  // next among the current filters". A row only qualifies while its anchor
  // session hasn't ended (live sessions stay; an elapsed pending booking in
  // Needs action is not "next").
  const heroVm = useMemo(() => {
    const now = Date.now();
    const candidates = vms.filter((vm) => {
      if (vm.bucket !== "upcoming" && vm.bucket !== "needsAction") return false;
      if (!vm.nextAt) return false;
      const anchor = vm.sessions.find(
        (s) => s.startsAt.getTime() === vm.nextAt?.getTime(),
      );
      const end =
        anchor?.endsAt?.getTime() ?? vm.nextAt.getTime() + 60 * 60 * 1000;
      return end >= now;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) =>
      (a.nextAt as Date).getTime() <= (b.nextAt as Date).getTime() ? a : b,
    );
  }, [vms]);

  const stats: HeroStat[] = useMemo(() => {
    const weekEnd = Date.now() + 7 * 86_400_000;
    const thisWeek = vms.filter(
      (vm) =>
        vm.bucket !== "cancelled" &&
        vm.bucket !== "past" &&
        vm.nextAt !== null &&
        vm.nextAt.getTime() <= weekEnd &&
        vm.nextAt.getTime() >= Date.now() - 60 * 60 * 1000,
    ).length;
    const needsAction = vms.filter((vm) => vm.bucket === "needsAction").length;
    return [
      { value: thisWeek, label: "sessions this week" },
      { value: needsAction, label: "need action" },
    ];
  }, [vms]);

  // Row/hero/calendar click → the summary Sheet. Track by id so the sheet
  // re-renders fresh data after a mutation invalidates the list query.
  const openVm = (vm: AppointmentVM) => setSheetVm(vm);
  const activeSheetVm = sheetVm
    ? (vms.find((vm) => vm.id === sheetVm.id) ?? null)
    : null;
  const joinWindowMs =
    adapter.role === "consultant"
      ? CONSULTANT_JOIN_WINDOW_MS
      : CONSULTEE_JOIN_WINDOW_MS;

  return (
    <div className="space-y-5">
      <NextUpHero vm={heroVm} adapter={adapter} stats={stats} onOpen={openVm} />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList className={cn("flex-wrap h-auto", view === "calendar" && "opacity-60")}>
            {TABS.map(({ value, label }) => (
              <TabsTrigger key={value} value={value} className="gap-1.5">
                {label}
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {countOf(value)}
                </span>
              </TabsTrigger>
            ))}
            {extraTabs.map(({ value, label, count }) => (
              <TabsTrigger key={value} value={value} className="gap-1.5">
                {label}
                {count !== undefined && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* List / calendar view toggle */}
          <div
            className={cn(
              "flex items-center rounded-lg border border-border bg-card p-0.5",
              onExtraTab && "hidden",
            )}
          >
            {(
              [
                { value: "list", label: "List", icon: List },
                { value: "calendar", label: "Calendar", icon: CalendarDays },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setView(value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  view === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === value}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {!onExtraTab && (
          <div className="mt-4">
            <AppointmentsFilterBar
              typeFilter={typeFilter}
              onTypeChange={setTypeFilter}
              search={search}
              onSearchChange={setSearch}
              dateRange={dateRange}
              onDateRangeChange={setDateRange}
              orgFilterSlot={orgFilterSlot}
            />
          </div>
        )}

        {notices && !onExtraTab && <div className="mt-4">{notices}</div>}

        {extraTabs.map(({ value, content }) => (
          <TabsContent key={value} value={value} className="mt-4">
            {content}
          </TabsContent>
        ))}

        {onExtraTab ? null : view === "calendar" ? (
          <div className="mt-4">
            <AppointmentCalendar vms={filtered} onSelect={openVm} />
          </div>
        ) : (
          TABS.map(({ value }) => (
            <TabsContent key={value} value={value} className="mt-4">
              <AppointmentList
                vms={value === "all" ? filtered : byBucket[value]}
                bucket={value}
                adapter={adapter}
                resolveSponsoredLabel={resolveSponsoredLabel}
                onOpen={openVm}
                highlightedId={flashId}
                registerRowRef={(id, el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                emptyTitle={EMPTY_COPY[value].title}
                emptyDescription={EMPTY_COPY[value].description}
              />
            </TabsContent>
          ))
        )}
      </Tabs>

      <AppointmentSheet
        vm={activeSheetVm}
        onOpenChange={(open) => !open && setSheetVm(null)}
        adapter={adapter}
        sponsoredLabel={
          activeSheetVm ? resolveSponsoredLabel(activeSheetVm.organizationId) : null
        }
        joinWindowMs={joinWindowMs}
      />

      {adapter.renderDialogs()}
    </div>
  );
}
