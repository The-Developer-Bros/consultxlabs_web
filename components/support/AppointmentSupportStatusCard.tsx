"use client";

/**
 * #support-hub — the inline support status on the appointment detail page.
 * Renders nothing until a conversation exists; once it does, the page shows
 * its live state (open / with our team / resolved), the latest exchange, and
 * one tap back into the conversation. Staff replies arrive as AGENT messages,
 * so the user sees the human hand-off right here — no navigation.
 */

import { useQuery } from "@tanstack/react-query";
import { Bot, Headset, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SupportThreadSheet } from "@/components/support/SupportThreadSheet";
import { throwSupportError } from "@/lib/support/error-copy";

interface ThreadMessage {
  id: string;
  sender: string;
  body: string;
  createdAt: string;
}

interface ThreadSummary {
  id: string;
  status: string;
  activeChannel: string;
  messages: ThreadMessage[];
}

function statusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "RESOLVED") return "secondary";
  if (status === "CLOSED") return "outline";
  if (status === "ESCALATED") return "destructive";
  return "default";
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  ESCALATED: "With our team",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export function AppointmentSupportStatusCard({
  appointmentId,
  isOrgContext = false,
}: {
  appointmentId: string;
  isOrgContext?: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["support-thread", appointmentId],
    // Same key AND same payload shape as SupportThreadSheet — the sheet reads
    // this cache entry and needs `intents` too, not a thread-only stub.
    queryFn: async (): Promise<{
      thread: ThreadSummary | null;
      intents: { category: string; title: string }[];
    }> => {
      const res = await fetch(`/api/appointments/${appointmentId}/support`);
      if (!res.ok) await throwSupportError(res, "support status card");
      const json = await res.json();
      return { thread: json.data, intents: json.intents ?? [] };
    },
  });

  const thread = data?.thread;
  if (!thread || thread.messages.length === 0) return null;

  const last = thread.messages[thread.messages.length - 1];
  const isHuman = thread.activeChannel === "HUMAN";

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Support
            </span>
            <Badge variant={statusVariant(thread.status)}>
              {isHuman ? "With our team" : STATUS_LABELS[thread.status] ?? thread.status}
            </Badge>
          </div>
          {last && (
            <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
              {last.sender === "USER" ? (
                <UserRound className="h-3.5 w-3.5 shrink-0" />
              ) : last.sender === "AGENT" ? (
                <Headset className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Bot className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{last.body}</span>
            </p>
          )}
        </div>
        <SupportThreadSheet
          appointmentId={appointmentId}
          isOrgContext={isOrgContext}
          trigger={
            <Button variant="outline" size="sm">
              View conversation
            </Button>
          }
        />
      </div>
    </div>
  );
}
