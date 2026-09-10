"use client";

/**
 * #support-hub — the Swiggy-style Support & Feedback hub: ONE role-agnostic
 * surface with two subtabs.
 *
 *  • Sessions — your recent sessions (tap → per-appointment flowchart thread)
 *    and every support conversation you've opened, bucketed by status, newest
 *    activity first.
 *  • Platform — flowchart intake for platform issues (stateless; escalates
 *    into a ticket) and your ticket list, same bucketing/sorting.
 *
 * The panels are deliberately scope-free: `/api/user/support-tickets`,
 * `/api/user/support-threads` and `/api/appointments` all key off the session,
 * so consultee, consultant, org operator and staff mount the same component.
 * Feedback and Help remain their own destinations (deep-linked below).
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LifeBuoy,
  MessageSquareText,
  HelpCircle,
  CalendarDays,
  ChevronRight,
  Bot,
  UserRound,
  Headset,
  Building2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus } from "lucide-react";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { PlatformSupportSheet } from "@/components/support/PlatformSupportSheet";
import { CreateTicketDialog } from "./CreateTicketDialog";
import { throwSupportError } from "@/lib/support/error-copy";

// ---------------------------------------------------------------------------
// Types + small helpers
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  appointmentId: string;
  category: string;
  status: string;
  activeChannel: string;
  lastMessageAt: string;
  createdAt: string;
  lastMessage: { sender: string; body: string } | null;
  appointment: {
    appointmentType: string;
    startsAt: string | null;
    organizationName?: string | null;
    planTitle: string | null;
  };
}

interface TicketRow {
  id: string;
  /** #705 — the speakable handle. Null on tickets that predate it. */
  referenceNumber?: string | null;
  title: string;
  status: string;
  updatedAt: string;
  createdAt: string;
  responses?: { message: string; createdAt: string; isInternal: boolean }[];
}

interface AppointmentRow {
  id: string;
  consultation?: { consultationPlan?: { title?: string } };
  subscription?: { subscriptionPlan?: { title?: string } };
  webinar?: { webinarPlan?: { title?: string } };
  class?: { classPlan?: { title?: string } };
  slotsOfAppointment?: { startsAt: string }[];
  organization?: { id: string; name: string } | null;
}

interface OrgMembership {
  organizationId: string;
  orgName: string;
  role: string;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  ESCALATED: "With our team",
  ON_HOLD: "With our team",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "RESOLVED") return "secondary";
  if (status === "CLOSED") return "outline";
  if (status === "ESCALATED" || status === "ON_HOLD") return "destructive";
  return "default";
}

/** Bucket key for the three user-facing groups. */
function bucketOf(status: string): "open" | "team" | "resolved" {
  if (status === "ESCALATED" || status === "ON_HOLD") return "team";
  if (status === "RESOLVED" || status === "CLOSED") return "resolved";
  return "open";
}

const BUCKETS: { key: "open" | "team" | "resolved"; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "team", label: "With our team" },
  { key: "resolved", label: "Resolved" },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function planTitleOf(a: AppointmentRow): string {
  return (
    a.consultation?.consultationPlan?.title ??
    a.subscription?.subscriptionPlan?.title ??
    a.webinar?.webinarPlan?.title ??
    a.class?.classPlan?.title ??
    "Session"
  );
}

/** Bucket rows by status preserving the server's last-activity order. */
function bucketize<T extends { status: string }>(
  rows: T[],
): Record<"open" | "team" | "resolved", T[]> {
  const out = { open: [], team: [], resolved: [] } as Record<
    "open" | "team" | "resolved",
    T[]
  >;
  for (const r of rows) out[bucketOf(r.status)].push(r);
  return out;
}

// ---------------------------------------------------------------------------
// Subtab: Sessions
// ---------------------------------------------------------------------------

