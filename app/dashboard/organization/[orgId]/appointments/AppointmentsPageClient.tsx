"use client";

/**
 * Org-wide appointments feed — the `?scope=everyone` half of the org
 * Appointments page. `operations.read` at the org. Calls
 * `/api/organizations/[orgId]/appointments`, which is forced to
 * scope=org:<orgId> server-side and auth-gates via `requireOrgAccess`.
 *
 * This table used to render four columns — Type, Plan, Member, Booked — with
 * no status, no session date, no filters and no way through to anything. An
 * operator could see that bookings existed and nothing else. The underlying
 * query already returned slot times and `completionStatus`; the table simply
 * wasn't showing them.
 *
 * Filters: `appointmentType` is a server filter (the route accepts it, so it
 * applies across the whole result set and resets pagination). Status and
 * search are client-side over the current page — the endpoint has no
 * equivalent parameter, and adding one is a backend change that belongs with
 * the query, not here. The distinction is surfaced in the UI so an operator
 * isn't misled into thinking a search covers everything.
 *
 * The server page (#890) prefetches page 1 with no type filter into the
 * queryKey ["org-appointments", orgId, 1, undefined], so the first paint
 * hydrates without a fetch.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { format } from "date-fns";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ScopedListTable,
  type Column,
} from "@/components/dashboard/ScopedListTable";

interface AppointmentSlot {
  id: string;
  startsAt: string;
  endsAt: string | null;
  isTentative: boolean;
  completionStatus: string | null;
}

interface AppointmentRow {
  id: string;
  appointmentType: string;
  createdAt: string;
  organizationId: string | null;
  slotsOfAppointment: AppointmentSlot[];
  consultation: {
    consultationPlan: { title: string };
    requestedBy: { user: { id: string; name: string | null; email: string } };
  } | null;
  subscription: {
    subscriptionPlan: { title: string };
    requestedBy: { user: { id: string; name: string | null; email: string } };
  } | null;
  webinar: { webinarPlan: { title: string } } | null;
  class: { classPlan: { title: string } } | null;
  /**
   * Seats in this session that THIS org funded, pre-filtered server-side to the
   * viewing org. Present on the "Everyone" scope only; a group event shares one
   * appointment across every registrant, so this is how a sponsor learns which
   * of its own people were in it without learning who else was.
   */
  payment?: {
    id: string;
    user: { id: string; name: string | null; email: string } | null;
  }[];
}

interface AppointmentsResponse {
  items: AppointmentRow[];
  total: number;
  page: number;
  perPage: number;
}

// No TRIAL: a trial is a B2C acquisition session and checkout never stamps an
// organizationId on one, so this filter had exactly zero rows to return in
// every org. It read as "this org has no trials yet" rather than "an org does
// not have trials", which is a different and untrue thing to say.
const APPOINTMENT_TYPES = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
] as const;

/** SlotCompletionStatus, plus the derived TENTATIVE state. */
const STATUS_OPTIONS = [
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
  "RESCHEDULED",
  "UNVERIFIED",
  "TENTATIVE",
] as const;

const STATUS_VARIANT: Record<string, string> = {
  COMPLETED:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  CANCELLED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  RESCHEDULED:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  TENTATIVE:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  UNVERIFIED: "bg-muted text-muted-foreground",
};

function getPlanTitle(row: AppointmentRow): string {
  return (
    row.consultation?.consultationPlan?.title ??
    row.subscription?.subscriptionPlan?.title ??
    row.webinar?.webinarPlan?.title ??
    row.class?.classPlan?.title ??
    "—"
  );
}

