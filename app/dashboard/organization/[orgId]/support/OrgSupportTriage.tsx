"use client";

/**
 * #support-hub — ORG SUPPORT TRIAGE (per-org dashboard, `operations.read`).
 *
 * Three things live here, all metadata-level by ADR 20:
 *  1. CSAT aggregate — the "org quality signal" (avg + count; no per-member
 *     rows exist to show, deliberately).
 *  2. Members' support conversations — status/category/who/when. NO
 *     transcripts: a member's support chat is content, and content belongs to
 *     the participant (and, once escalated, the platform's team).
 *  3. Raise concern — the org-party thread entry: an operator opens THEIR OWN
 *     conversation on a specific session (ORG_ADMIN_DISPUTE / sponsorship
 *     intents, served and enforced server-side).
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star, MessageSquareText, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRequireOrgAccess } from "../useOrgRole";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";

interface TriageRow {
  id: string;
  appointmentId: string;
  category: string;
  status: string;
  activeChannel: string;
  lastMessageAt: string;
  createdAt: string;
  member: { id: string; name: string | null };
  appointment: {
    appointmentType: string;
    startsAt: string | null;
    planTitle: string | null;
  };
}

interface FeedbackSummary {
  averageRating: number | null;
  totalResponses: number;
  averageRating30d: number | null;
  responses30d: number;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  ESCALATED: "With platform team",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "RESOLVED") return "secondary";
  if (status === "CLOSED") return "outline";
  if (status === "ESCALATED") return "destructive";
  return "default";
}

const STATUS_FILTERS = [
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
] as const;

/**
 * One row of the org triage list.
 *
 * METADATA ONLY, by design (ADR 20 + its 2026-08-21 addendum): plan title,
 * member name, category, status and timestamps. A member's support
 * conversation is CONTENT — the org may see that it happened, never what was
 * said — so no message, body or preview field belongs here. The endpoint
 * enforces the same line with a select allowlist, pinned by
 * `__tests__/security/org-scope-payload-allowlist.test.ts`.
 */
function OrgThreadRow({ thread: t }: { thread: TriageRow }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {t.appointment.planTitle ?? "Session"}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t.member.name ?? t.member.id} ·{" "}
            {t.appointment.startsAt &&
              new Date(t.appointment.startsAt).toLocaleDateString()}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {t.category.replaceAll("_", " ").toLowerCase()} · last activity{" "}
          {new Date(t.lastMessageAt).toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
          })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={statusVariant(t.status)}>
          {STATUS_LABELS[t.status] ?? t.status}
        </Badge>
        <SupportThreadSheet
          appointmentId={t.appointmentId}
          trigger={
            <Button variant="outline" size="sm">
              <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
              Raise concern
            </Button>
          }
        />
      </div>
    </li>
  );
}

export function OrgSupportTriage({ orgId }: { orgId: string }) {
  const { allowed, isLoading: gateLoading } = useRequireOrgAccess(orgId, {
    permission: "operations.read",
  });
  const [status, setStatus] = useState<string>("");

  const summary = useQuery({
    queryKey: ["org-feedback-summary", orgId],
    enabled: allowed,
    queryFn: async (): Promise<FeedbackSummary> => {
      const res = await fetch(`/api/organizations/${orgId}/feedback-summary`);
      if (!res.ok) throw new Error("Failed to load quality summary");
      const { data } = await res.json();
      return data;
    },
  });

  const threads = useQuery({
    queryKey: ["org-support-threads", orgId, status],
    enabled: allowed,
    queryFn: async (): Promise<TriageRow[]> => {
      const params = new URLSearchParams({ pageSize: "30" });
      if (status) params.set("status", status);
      const res = await fetch(
        `/api/organizations/${orgId}/support-threads?${params}`,
      );
      if (!res.ok) throw new Error("Failed to load support triage");
      const json = await res.json();
      return json.data;
    },
  });

  if (gateLoading) return <Skeleton className="h-40 w-full" />;
  if (!allowed) return null;

  const s = summary.data;
  // A failed request is not "no data" — show it, with a way out.
  const summaryError = summary.isError ? (
    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      Couldn&apos;t load the quality summary.{" "}
      <Button
        variant="outline"
        size="sm"
        className="ml-1"
        onClick={() => summary.refetch()}
      >
        Retry
      </Button>
    </div>
  ) : null;
  const threadsError = threads.isError ? (
    <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      Couldn&apos;t load member conversations.{" "}
      <Button
        variant="outline"
        size="sm"
        className="ml-1"
        onClick={() => threads.refetch()}
      >
        Retry
      </Button>
    </div>
  ) : null;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-8">
      {/* Quality signal — aggregates only (ADR 20) */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          Session quality
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {summaryError ? (
            summaryError
          ) : (
            <>
              <div className="rounded-lg border border-border p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Star className="h-3.5 w-3.5" /> All-time average rating
                </p>
                {summary.isLoading ? (
                  <Skeleton className="mt-2 h-7 w-20" />
                ) : (
                  <p className="mt-1 text-2xl font-semibold text-foreground">
                    {s?.averageRating ?? "—"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {s?.totalResponses ?? 0} private ratings
                    </span>
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Star className="h-3.5 w-3.5" /> Last 30 days
                </p>
                {summary.isLoading ? (
                  <Skeleton className="mt-2 h-7 w-20" />
                ) : (
                  <p className="mt-1 text-2xl font-semibold text-foreground">
                    {s?.averageRating30d ?? "—"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {s?.responses30d ?? 0} responses
                    </span>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Ratings are private to the participant and the platform — this card is
          the aggregate, never individual feedback.
        </p>
      </section>

      {/* Members' support conversations — metadata triage */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <MessageSquareText className="h-4 w-4" /> Members&apos; support
            conversations
          </h2>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={status === "" ? "default" : "outline"}
              onClick={() => setStatus("")}
            >
              All
            </Button>
            {STATUS_FILTERS.map((f) => (
              <Button
                key={f}
                size="sm"
                variant={status === f ? "default" : "outline"}
                onClick={() => setStatus(f)}
              >
                {STATUS_LABELS[f]}
              </Button>
            ))}
          </div>
        </div>
        {threadsError ? (
          threadsError
        ) : threads.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (threads.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No member conversations match this filter.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {threads.data!.map((t) => (
              <OrgThreadRow key={t.id} thread={t} />
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Conversations are shown as status only — what a member discusses with
          support stays between them and the platform. &quot;Raise concern&quot;
          opens your organization&apos;s own conversation about that session.
        </p>
      </section>
    </div>
  );
}
