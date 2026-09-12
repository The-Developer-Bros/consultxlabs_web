"use client";

/**
 * #appt-support — the per-appointment "Get help" surface. A Sheet drawer that
 * drives the channel-agnostic support thread: it renders the flowchart bot's
 * prompts as tap-able options, lets the user type free text, and shows the
 * hand-off state once a turn escalates to a human. It only ever DISPLAYS the
 * actions a resolver requests (e.g. an eligible refund %) — execution is a
 * separate server-validated surface, never fired from here.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, LifeBuoy, Send } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  SupportRequestError,
  throwSupportError,
} from "@/lib/support/error-copy";

type Sender = "USER" | "BOT" | "AGENT" | "SYSTEM";

interface MessageMetadata {
  /** The flow node this message was emitted from — the chip cursor. */
  nodeId?: string;
  options?: { id: string; label: string }[];
}

interface ThreadMessage {
  id: string;
  sender: Sender;
  body: string;
  metadata?: MessageMetadata | null;
  createdAt: string;
  /** Client-only: shown before the server has confirmed the write. */
  pending?: boolean;
}

interface SupportThread {
  id: string;
  status: string;
  activeChannel: string;
  currentNodeId: string | null;
  messages: ThreadMessage[];
  /** Present once escalated — the deadline committed to at intake. */
  supportTicket?: {
    referenceNumber: string | null;
    ackDueAt: string | null;
  } | null;
}

interface ThreadData {
  thread: SupportThread | null;
  intents: { category: string; title: string }[];
}

type SupportAction =
  | { kind: "OFFER_CANCEL_REFUND"; refundPct: number }
  | { kind: string };

interface TurnResult {
  status: string;
  activeChannel: string;
  currentNodeId: string | null;
  /** The bot's own reply. Rendered straight from here — see `onSuccess`. */
  messages: {
    sender: Sender;
    body: string;
    metadata?: MessageMetadata | null;
  }[];
  escalated: boolean;
  resolved: boolean;
  /** False when the server refused the write (thread closed underneath us). */
  accepted?: boolean;
  actions: SupportAction[];
}

/** Ids for locally-rendered bubbles. Never collide with the server's uuids, and
 *  distinguishable in the DOM when a transcript is being debugged. */
let localSeq = 0;
const nextLocalId = () => `local-${++localSeq}`;

/** Append bubbles to the cached thread, synthesising a shell thread on the
 *  first turn (the row does not exist until the server writes it). */
function appendMessages(
  old: ThreadData | undefined,
  msgs: (Omit<ThreadMessage, "id" | "createdAt"> & { id?: string })[],
): ThreadData {
  const base: ThreadData = old ?? { thread: null, intents: [] };
  const thread: SupportThread = base.thread ?? {
    id: "local",
    status: "IN_PROGRESS",
    activeChannel: "SELF_SERVE",
    currentNodeId: null,
    messages: [],
  };
  return {
    ...base,
    thread: {
      ...thread,
      messages: [
        ...thread.messages,
        ...msgs.map((m) => ({
          ...m,
          id: m.id ?? nextLocalId(),
          createdAt: new Date().toISOString(),
        })),
      ],
    },
  };
}

/** One turn's payload, kept so a failed send can be repeated verbatim. */
interface TurnVars {
  category?: string;
  chosenOptionId?: string;
  userMessage?: string;
  /** Client-only echo of what was pressed. Never sent. */
  chosenLabel?: string;
}

/**
 * "We'll reply by 4:30 PM" beats "soon": a concrete wait is what the hand-off
 * research found cuts abandonment, and this one is a promise already made at
 * intake rather than a guess.
 */
/** Announced to assistive tech only — the visual design carries no captions. */
function speakerLabel(sender: Sender): string {
  if (sender === "USER") return "You said";
  if (sender === "AGENT") return "Support said";
  if (sender === "SYSTEM") return "System";
  return "Assistant said";
}

