"use client";

/**
 * #support-hub — the PLATFORM-scope support intake. A Sheet that runs the
 * stateless flowchart: the client holds the cursor for the length of one
 * sitting and replays it to the server each turn; the server validates every
 * transition (the client is never trusted) and either answers self-serve or
 * escalates — the only write, a SupportTicket via the shared factory.
 *
 * Deliberately NOT Stream, NOT persisted: platform flows are short (1–3
 * steps); the escalated outcome lives in the ops queue, and "My requests"
 * shows the result. See lib/support/platform-flows.ts for the registry.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Send, CheckCircle2, Ticket } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";

type Sender = "USER" | "BOT" | "AGENT" | "SYSTEM";

interface LocalMessage {
  id: string;
  sender: Sender;
  body: string;
  options?: { id: string; label: string }[];
  /** Rendered before the server has answered — see `onMutate`. */
  pending?: boolean;
}

/** Ids for locally-held bubbles. This scope persists nothing, so every message
 *  needs one: an array index reuses DOM nodes positionally and cannot key a
 *  bubble that is later replaced in place. */
let localSeq = 0;
const nextLocalId = () => `local-${++localSeq}`;

interface PlatformFlow {
  id: string;
  title: string;
  description: string;
}

interface TurnResponse {
  messages: {
    sender: string;
    body: string;
    /** PROMPT nodes carry their tappable options here (flow-walk). */
    metadata?: { options?: { id: string; label: string }[] } | null;
  }[];
  nextNodeId: string | null;
  /** Resolver-requested side effects. Displayed, never executed from here. */
  actions?: { kind: string }[];
  resolved: boolean;
  escalated: boolean;
  supportTicketId?: string;
  /** #705 — the handle the user quotes back. Null on pre-#705 tickets. */
  supportTicketReference?: string | null;
}