function getMember(row: AppointmentRow): string {
  const u =
    row.consultation?.requestedBy?.user ?? row.subscription?.requestedBy?.user;
  if (u) return u.name || u.email;

  // Group events share one appointment across every registrant, so there is no
  // single "member" — but `payment` is pre-filtered server-side to THIS org's
  // funded seats, so these are our people and only ours. Without this the row
  // read "—" and a sponsor could see that it had paid for a webinar without
  // being told whom it had paid for.
  const funded = row.payment ?? [];
  const names = funded
    .map((p) => p.user?.name || p.user?.email)
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return "—";
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

/** Earliest slot that hasn't ended yet, else the latest. Mirrors the member view. */
function displaySlot(slots: AppointmentSlot[]): AppointmentSlot | null {
  if (!slots || slots.length === 0) return null;
  const now = Date.now();
  const sorted = [...slots].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const upcoming = sorted.find((s) => {
    const end = s.endsAt
      ? new Date(s.endsAt).getTime()
      : new Date(s.startsAt).getTime();
    return end >= now;
  });
  return upcoming ?? sorted[sorted.length - 1];
}

function rowStatus(row: AppointmentRow): string {
  const slot = displaySlot(row.slotsOfAppointment);
  if (!slot) return "—";
  // isTentative predates the RESCHEDULED enum value and still drives the
  // pending-reallocation state, so it takes precedence in display.
  if (slot.isTentative) return "TENTATIVE";
  return slot.completionStatus ?? "SCHEDULED";
}

function rowSessionDate(row: AppointmentRow): string {
  const slot = displaySlot(row.slotsOfAppointment);
  if (!slot) return "—";
  return new Date(slot.startsAt).toLocaleString("en-IN", {
    // Fixed IST, matching the member view and the compensation page.
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    // The org feed pages back through historical bookings and the adjacent
    // Booked column carries the year, so omitting it here made sessions a year
    // apart indistinguishable and read as a bug rather than a choice.
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const COLUMNS: Column<AppointmentRow>[] = [
  {
    header: "Type",
    accessor: (r) => <Badge variant="outline">{r.appointmentType}</Badge>,
  },
  { header: "Plan / Title", accessor: (r) => getPlanTitle(r) },
  { header: "Member", accessor: (r) => getMember(r) },
  {
    header: "Session",
    accessor: (r) => rowSessionDate(r),
  },
  {
    header: "Status",
    accessor: (r) => {
      const status = rowStatus(r);
      if (status === "—") return "—";
      return (
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            STATUS_VARIANT[status] ??
            "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
          }`}
        >
          {status}
        </span>
      );
    },
  },
  {
    header: "Booked",
    accessor: (r) => format(new Date(r.createdAt), "PP"),
  },
];

export function AppointmentsPageClient({ orgId }: { orgId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Clamp to a positive integer — `?page=-1` / `?page=abc` would otherwise
  // flow into the queryKey + fetch (Number("-1") is truthy, so `|| 1` misses).
  const rawPage = Number(searchParams?.get("page") ?? "1");
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  // Same discipline as the `page` clamp above. An unrecognised value still
  // filtered the fetch, but the Select had no matching item so its trigger fell
  // back to the "All types" placeholder — the control then misreported which
  // filter was actually active.
  const rawTypeFilter = searchParams?.get("appointmentType");
  const typeFilter = (APPOINTMENT_TYPES as readonly string[]).includes(
    rawTypeFilter ?? "",
  )
    ? (rawTypeFilter as string)
    : undefined;

  const [status, setStatus] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, isError } = useQuery<AppointmentsResponse>({
    queryKey: ["org-appointments", orgId, page, typeFilter],
    queryFn: async () => {
      const sp = new URLSearchParams({ page: String(page) });
      if (typeFilter) sp.set("appointmentType", typeFilter);
      const res = await fetch(
        `/api/organizations/${orgId}/appointments?${sp.toString()}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  // Server filter — applies across the whole result set, so pagination resets.
  const setTypeFilter = (next: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "all") params.delete("appointmentType");
    else params.set("appointmentType", next);
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Memoised so the `?? []` fallback doesn't mint a fresh array every render
  // and defeat the filter memo below.
  const items = useMemo(() => data?.items ?? [], [data?.items]);

  // Client filters — this page only. See the header note.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((row) => {
      if (status !== "all" && rowStatus(row) !== status) return false;
      if (!q) return true;
      return (
        getPlanTitle(row).toLowerCase().includes(q) ||
        getMember(row).toLowerCase().includes(q)
      );
    });
  }, [items, status, search]);

  const isNarrowed = status !== "all" || search.trim().length > 0;

  const toolbar = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1 min-w-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search plan or member on this page…"
          className="pl-8"
        />
      </div>

      <Select value={typeFilter ?? "all"} onValueChange={setTypeFilter}>
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue placeholder="All types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          {APPOINTMENT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue placeholder="Any status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any status</SelectItem>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-6">
      <ScopedListTable
        title="Org appointments"
        description={
          isNarrowed
            ? `Showing ${filtered.length} of ${items.length} on this page. Status and search filter the current page only; type filters everything.`
            : "Sessions booked by members of this organization or scoped to a member's program assignment."
        }
        isLoading={isLoading}
        isError={isError}
        items={filtered}
        // Pagination stays bound to the server result — a client filter
        // narrows the rows on screen, not the number of pages.
        total={data?.total ?? 0}
        page={data?.page ?? page}
        perPage={data?.perPage ?? 20}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        toolbar={toolbar}
        emptyMessage={
          isNarrowed
            ? "No appointments on this page match those filters."
            : "No appointments under this organization yet. Member bookings will surface here once stamped via checkout (B1-hybrid)."
        }
      />
    </div>
  );
}