function describeWait(ackDueAt: string | null | undefined): string {
  const FALLBACK = "Our team will reply here and by email.";
  if (!ackDueAt) return FALLBACK;
  const due = new Date(ackDueAt);
  if (Number.isNaN(due.getTime())) return FALLBACK;
  // Past our own deadline — say so rather than showing a promise that lapsed.
  if (due.getTime() < Date.now()) {
    return "Our team is taking longer than usual. You'll get a reply here and by email.";
  }
  const time = due.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (due.toDateString() === new Date().toDateString()) {
    return `Our team will reply by ${time} today.`;
  }
  const day = due.toLocaleDateString([], { day: "numeric", month: "short" });
  return `Our team will reply by ${time} on ${day}.`;
}

function describeAction(a: SupportAction): string | null {
  if (a.kind === "OFFER_CANCEL_REFUND") {
    const pct = "refundPct" in a ? a.refundPct : 0;
    return pct > 0
      ? `You're eligible for a ${pct}% refund if you cancel now.`
      : "Cancelling now is outside the refund window — no refund would apply.";
  }
  if (a.kind === "SHOW_INVOICES") {
    return "Invoices and GST receipts live on your Payments page.";
  }
  return null;
}

export function SupportThreadSheet({
  appointmentId,
  isOrgContext: _isOrgContext = false,
  open: controlledOpen,
  onOpenChange,
  trigger,
  appointmentHref,
}: {
  appointmentId: string;
  isOrgContext?: boolean;
  /** Controlled open state — when set, the sheet renders no default trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Custom trigger node (ignored when `open` is controlled). */
  trigger?: React.ReactNode;
  /** When provided, the header carries a "Go to appointment" link. Deliberately
   *  omitted on org surfaces (ADR 20: no per-session drill-in for org roles). */
  appointmentHref?: string;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [text, setText] = useState("");
  const [lastActions, setLastActions] = useState<SupportAction[]>([]);
  // A failed send stays in the transcript, keyed by its optimistic bubble id,
  // with the payload needed to send it again. A toast disappears and leaves the
  // user unable to tell whether anything was sent.
  // Held in component state, NOT in the query cache: a poll replaces the cache
  // wholesale with server rows, which would take the failed bubble and its
  // Retry with it — the exact thing the user needs in order to recover.
  const [failedTurns, setFailedTurns] = useState<
    Record<string, { body: string; vars: TurnVars }>
  >({});
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = ["support-thread", appointmentId] as const;
  const setOpen = (v: boolean) => {
    onOpenChange?.(v);
    if (controlledOpen === undefined) setInternalOpen(v);
    // Offered actions belong to the sitting that produced them. Left standing,
    // reopening the drawer re-displayed a refund offer from a previous visit.
    if (!v) {
      setLastActions([]);
      setText("");
    }
  };

  // Undo the optimistic bubble. Restoring the pre-turn snapshot is the normal
  // path, but a turn sent before the first GET resolves has NO snapshot to
  // restore — the composer is live while the thread is still loading. Skipping
  // the rollback there left the pending bubble in the cache and added a failed
  // one beside it, so one failed send rendered as two messages until a refetch.
  const rollbackOptimistic = (
    previous: ThreadData | undefined,
    optimisticId: string | undefined,
  ) => {
    if (previous) {
      qc.setQueryData(queryKey, previous);
      return;
    }
    if (!optimisticId) return;
    qc.setQueryData<ThreadData>(queryKey, (old) =>
      old?.thread
        ? {
            ...old,
            thread: {
              ...old.thread,
              messages: old.thread.messages.filter(
                (m) => m.id !== optimisticId,
              ),
            },
          }
        : old,
    );
  };

  const turn = useMutation({
    mutationFn: async ({
      chosenLabel: _chosenLabel,
      ...body
    }: TurnVars): Promise<TurnResult> => {
      const res = await fetch(`/api/appointments/${appointmentId}/support`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) await throwSupportError(res, "support turn");
      const { data } = await res.json();
      return data;
    },
    // Echo the user's turn immediately. Without this a press showed nothing
    // until the POST *and* a follow-up GET had both returned — two serial round
    // trips, which on a cold serverless instance is a long silent gap that
    // reads as the tap having missed.
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<ThreadData>(queryKey);
      const said = vars.userMessage ?? vars.chosenLabel;
      let optimisticId: string | undefined;
      if (said) {
        optimisticId = nextLocalId();
        qc.setQueryData<ThreadData>(queryKey, (old) =>
          appendMessages(old, [
            { id: optimisticId, sender: "USER", body: said, pending: true },
          ]),
        );
      }
      return { previous, optimisticId };
    },
    onSuccess: (result, vars, context) => {
      // The server took the request but refused the write. Treat it exactly
      // like a failure, or the bubble sits there looking delivered.
      if (result.accepted === false) {
        const id = context?.optimisticId;
        const said = vars.userMessage ?? vars.chosenLabel;
        rollbackOptimistic(context?.previous, id);
        if (id && said)
          setFailedTurns((f) => ({ ...f, [id]: { body: said, vars } }));
        toast({
          title: "Support",
          description:
            "Support has closed this conversation, so your message wasn't sent. Start a new request from the help options.",
          variant: "destructive",
        });
        return;
      }
      setLastActions(result.actions ?? []);
      setText("");
      // Merge the server's own reply rather than only invalidating: an
      // invalidation makes the bot's answer wait for a second round trip, and a
      // poll resolving in that window can land pre-turn rows over the top. The
      // confirming refetch still runs behind this and replaces these bubbles
      // with the persisted rows, which carry identical bodies.
      qc.setQueryData<ThreadData>(queryKey, (old) => {
        const merged = appendMessages(
          old,
          result.messages.map((m) => ({
            sender: m.sender,
            body: m.body,
            metadata: m.metadata ?? null,
          })),
        );
        if (!merged.thread) return merged;
        return {
          ...merged,
          thread: {
            ...merged.thread,
            status: result.status,
            activeChannel: result.activeChannel,
            currentNodeId: result.currentNodeId,
            messages: merged.thread.messages.map((m) =>
              m.pending ? { ...m, pending: false } : m,
            ),
          },
        };
      });
      void qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown, vars, context) => {
      // Keep the message where the user put it, marked failed, with a retry —
      // the convention every messaging app uses. Rolling it back and toasting
      // left them unable to tell whether it had sent at all, which is exactly
      // what a connection timeout on a cold instance looked like.
      //
      // A DEFINITE refusal (403/404/400) is different: a retry returns the same
      // answer, so the bubble goes and the reason is shown instead.
      const id = context?.optimisticId;
      const said = vars.userMessage ?? vars.chosenLabel;
      if (e instanceof SupportRequestError && e.isDefinite) {
        rollbackOptimistic(context?.previous, id);
        toast({
          title: "Support",
          description: e.message,
          variant: "destructive",
        });
        return;
      }
      if (id && said) {
        // Roll the cache back to the server's truth and keep the failed message
        // beside it in component state, so a refetch cannot erase it.
        rollbackOptimistic(context?.previous, id);
        setFailedTurns((f) => ({ ...f, [id]: { body: said, vars } }));
      } else {
        toast({
          title: "Support",
          description: e instanceof Error ? e.message : "Please try again.",
          variant: "destructive",
        });
      }
    },
  });

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey,
    enabled: open,
    // Staff reply into this thread from the ops queue and nothing pushes that
    // down, so without polling the reply sits in the database until the user
    // closes and reopens the sheet — the thread reads as one-sided. Bounded on
    // four sides: only while the sheet is open (`enabled`), never once the
    // thread is settled, never in a background tab (the react-query default),
    // and never while a turn is in flight — a poll that resolves after the
    // optimistic write would otherwise put the pre-turn transcript back.
    refetchInterval: (query) => {
      if (turn.isPending) return false;
      const status = query.state.data?.thread?.status;
      return status === "RESOLVED" || status === "CLOSED" ? false : 15_000;
    },
    queryFn: async (): Promise<ThreadData> => {
      const res = await fetch(`/api/appointments/${appointmentId}/support`);
      if (!res.ok) await throwSupportError(res, "thread load");
      const json = await res.json();
      return { thread: json.data, intents: json.intents ?? [] };
    },
  });
  const thread = data?.thread ?? null;

  // Server-gated intents win; there is NO static fallback. An empty gated list
  // is a SUCCESSFUL answer — every intent was gated out for this stage and role
  // — so falling back would re-offer precisely what the server withheld (a
  // no-show chip on an upcoming session, a recording chip on one that never
  // started). On a genuine error we say so and offer a retry instead.
  const availableIntents = data
    ? data.intents.map((i) => ({ category: i.category, label: i.title }))
    : [];

  const messages = thread?.messages ?? [];
  const isHuman = thread?.activeChannel === "HUMAN";
  const isResolved = thread?.status === "RESOLVED";
  // Chips come from the message that sits AT the server's cursor, not from
  // whichever BOT message happens to be last. Those two can drift, and a chip
  // whose option id the server no longer recognises spends a whole round trip
  // to answer "I didn't catch that".
  const cursor = thread?.currentNodeId ?? null;
  const activePrompt = cursor
    ? [...messages]
        .reverse()
        .find((m) => m.sender === "BOT" && m.metadata?.nodeId === cursor)
    : undefined;
  const options =
    !isHuman && !isResolved ? (activePrompt?.metadata?.options ?? []) : [];
  const started = !!thread;
  const turnPending = turn.isPending;
  // `turnPending` is React state, so two clicks in the same tick both read the
  // stale value and both fire. A ref flips synchronously and stops the second
  // before it leaves the browser — which also spares a pool where
  // PG_POOL_MAX=1 serialises everything an entirely wasted round trip.
  const inFlight = useRef(false);
  const submitTurn = (vars: TurnVars) => {
    if (inFlight.current) return;
    inFlight.current = true;
    turn.mutate(vars, { onSettled: () => (inFlight.current = false) });
  };
  // The hand-off sits immediately before the first AGENT message. A thread that
  // has escalated but whose staff reply has not landed yet still gets the
  // marker, at the end — otherwise the drawer looks like the bot simply gave
  // up on the user.
  const retryTurn = (id: string) => {
    const failed = failedTurns[id];
    // Check the in-flight guard BEFORE dropping the entry. `submitTurn` returns
    // silently while another turn is out, so deleting first meant a Retry
    // pressed during an in-flight send erased the message and never resent it —
    // losing the very text the Retry existed to protect.
    if (!failed || inFlight.current) return;
    setFailedTurns(({ [id]: _gone, ...rest }) => rest);
    submitTurn(failed.vars);
  };

  const waitingLine = describeWait(thread?.supportTicket?.ackDueAt);

  const firstAgent = messages.findIndex((m) => m.sender === "AGENT");
  const handoffIndex =
    firstAgent >= 0 ? firstAgent : isHuman ? messages.length : -1;

  // Keep the newest bubble in view. The transcript is a plain overflow
  // container, so past the drawer height every reply lands below the fold and
  // the drawer looks like it stopped responding.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [open, messages.length, turnPending]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* Controlled-open call sites render no trigger: a hidden placeholder
          would swallow Radix's focus return and dump keyboard users on body. */}
      {controlledOpen === undefined && (
        <SheetTrigger asChild>
          {trigger ?? (
            <Button variant="outline" size="sm">
              <LifeBuoy className="mr-1.5 h-4 w-4" />
              Get help
            </Button>
          )}
        </SheetTrigger>
      )}
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="px-5 pb-3 pt-5">
          <div className="flex items-start justify-between gap-2 pr-6">
            <SheetTitle>Help with this session</SheetTitle>
            {appointmentHref && (
              <Button variant="outline" size="sm" asChild className="shrink-0">
                <Link href={appointmentHref}>
                  <CalendarDays className="mr-1.5 h-4 w-4" />
                  Go to appointment
                </Link>
              </Button>
            )}
          </div>
          <SheetDescription>
            {isHuman
              ? "You're connected with our support team — they'll reply here."
              : "Pick what you need help with, or type a message."}
          </SheetDescription>
        </SheetHeader>

        {/* Conversation. The inner wrapper bottom-aligns a short transcript
            against the composer instead of stranding it at the top of an empty
            panel, and still scrolls normally once it outgrows the drawer. */}
        <div className="flex-1 overflow-y-auto px-5 pb-2">
          <div className="flex min-h-full flex-col justify-end space-y-3">
            {!started && (
              <p className="text-sm text-muted-foreground">
                What do you need help with?
              </p>
            )}
            {messages.map((m, i) => (
              <div key={m.id}>
                {/* Where the bot stopped and a person took over. Without it the
                    hand-off is invisible inside the drawer even though the page
                    behind it says "With our team". */}
                {i === handoffIndex && (
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-[11px] text-muted-foreground">
                      Passed to our support team
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div
                  className={
                    m.sender === "USER"
                      ? "flex justify-end"
                      : "flex justify-start"
                  }
                >
                  {/* No "USER"/"BOT" caption: nobody labels their own messages,
                      and "BOT" contradicted the header's "you're connected with
                      our support team". Side and colour carry the speaker; the
                      divider above carries who is answering. */}
                  <div
                    className={
                      "max-w-[85%] rounded-2xl px-3 py-2 text-sm transition-opacity " +
                      (m.sender === "USER"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground") +
                      (m.pending ? " opacity-70" : "")
                    }
                  >
                    {/* Dropping the visible USER/BOT captions removed the only
                        speaker attribution a screen reader had — side and colour
                        are visual-only. This restores it without restoring the
                        clutter. */}
                    <span className="sr-only">{speakerLabel(m.sender)}: </span>
                    {m.body}
                  </div>
                </div>
              </div>
            ))}

            {/* The bot is working. Uber's own write-up calls this out as the
              contract of a request/response flow engine: the user waits, and a
              visual indicator tells them why. */}
            {/* The honest version of "we're on it": the deadline we already
                committed to at intake, rather than an indefinite spinner. */}
            {isHuman && !isResolved && waitingLine && (
              <p className="text-center text-[11px] text-muted-foreground">
                {waitingLine}
              </p>
            )}

            {/* Failed sends, kept out of the cache so a poll cannot erase them. */}
            {Object.entries(failedTurns).map(([id, f]) => (
              <div key={id} className="flex justify-end">
                <div className="max-w-[85%]">
                  <div className="rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground opacity-60 ring-1 ring-destructive">
                    <span className="sr-only">You said: </span>
                    {f.body}
                  </div>
                  <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-destructive">
                    <span>Not sent</span>
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => retryTurn(id)}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {handoffIndex === messages.length && (
              <div className="flex items-center gap-2">
                <span className="h-px flex-1 bg-border" />
                <span className="text-[11px] text-muted-foreground">
                  Passed to our support team
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}

            {/* Only while the flowchart is answering. Once the thread is with a
                human there is nobody composing anything, and dots promising an
                imminent reply on an asynchronous hand-off is the single thing
                the research says loses people. */}
            {turnPending && !isHuman && (
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

            {/* Offered actions from the latest turn (informational, not executed) */}
            {lastActions.map(describeAction).map((desc, i) =>
              desc ? (
                <div
                  key={i}
                  className="rounded-lg border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground"
                >
                  {desc}
                </div>
              ) : null,
            )}

            {isResolved && (
              <Badge variant="secondary" className="mt-1">
                Resolved
              </Badge>
            )}
            <div ref={endRef} />
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-3 border-t border-border px-5 pb-5 pt-4">
          {!started ? (
            isError ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  Couldn&apos;t load the help options for this session.
                </p>
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  Retry
                </Button>
              </div>
            ) : availableIntents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isFetching
                  ? "Loading…"
                  : "There are no help options for this session right now."}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableIntents.map((i) => (
                  <Button
                    key={i.category}
                    variant="outline"
                    size="sm"
                    disabled={turnPending}
                    onClick={() =>
                      submitTurn({
                        category: i.category,
                        chosenLabel: i.label,
                      })
                    }
                  >
                    {i.label}
                  </Button>
                ))}
              </div>
            )
          ) : (
            options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {options.map((o) => (
                  <Button
                    key={o.id}
                    variant="outline"
                    size="sm"
                    disabled={turnPending}
                    onClick={() =>
                      submitTurn({
                        chosenOptionId: o.id,
                        chosenLabel: o.label,
                      })
                    }
                  >
                    {o.label}
                  </Button>
                ))}
              </div>
            )
          )}

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const msg = text.trim();
              if (msg) submitTurn({ userMessage: msg });
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={isHuman ? "Message support…" : "Type a message…"}
              disabled={turnPending}
            />
            <Button
              type="submit"
              size="icon"
              disabled={turnPending || !text.trim()}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