export function PlatformSupportSheet({
  open: controlledOpen,
  onOpenChange,
  trigger,
  orgId,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
  /** Active org for operator flows (attribution, server-validated). */
  orgId?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    onOpenChange?.(v);
    if (controlledOpen === undefined) setInternalOpen(v);
  };
  const [text, setText] = useState("");
  // Monotonic marker for "this sitting". The platform intake is stateless —
  // the client holds the cursor for one sitting — so a turn that resolves
  // after the user abandoned that sitting must be dropped, not applied.
  const sittingRef = useRef(0);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [done, setDone] = useState<{
    resolved: boolean;
    ticketId?: string;
    ticketReference?: string | null;
    /** #705 — the terminal asked for the user's feedback (COLLECT_FEEDBACK). */
    collectFeedback?: boolean;
  } | null>(null);
  const [feedback, setFeedback] = useState("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const catalog = useQuery({
    queryKey: ["platform-support-intents"],
    enabled: open,
    queryFn: async (): Promise<PlatformFlow[]> => {
      const res = await fetch("/api/support/platform");
      if (!res.ok) await throwSupportError(res, "support topics load");
      const { data } = await res.json();
      return data.flows;
    },
  });

  const turn = useMutation({
    mutationFn: async ({
      epoch: _epoch,
      chosenLabel: _chosenLabel,
      ...body
    }: {
      flowId: string;
      nodeId?: string | null;
      chosenOptionId?: string;
      userMessage?: string;
      /** Client-only sitting marker — see `sittingRef`. Never sent. */
      epoch: number;
      /** Client-only label of the pressed chip — see onSuccess. Never sent. */
      chosenLabel?: string;
    }): Promise<TurnResponse> => {
      const res = await fetch("/api/support/platform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, orgId }),
      });
      if (!res.ok) await throwSupportError(res, "support intake turn");
      const { data } = await res.json();
      return data;
    },
    // Echo what the user just said BEFORE the request returns. Previously the
    // pressed chip's label rode along as a variable and was then never read, so
    // every option tap produced zero user bubbles and the transcript was
    // bot-only — and free text appeared only once the server had answered.
    onMutate: (vars) => {
      const said = vars.userMessage ?? vars.chosenLabel;
      if (!said) return {};
      const optimisticId = nextLocalId();
      setMessages((m) => [
        ...m,
        { id: optimisticId, sender: "USER", body: said, pending: true },
      ]);
      return { optimisticId };
    },
    onSuccess: (result, vars, context) => {
      // Discard a turn that belongs to a sitting the user has already left.
      // The sheet holds the cursor for one sitting; closing it or starting a
      // different flow clears the transcript, and a request still in flight
      // would otherwise repopulate it — dropping the user back into a
      // conversation they abandoned, mid-flow, with a stale cursor.
      if (vars.epoch !== sittingRef.current) return;
      setText("");
      setMessages((m) => [
        ...m.map((x) =>
          x.id === context?.optimisticId ? { ...x, pending: false } : x,
        ),
        // metadata.options MUST survive the trip — a PROMPT without its
        // options is a dead end (no buttons, free text can't advance it).
        ...result.messages.map((msg) => ({
          id: nextLocalId(),
          sender: msg.sender as Sender,
          body: msg.body,
          options: msg.metadata?.options ?? undefined,
        })),
      ]);
      setNodeId(result.nextNodeId);
      if (result.escalated) {
        setDone({
          resolved: false,
          ticketId: result.supportTicketId,
          ticketReference: result.supportTicketReference,
        });
        void qc.invalidateQueries({ queryKey: ["user-support-tickets"] });
      } else if (result.resolved) {
        setDone({
          resolved: true,
          collectFeedback: (result.actions ?? []).some(
            (a) => a.kind === "COLLECT_FEEDBACK",
          ),
        });
      }
    },
    onError: (e: unknown, _vars, context) => {
      // A bubble left standing after the turn failed claims something was said
      // that the server never received.
      if (context?.optimisticId) {
        setMessages((m) => m.filter((x) => x.id !== context.optimisticId));
      }
      toast({
        title: "Support",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const startFlow = (flow: PlatformFlow) => {
    if (turn.isPending) return;
    sittingRef.current += 1;
    setFlowId(flow.id);
    setNodeId(null);
    setMessages([]);
    setDone(null);
    turn.mutate({
      flowId: flow.id,
      chosenLabel: flow.title,
      epoch: sittingRef.current,
    });
  };

  const reset = () => {
    sittingRef.current += 1;
    setFlowId(null);
    setNodeId(null);
    setMessages([]);
    setDone(null);
    setFeedback("");
  };

  // #705 — the "leave feedback" terminal used to say the entry was "read and
  // tracked" and then persist nothing at all. This is what makes that true; it
  // writes product Feedback, NOT a support ticket, because a suggestion is not
  // a support request and filing one would put every opinion in the ops queue.
  const sendFeedback = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch("/api/user/feedbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Product feedback from support",
          description: body,
          category: "SUPPORT_FLOW",
        }),
      });
      if (!res.ok) await throwSupportError(res, "feedback submit");
      return res.json();
    },
    onSuccess: () => {
      setFeedback("");
      setDone((d) => (d ? { ...d, collectFeedback: false } : d));
      toast({
        title: "Thanks — that's with the product team",
      });
    },
    onError: (e: unknown) => {
      toast({
        title: "Feedback",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    },
  });

  const lastBot = [...messages].reverse().find((m) => m.sender === "BOT");
  const options = done ? [] : (lastBot?.options ?? []);

  // Keep the newest bubble in view — the transcript is a plain overflow
  // container, so past the drawer height every reply lands below the fold.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [open, messages.length, turn.isPending]);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        setOpen(v);
      }}
    >
      <SheetTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <LifeBuoy className="mr-1.5 h-4 w-4" />
            Get help
          </Button>
        )}
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="px-5 pb-3 pt-5">
          <SheetTitle>How can we help?</SheetTitle>
          <SheetDescription>
            {flowId
              ? "Pick an option, or type a message."
              : "Pick a topic, or browse the Help section for quick answers."}
          </SheetDescription>
        </SheetHeader>

        {/* Bottom-aligned like the per-appointment drawer: a short transcript
            sits against the composer rather than at the top of an empty panel. */}
        <div className="flex-1 overflow-y-auto px-5 pb-2">
          <div className="flex min-h-full flex-col justify-end space-y-3">
            {!flowId &&
              (catalog.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : catalog.isError ? (
                <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                  {(catalog.error as Error)?.message ??
                    "Couldn't load support topics."}{" "}
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-1"
                    onClick={() => catalog.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {(catalog.data ?? []).map((f) => (
                    <Button
                      key={f.id}
                      variant="outline"
                      disabled={turn.isPending}
                      className="h-auto justify-start py-2 text-left"
                      onClick={() => startFlow(f)}
                    >
                      <span>
                        <span className="block text-sm font-medium">
                          {f.title}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {f.description}
                        </span>
                      </span>
                    </Button>
                  ))}
                </div>
              ))}

            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.sender === "USER"
                    ? "flex justify-end"
                    : "flex justify-start"
                }
              >
                {/* No per-bubble "USER"/"BOT" caption — side and colour say it. */}
                <div
                  className={
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm transition-opacity " +
                    (m.sender === "USER"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground") +
                    (m.pending ? " opacity-70" : "")
                  }
                >
                  {/* Screen-reader-only speaker attribution: the visual design
                      dropped the captions, and side plus colour say nothing to
                      assistive tech. */}
                  <span className="sr-only">
                    {m.sender === "USER" ? "You said" : "Assistant said"}:{" "}
                  </span>
                  {m.body}
                </div>
              </div>
            ))}

            {turn.isPending && (
              <div className="flex justify-start">
                <div
                  className="flex items-center gap-1 rounded-2xl bg-muted px-3 py-2.5"
                  role="status"
                  aria-label="Support is typing"
                >
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="h-1.5 w-1.5 rounded-full bg-foreground/40 motion-safe:animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {done?.resolved && !done.collectFeedback && (
              <Badge variant="secondary" className="mt-1">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Resolved
              </Badge>
            )}

            {done?.collectFeedback && (
              <div className="space-y-2">
                <Textarea
                  rows={4}
                  maxLength={2000}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="What would you change?"
                />
                <Button
                  size="sm"
                  disabled={!feedback.trim() || sendFeedback.isPending}
                  onClick={() => sendFeedback.mutate(feedback.trim())}
                >
                  Send to the product team
                </Button>
              </div>
            )}
            {done && !done.resolved && done.ticketId && (
              <div className="rounded-lg border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                <Ticket className="mr-1 inline h-3 w-3" />
                {/* The reference is the whole point of minting one: it is what
                  survives the channel change when the user follows up by
                  email or on a call. */}
                {done.ticketReference ? (
                  <>
                    Request{" "}
                    <span className="font-mono text-foreground">
                      {done.ticketReference}
                    </span>{" "}
                    created — quote it if you follow up. Our team will reply
                    here in &quot;My requests&quot; and by email.
                  </>
                ) : (
                  <>
                    Ticket created — our team will reply here in &quot;My
                    requests&quot; and by email.
                  </>
                )}
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        {flowId && !done && (
          <div className="space-y-3 border-t border-border px-5 pb-5 pt-4">
            {options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {options.map((o) => (
                  <Button
                    key={o.id}
                    variant="outline"
                    size="sm"
                    disabled={turn.isPending}
                    onClick={() =>
                      turn.mutate({
                        flowId: flowId!,
                        nodeId,
                        chosenOptionId: o.id,
                        chosenLabel: o.label,
                        epoch: sittingRef.current,
                      })
                    }
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            )}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const msg = text.trim();
                if (msg)
                  turn.mutate({
                    flowId: flowId!,
                    nodeId,
                    userMessage: msg,
                    epoch: sittingRef.current,
                  });
              }}
            >
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type a message…"
                disabled={turn.isPending}
              />
              <Button
                type="submit"
                size="icon"
                disabled={turn.isPending || !text.trim()}
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </Button>
            </form>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