function SessionsTab({
  appointmentsHrefBase,
}: {
  appointmentsHrefBase?: string;
}) {
  const threads = useQuery({
    queryKey: ["user-support-threads"],
    queryFn: async (): Promise<ThreadRow[]> => {
      const res = await fetch("/api/user/support-threads");
      if (!res.ok) await throwSupportError(res, "conversations load");
      const { data } = await res.json();
      return data;
    },
  });

  // Active org memberships — org-hosted sessions live under the org scope
  // (personal pins organizationId: null, ADR 19), so without this merge an
  // org LEARNER/EXPERT would have no per-session support entry point.
  const memberships = useQuery({
    queryKey: ["user-org-memberships"],
    queryFn: async (): Promise<OrgMembership[]> => {
      const res = await fetch("/api/user/org-memberships");
      if (!res.ok) return [];
      const { data } = await res.json();
      return data;
    },
    staleTime: 60_000,
  });

  // Capped once so the cache key and the request always agree — keying on
  // membership COUNT served stale org sets when content changed under a
  // constant count, and refetched needlessly when a 4th+ org changed.
  const orgIds = useMemo(
    () => (memberships.data ?? []).slice(0, 3).map((m) => m.organizationId),
    [memberships.data],
  );

  const appointments = useQuery({
    queryKey: ["support-hub-recent-sessions", orgIds],
    enabled: memberships.isSuccess,
    queryFn: async (): Promise<AppointmentRow[]> => {
      // Personal (B2C) first, then each ACTIVE org's member scope — capped at
      // three orgs so a pathological membership list can't fan out.
      const orgs = (memberships.data ?? []).filter((m) =>
        orgIds.includes(m.organizationId),
      );
      const fetchScope = async (orgScope?: string) => {
        const qs = orgScope
          ? `?pageSize=5&orgScope=${encodeURIComponent(orgScope)}`
          : "?pageSize=5";
        const res = await fetch(`/api/appointments${qs}`);
        if (!res.ok) return [];
        const json = await res.json();
        // `listAppointmentsScoped` returns { items, total, page, perPage }.
        // The `data`/`appointments` fallbacks never matched, so the recent-
        // sessions picker was unconditionally empty and the whole Sessions tab
        // read as "you have no sessions" for users who plainly did.
        return (json.items ??
          json.data ??
          json.appointments ??
          []) as AppointmentRow[];
      };
      const [personal, ...orgLists] = await Promise.all([
        fetchScope(),
        ...orgs.map((m) => fetchScope(m.organizationId)),
      ]);
      const orgNameById = new Map(
        orgs.map((m) => [m.organizationId, m.orgName]),
      );
      // Merge + dedupe (a session can only be in one scope by construction,
      // but dedupe keeps the invariant local rather than trusted).
      const seen = new Set<string>();
      const merged: AppointmentRow[] = [];
      for (const row of [...personal, ...orgLists.flat()]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(row);
      }
      // Most recent slot first — the picker is "your recent sessions".
      return merged
        .slice()
        .sort(
          (a, b) =>
            Date.parse(b.slotsOfAppointment?.[0]?.startsAt ?? "0") -
            Date.parse(a.slotsOfAppointment?.[0]?.startsAt ?? "0"),
        )
        .slice(0, 8)
        .map((r) =>
          r.organization
            ? {
                ...r,
                organization: {
                  ...r.organization,
                  name:
                    orgNameById.get(r.organization.id) ?? r.organization.name,
                },
              }
            : r,
        );
    },
  });

  const buckets = useMemo(() => bucketize(threads.data ?? []), [threads.data]);

  // "Go to appointment" only for B2C rows — org-hosted sessions have no
  // per-session detail page by design (ADR 20 addendum), so a link would 404.
  const hrefFor = (appointmentId: string, orgScoped?: boolean) =>
    appointmentsHrefBase && !orgScoped
      ? `${appointmentsHrefBase}/${appointmentId}`
      : undefined;

  return (
    <div className="space-y-8">
      {/* Recent sessions — pick one, get help (the Swiggy order-picker) */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Your recent sessions
        </h3>
        {appointments.isLoading || memberships.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : appointments.isError ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            Couldn't load your recent sessions.{" "}
            <Button
              variant="outline"
              size="sm"
              className="ml-1"
              onClick={() => appointments.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (appointments.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions yet — help for any booking appears here.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {appointments.data!.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {planTitleOf(a)}
                    {a.organization && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                        <Building2 className="h-3 w-3" />
                        {a.organization.name}
                      </span>
                    )}
                  </p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CalendarDays className="h-3 w-3" />
                    {fmtDate(a.slotsOfAppointment?.[0]?.startsAt)}
                  </p>
                </div>
                <SupportThreadSheet
                  appointmentId={a.id}
                  appointmentHref={hrefFor(a.id, !!a.organization)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Existing conversations, bucketed by status */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Your support conversations
        </h3>
        {threads.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : threads.isError ? (
          <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            Couldn't load your support conversations.{" "}
            <Button
              variant="outline"
              size="sm"
              className="ml-1"
              onClick={() => threads.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (threads.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing open — when you raise an issue about a session it lives
            here.
          </p>
        ) : (
          <div className="space-y-6">
            {BUCKETS.map(({ key, label }) =>
              buckets[key].length > 0 ? (
                <div key={key}>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label} ({buckets[key].length})
                  </p>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {buckets[key].map((t) => (
                      <li key={t.id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {t.appointment.planTitle ?? "Session"}
                              {t.appointment.organizationName && (
                                <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                                  <Building2 className="h-3 w-3" />
                                  {t.appointment.organizationName}
                                </span>
                              )}
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                {fmtDate(t.appointment.startsAt)}
                              </span>
                            </p>
                            {t.lastMessage && (
                              <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                                {t.lastMessage.sender === "USER" ? (
                                  <UserRound className="h-3 w-3 shrink-0" />
                                ) : (
                                  <Bot className="h-3 w-3 shrink-0" />
                                )}
                                {t.lastMessage.body}
                              </p>
                            )}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={statusVariant(t.status)}>
                              {t.activeChannel === "HUMAN"
                                ? "With our team"
                                : (STATUS_LABELS[t.status] ?? t.status)}
                            </Badge>
                            <SupportThreadSheet
                              appointmentId={t.appointmentId}
                              appointmentHref={hrefFor(
                                t.appointmentId,
                                !!t.appointment.organizationName,
                              )}
                              trigger={
                                <Button variant="ghost" size="sm">
                                  View
                                  <ChevronRight className="ml-1 h-4 w-4" />
                                </Button>
                              }
                            />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null,
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subtab: Platform
// ---------------------------------------------------------------------------

function PlatformTab({
  orgId,
  feedbackHref,
  helpHref,
}: {
  orgId?: string;
  feedbackHref?: string;
  helpHref?: string;
}) {
  const tickets = useQuery({
    queryKey: ["user-support-tickets"],
    queryFn: async (): Promise<TicketRow[]> => {
      const res = await fetch("/api/user/support-tickets");
      if (!res.ok) await throwSupportError(res, "requests load");
      return res.json();
    },
  });

  /** Last activity = latest visible reply, else the ticket's own clock. */
  const sorted = useMemo(() => {
    const rows = tickets.data ?? [];
    return [...rows].sort((a, b) => {
      const la = Math.max(
        Date.parse(a.updatedAt),
        ...(a.responses ?? []).map((r) => Date.parse(r.createdAt)),
      );
      const lb = Math.max(
        Date.parse(b.updatedAt),
        ...(b.responses ?? []).map((r) => Date.parse(r.createdAt)),
      );
      return lb - la;
    });
  }, [tickets.data]);

  const buckets = useMemo(() => bucketize(sorted), [sorted]);

  return (
    <div className="space-y-8">
      {/* Platform issue intake */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Get help with the platform
        </h3>
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              Payments, account, sign-in or site trouble
            </p>
            <p className="text-xs text-muted-foreground">
              A few quick questions and we&apos;ll either fix it on the spot or
              route you to the right team with full context.
            </p>
          </div>
          <PlatformSupportSheet orgId={orgId} />
        </div>
        {(feedbackHref || helpHref) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {feedbackHref && (
              <Button variant="ghost" size="sm" asChild>
                <a href={feedbackHref}>
                  <MessageSquareText className="mr-1.5 h-4 w-4" />
                  Share feedback
                </a>
              </Button>
            )}
            {helpHref && (
              <Button variant="ghost" size="sm" asChild>
                <a href={helpHref}>
                  <HelpCircle className="mr-1.5 h-4 w-4" />
                  Browse FAQs
                </a>
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Tickets, bucketed by status, latest activity first */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">My requests</h3>
          <CreateTicketDialog />
        </div>
        {tickets.isError ? (
          // Distinguishing a failed load from a genuine empty list matters
          // here more than most places: "No platform requests yet" invites the
          // user to file a request they may already have open.
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {(tickets.error as Error)?.message ??
                "Couldn't load your requests."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => tickets.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : tickets.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : sorted.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No platform requests yet.
            </p>
            <div className="mt-3">
              <CreateTicketDialog
                trigger={
                  <Button variant="outline" size="sm">
                    <Plus className="mr-1.5 h-4 w-4" />
                    Create your first request
                  </Button>
                }
              />
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {BUCKETS.map(({ key, label }) =>
              buckets[key].length > 0 ? (
                <div key={key}>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {label} ({buckets[key].length})
                  </p>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {buckets[key].map((t) => {
                      const lastReply = [...(t.responses ?? [])].pop();
                      return (
                        <li key={t.id} className="px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-foreground">
                                {t.title || "Support request"}
                              </p>
                              {t.referenceNumber && (
                                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                                  {t.referenceNumber}
                                </p>
                              )}
                              {lastReply && (
                                <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                                  <Headset className="h-3 w-3 shrink-0" />
                                  {lastReply.message}
                                </p>
                              )}
                            </div>
                            <Badge variant={statusVariant(t.status)}>
                              {STATUS_LABELS[t.status] ?? t.status}
                            </Badge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null,
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export function SupportHub({
  orgId,
  feedbackHref,
  helpHref,
  appointmentsHrefBase,
}: {
  /** Profile id of the mounting dashboard (consultee/consultant). Kept in the
   *  public signature for parity with the standalone request pages; the hub
   *  itself doesn't consume it. */
  profileId?: string;
  /** Active org id in operator trees — attributes platform tickets. */
  orgId?: string;
  feedbackHref?: string;
  helpHref?: string;
  /** Base path to a session's detail page (personal trees only). Enables the
   *  "Go to appointment" link inside the thread sheet. Deliberately omitted on
   *  org surfaces (ADR 20: no per-session drill-in for org roles). */
  appointmentsHrefBase?: string;
}) {
  const [tab, setTab] = useState<"sessions" | "platform">("sessions");

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex gap-1 rounded-lg bg-muted p-1 sm:w-fit">
        {(
          [
            { key: "sessions", label: "Sessions", icon: CalendarDays },
            { key: "platform", label: "Platform", icon: LifeBuoy },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              "flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors " +
              (tab === key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "sessions" ? (
        <SessionsTab appointmentsHrefBase={appointmentsHrefBase} />
      ) : (
        <PlatformTab
          orgId={orgId}
          feedbackHref={feedbackHref}
          helpHref={helpHref}
        />
      )}
    </div>
  );
}
