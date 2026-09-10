"use client";

/**
 * #support-hub — the back-office CONVERSATIONS inbox: every per-appointment
 * support thread, filterable by status/channel, newest activity first. Staff
 * are the HUMAN channel's counterparty, so this surface reads full transcripts
 * (unlike the org triage page, which is metadata-only per ADR 20).
 *
 * Replying here writes an AGENT message on the thread AND mirrors a public
 * response onto the linked ticket; resolving/closing syncs both ways.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Headset,
  UserRound,
  Ticket as TicketIcon,
  CheckCircle2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

interface ThreadListRow {
  id: string;
  appointmentId: string;
  category: string;
  status: string;
  activeChannel: string;
  lastMessageAt: string;
  createdAt: string;
  supportTicketId: string | null;
  organizationId: string | null;
  messageCount: number;
  lastMessage: { sender: string; body: string } | null;
  user: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
}

interface ThreadDetail {
  id: string;
  category: string;
  status: string;
  activeChannel: string;
  user: { id: string; name: string | null; email: string };
  messages: { id: string; sender: string; body: string; createdAt: string }[];
  supportTicket: { id: string; title: string; status: string } | null;
  appointment: {
    id: string;
    appointmentType: string;
    slotsOfAppointment: { startsAt: string }[];
    consultation?: { consultationPlan?: { title?: string } };
    subscription?: { subscriptionPlan?: { title?: string } };
    webinar?: { webinarPlan?: { title?: string } };
    class?: { classPlan?: { title?: string } };
  };
}

const STATUS_FILTERS = [
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const;

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  ESCALATED: "Escalated",
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

function planTitleOf(a: ThreadDetail["appointment"]): string {
  return (
    a.consultation?.consultationPlan?.title ??
    a.subscription?.subscriptionPlan?.title ??
    a.webinar?.webinarPlan?.title ??
    a.class?.classPlan?.title ??
    "Session"
  );
}

export function SupportThreadsPage() {
  const [status, setStatus] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The reply draft lives in React state: a DOM-read textarea never cleared
  // after send (duplicate replies on a second click) and bled drafts across
  // threads when the selection changed.
  const [draft, setDraft] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const list = useQuery({
    queryKey: ["staff-threads", status],
    queryFn: async (): Promise<{
      data: ThreadListRow[];
      counts: Record<string, number>;
    }> => {
      const params = new URLSearchParams({ limit: "30" });
      if (status) params.set("status", status);
      const res = await fetch(`/api/staff/support-threads?${params}`);
      if (!res.ok) await throwSupportError(res, "conversations list");
      return res.json();
    },
  });

  const detail = useQuery({
    queryKey: ["staff-thread", selectedId],
    enabled: !!selectedId,
    queryFn: async (): Promise<ThreadDetail> => {
      const res = await fetch(`/api/staff/support-threads/${selectedId}`);
      if (!res.ok) await throwSupportError(res, "conversation load");
      const { data } = await res.json();
      return data;
    },
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["staff-threads"] });
    void qc.invalidateQueries({ queryKey: ["staff-thread", selectedId] });
  };

  const reply = useMutation({
    mutationFn: async (input: { threadId: string; message: string }) => {
      const res = await fetch(`/api/staff/support-threads/${input.threadId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input.message }),
      });
      if (!res.ok) await throwSupportError(res, "reply send");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reply sent" });
      setDraft("");
      invalidate();
    },
    onError: (e: unknown) =>
      toast({
        title: "Reply failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
  });

  const setStatusMut = useMutation({
    mutationFn: async (input: { threadId: string; status: string }) => {
      const res = await fetch(`/api/staff/support-threads/${input.threadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: input.status }),
      });
      if (!res.ok) await throwSupportError(res, "status update");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status updated" });
      invalidate();
    },
    onError: (e: unknown) =>
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
  });

  const counts = useMemo(() => list.data?.counts ?? {}, [list.data]);
  const rows = list.data?.data ?? [];
  const d = detail.data;

  const totalOpen = useMemo(
    () =>
      (counts.OPEN ?? 0) + (counts.IN_PROGRESS ?? 0) + (counts.ESCALATED ?? 0),
    [counts],
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Support conversations
          </h1>
          <p className="text-sm text-muted-foreground">
            Per-appointment threads — {totalOpen} awaiting action. Replies reach
            the user in their session&apos;s &quot;Get help&quot; panel.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant={status === "" ? "default" : "outline"}
            onClick={() => setStatus("")}
          >
            All
          </Button>
          {STATUS_FILTERS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "default" : "outline"}
              onClick={() => setStatus(s)}
            >
              {STATUS_LABELS[s]}
              {counts[s] ? ` (${counts[s]})` : ""}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* List */}
        <div
          className={
            "rounded-lg border border-border divide-y divide-border overflow-hidden " +
            (selectedId ? "lg:col-span-2" : "lg:col-span-5")
          }
        >
          {list.isError ? (
            // `throwSupportError` produces a coded, user-facing message; the
            // render branched only on the loading flag, so a failed fetch was
            // indistinguishable from "no conversations" and offered no way
            // back. Same shape as the detail pane below.
            <div className="flex flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              {(list.error as Error)?.message ?? "Couldn't load conversations."}
              <Button
                variant="outline"
                size="sm"
                onClick={() => list.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : list.isLoading ? (
            <div className="p-4 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No conversations match this filter.
            </p>
          ) : (
            rows.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setSelectedId(t.id);
                  setDraft("");
                }}
                className={
                  "block w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 " +
                  (selectedId === t.id ? "bg-muted" : "")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {t.user.name ?? t.user.email}
                  </span>
                  <Badge variant={statusVariant(t.status)}>
                    {STATUS_LABELS[t.status] ?? t.status}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t.category.replaceAll("_", " ").toLowerCase()} ·{" "}
                  {t.messageCount} messages ·{" "}
                  {new Date(t.lastMessageAt).toLocaleString(undefined, {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                {t.lastMessage && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {t.lastMessage.sender === "USER"
                      ? ""
                      : `${t.lastMessage.sender.toLowerCase()}: `}
                    {t.lastMessage.body}
                  </p>
                )}
              </button>
            ))
          )}
        </div>

        {/* Detail */}
        {selectedId && (
          <div className="lg:col-span-3 rounded-lg border border-border p-4">
            {detail.isError ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                {(detail.error as Error)?.message ??
                  "Couldn't load this conversation."}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => detail.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : detail.isLoading || !d ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <div className="flex h-full flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {planTitleOf(d.appointment)} ·{" "}
                      {d.appointment.appointmentType.toLowerCase()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {d.user.name} ({d.user.email}) ·{" "}
                      {d.appointment.slotsOfAppointment[0]?.startsAt &&
                        new Date(
                          d.appointment.slotsOfAppointment[0].startsAt,
                        ).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {d.supportTicket && (
                      <Badge variant="outline">
                        <TicketIcon className="mr-1 h-3 w-3" />
                        Ticket linked
                      </Badge>
                    )}
                    <Badge variant={statusVariant(d.status)}>
                      {STATUS_LABELS[d.status] ?? d.status}
                    </Badge>
                  </div>
                </div>

                {/* Transcript */}
                <div className="flex-1 space-y-2 overflow-y-auto rounded-md bg-muted/40 p-3 max-h-[45vh]">
                  {d.messages.map((m) => (
                    <div
                      key={m.id}
                      className={
                        m.sender === "USER"
                          ? "flex justify-start"
                          : "flex justify-end"
                      }
                    >
                      <div
                        className={
                          "max-w-[80%] rounded-lg px-3 py-2 text-sm " +
                          (m.sender === "USER"
                            ? "bg-background border border-border"
                            : "bg-primary text-primary-foreground")
                        }
                      >
                        <span className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70">
                          {m.sender === "USER" ? (
                            <UserRound className="h-3 w-3" />
                          ) : m.sender === "AGENT" ? (
                            <Headset className="h-3 w-3" />
                          ) : (
                            <Bot className="h-3 w-3" />
                          )}
                          {m.sender === "AGENT"
                            ? "You"
                            : m.sender.toLowerCase()}
                        </span>
                        {m.body}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Actions */}
                <div className="space-y-2">
                  <Label
                    htmlFor={`reply-${d.id}`}
                    className="text-xs text-muted-foreground"
                  >
                    Reply as support (mirrors to the linked ticket)
                  </Label>
                  <Textarea
                    id={`reply-${d.id}`}
                    rows={2}
                    placeholder="Write your reply…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        const v = draft.trim();
                        if (v && !reply.isPending)
                          reply.mutate({ threadId: d.id, message: v });
                      }
                    }}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-1">
                      {["IN_PROGRESS", "RESOLVED", "CLOSED"].map((s) => (
                        <Button
                          key={s}
                          size="sm"
                          variant="outline"
                          disabled={
                            setStatusMut.isPending ||
                            s === d.status ||
                            d.status === "CLOSED"
                          }
                          onClick={() =>
                            setStatusMut.mutate({ threadId: d.id, status: s })
                          }
                        >
                          {s === "RESOLVED" && (
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                          )}
                          {STATUS_LABELS[s]}
                        </Button>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      disabled={reply.isPending || !draft.trim()}
                      onClick={() =>
                        reply.mutate({ threadId: d.id, message: draft.trim() })
                      }
                    >
                      Send reply
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
