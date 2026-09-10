"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";
import Image from "next/image";
import { useChatPane } from "./ChatPaneContext";
import { useChatContext } from "stream-chat-react";
import { SearchIcon, UserIcon, VideoIcon, BookOpenIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AppointmentSearchResult } from "@/schemas/stream-search";

// Type badge configuration for events (webinars/classes)
const EVENT_TYPE_CONFIG = {
  webinar: {
    label: "Webinar",
    icon: VideoIcon,
  },
  class: {
    label: "Class",
    icon: BookOpenIcon,
  },
} as const;

/** A search hit for a group event. Narrower than AppointmentSearchResult. */
type EventSearchResult = AppointmentSearchResult & {
  type: "webinar" | "class";
};

const isEventResult = (r: AppointmentSearchResult): r is EventSearchResult =>
  r.type === "webinar" || r.type === "class";

/**
 * What `/api/stream/channels/open` accepts.
 *
 * A discriminated union rather than `Record<string, unknown>`: the route parses
 * this with a zod discriminated union, and typing the client side as an open
 * bag meant a wrong `eventType` — `"consultation"` reaching the event arm, say —
 * failed at runtime with a 400 instead of at compile time. The route is the
 * authority on the shape; this mirrors it.
 */
type OpenChannelRequest =
  | { kind: "dm"; counterpartyUserId: string; organizationId: string | null }
  | { kind: "event"; eventType: "webinar" | "class"; eventId: string };

/**
 * One row per conversation: a consultation and a subscription with the same
 * person collapse into a single entry, because they are a single channel.
 * A pair has one DM thread per funding context (#1134 P0-7), so the badges
 * "Consultation & Subscription" describe two reasons to be in one thread, not
 * two threads.
 */
type GroupedConversation = {
  counterpartyName: string;
  counterpartyImage?: string;
  counterpartyUserId?: string;
  organizationId?: string | null;
  hasConsultation: boolean;
  hasSubscription: boolean;
  channelId: string;
  /**
   * The plan titles behind this row, deduplicated.
   *
   * Rendered because the route matches on plan title as well as on names, so a
   * row could match a query the UI never showed: searching "michael" surfacing
   * a conversation with Robert Brown is correct if Robert booked a plan called
   * "Michael's…", but with only the counterparty's name on screen it reads as a
   * broken search. One row can hold more than one title — a consultation and a
   * subscription with the same person share a channel.
   */
  planTitles: string[];
};

export const ChannelSearch = () => {
  const { client, setActiveChannel } = useChatContext();
  // Below `md` the conversation pane is `hidden` until this runs — see
  // ChatLayout. Selecting a channel without it leaves the person staring at
  // the list they just searched, with the channel silently active behind it.
  const { openConversation } = useChatPane();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<AppointmentSearchResult[]>(
    [],
  );
  /** Why the last open attempt failed, shown inside the dropdown. */
  const [openError, setOpenError] = useState<string | null>(null);
  /**
   * The query `searchResults` actually answers.
   *
   * Without this there is no way to distinguish "searched and found nothing"
   * from "have not searched yet", and the empty state rendered during the
   * 300ms debounce gap — announcing "No results found for michael" before a
   * request had been issued, on every keystroke, while the matching person sat
   * in the list underneath.
   */
  const [settledQuery, setSettledQuery] = useState("");
  /**
   * A search that FAILED, as distinct from one that found nothing.
   *
   * The catch used to set `settledQuery` and leave the results empty, which is
   * indistinguishable from a successful empty search — so a 500 or a dropped
   * connection rendered as "No results found for michael". That is the most
   * misleading thing it could say: it tells you the person does not exist.
   */
  const [searchError, setSearchError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /**
   * Latest-wins guard, mirroring `hooks/scheduling/useCalendarData.ts`.
   *
   * The AbortController below stops the NETWORK work, but a response that has
   * already been parsed is past the point of cancellation and still queued for
   * React's state pipeline. Only the response matching the most recently issued
   * request may commit — checked before every setState, including the one that
   * clears `loading`, because a stale reply's `finally` otherwise turns the
   * spinner off while a newer request is still in flight.
   */
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Extracted from the memo below to keep its cognitive complexity under the
  // threshold SonarCloud enforces. The merge rule is the interesting part
  // anyway: a consultation and a subscription with the same person are two
  // reasons to be in ONE thread, not two threads.
  const mergeConversationRow = (
    byChannel: Map<string, GroupedConversation>,
    result: AppointmentSearchResult,
  ) => {
    const existing = byChannel.get(result.channelId);
    if (existing) {
      existing.hasConsultation ||= result.type === "consultation";
      existing.hasSubscription ||= result.type === "subscription";
      if (!existing.planTitles.includes(result.name)) {
        existing.planTitles.push(result.name);
      }
      return;
    }
    byChannel.set(result.channelId, {
      counterpartyName: result.counterpartyName,
      counterpartyImage: result.counterpartyImage,
      counterpartyUserId: result.counterpartyUserId,
      organizationId: result.organizationId,
      hasConsultation: result.type === "consultation",
      hasSubscription: result.type === "subscription",
      channelId: result.channelId,
      planTitles: [result.name],
    });
  };

  // Group 1:1 rows by CHANNEL, keep events separate.
  //
  // Keyed on `channelId`, not on the display name. Grouping by name merged two
  // different people who happen to share one — and, more often here, split a
  // single conversation in two whenever the name resolved differently between
  // rows. The channel id is the identity of a conversation; the name is a label
  // on it.
  const { groupedConversations, events } = useMemo(() => {
    const byChannel = new Map<string, GroupedConversation>();
    const eventResults: EventSearchResult[] = [];

    // Defensive check in case searchResults is undefined
    if (!searchResults || !Array.isArray(searchResults)) {
      return { groupedConversations: [], events: [] };
    }

    for (const result of searchResults) {
      if (isEventResult(result)) {
        eventResults.push(result);
      } else {
        mergeConversationRow(byChannel, result);
      }
    }

    return {
      groupedConversations: Array.from(byChannel.values()),
      events: eventResults,
    };
  }, [searchResults]);

  const runSearch = useCallback(async (raw: string) => {
    const term = raw.trim();

    // Abort whatever is still in flight. Nobody is waiting on it, and on a
    // route that fires every 300ms of typing the abandoned work is real server
    // cost, not just a wasted response.
    abortRef.current?.abort();

    if (term.length < 2) {
      abortRef.current = null;
      setSearchResults([]);
      setSettledQuery("");
      setSearchError(null);
      setLoading(false);
      // Cleared here too. `handleSearch` used to early-return BEFORE the
      // setOpenError below, so a 403 refusal outlived the input that produced
      // it: emptying the box left an error panel floating over a blank search,
      // and `isOpen` kept the dropdown up with no way to dismiss it.
      setOpenError(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    // Bumped synchronously, before the first await, so two searches started in
    // the same tick still get distinct ids.
    const requestId = ++requestIdRef.current;

    try {
      setLoading(true);
      // A refusal from the previous attempt must not outlive the query that
      // caused it.
      setOpenError(null);
      setSearchError(null);

      const response = await fetch(
        `/api/stream/channels/search-appointments?q=${encodeURIComponent(term)}`,
        { signal: controller.signal },
      );

      if (!response.ok) {
        throw new Error("Failed to search appointments");
      }

      const results: AppointmentSearchResult[] = await response.json();

      if (requestId !== requestIdRef.current) return;
      setSearchResults(results);
      setSettledQuery(term);
    } catch (error) {
      // An abort is this component cancelling its own request, not a failure.
      // Treating it as one would clear the results the newer request is about
      // to populate.
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== requestIdRef.current) return;
      console.error("Error searching appointments:", error);
      setSearchResults([]);
      setSettledQuery(term);
      setSearchError("Search is unavailable right now. Please try again.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  // 300ms, matching the five other search inputs in the app, and now via the
  // same `use-debounce` helper they use rather than a hand-rolled setTimeout.
  // The delay was never what felt slow — the empty-state flash inside it was.
  const debouncedSearch = useDebouncedCallback(runSearch, 300);

  useEffect(() => {
    debouncedSearch(query);
  }, [query, debouncedSearch]);

  // Abort anything outstanding when the component goes away, so a resolved
  // fetch cannot setState on an unmounted tree.
  useEffect(
    () => () => {
      // `use-debounce` v10 does NOT auto-cancel on unmount, so a trailing
      // callback can fire after the component is gone and start a search
      // nobody is waiting for. Abort covers a request already issued; cancel
      // covers one still sitting in the timer.
      debouncedSearch.cancel();
      abortRef.current?.abort();
    },
    [debouncedSearch],
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Submit means "now", so skip the pending debounce rather than adding a
    // second in-flight request alongside it.
    debouncedSearch.flush();
  };

  /**
   * Dismiss the dropdown on an outside click or Escape.
   *
   * Neither existed. The only way to close this was to pick a result or empty
   * the input, so a search you had changed your mind about stayed on screen
   * over the channel list indefinitely — and once a failed open stopped
   * clearing the query, there was no way to close it at all.
   *
   * `pointerdown`, not `click`: a `click` listener fires after the button's own
   * handler and after focus moves, which on a touch device closed the panel
   * before the tap that opened a row could land.
   */
  const dismiss = useCallback(() => {
    // Clear the TERM too, not just the rows: `isOpen`/`showNoResults` derive
    // from the settled query, so leaving it set turned dismiss into "replace
    // the results with No results found".
    setQuery("");
    setSettledQuery("");
    setSearchResults([]);
    setOpenError(null);
    setSearchError(null);
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dismiss]);

  /**
   * Ask the SERVER for the channel, then watch what it hands back.
   *
   * The previous implementation called `client.channel(type, id).watch()` on an
   * id this component had received from search. `watch()` posts to Stream's
   * channel *query* endpoint, which is the same endpoint `create()` posts to —
   * so when the id did not exist yet, watching it CREATED it, with this user as
   * `created_by` and with no members at all. The result was a channel titled
   * with its own raw id, reporting "No members", that accepted a message and
   * then disappeared on refresh (the sidebar lists `members: { $in: [me] }`).
   *
   * So the client no longer names a channel. It names a person or an event, and
   * `/api/stream/channels/open` re-derives the id, checks the booking link, and
   * creates the channel with both members if it is genuinely missing. By the
   * time `watch()` runs here, the channel is known to exist.
   */
  const openResolvedChannel = async (
    body: OpenChannelRequest,
  ): Promise<void> => {
    if (!client) return;
    setOpenError(null);

    try {
      const response = await fetch("/api/stream/channels/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        // A 403 here is the eligibility gate refusing, which is a legitimate
        // answer rather than a fault — but it still has to be SAID. This branch
        // used to `console.error` and return, and because the return skipped the
        // reset at the bottom of the function, the dropdown stayed open with the
        // same rows and no explanation. It read as a frozen menu.
        setOpenError(
          detail?.error ??
            "Could not open this conversation. Please try again.",
        );
        return;
      }

      const { channelType, channelId } = (await response.json()) as {
        channelType: "messaging" | "team";
        channelId: string;
      };

      const channel = client.channel(channelType, channelId);
      await channel.watch();
      setActiveChannel(channel);
      openConversation();
      // Only cleared on the success path. On a refusal the query is kept so the
      // message below has something to sit under and the person can pick a
      // different row.
      setQuery("");
      setSearchResults([]);
    } catch (error) {
      console.error("Error opening channel:", error);
      setOpenError("Could not open this conversation. Please try again.");
    }
  };

  const handleConversationClick = (conversation: GroupedConversation) => {
    // Group-event rows carry no counterparty, and a malformed payload would be
    // rejected by the route's zod schema as a 400 — a worse message than this
    // one. Guard rather than round-trip.
    if (!conversation.counterpartyUserId) {
      setOpenError("This conversation is missing its participant.");
      return;
    }
    void openResolvedChannel({
      kind: "dm",
      counterpartyUserId: conversation.counterpartyUserId,
      organizationId: conversation.organizationId ?? null,
    });
  };

  const handleEventClick = (result: EventSearchResult) =>
    void openResolvedChannel({
      kind: "event",
      eventType: result.type,
      eventId: result.id,
    });

  const hasResults = groupedConversations.length > 0 || events.length > 0;
  const term = query.trim();
  /**
   * True from the keystroke until a response for THIS query has committed —
   * covering the debounce wait, which `loading` does not, because `loading`
   * only goes true once the fetch actually starts 300ms later.
   */
  const isPending = term.length >= 2 && (loading || settledQuery !== term);
  const showNoResults =
    term.length >= 2 && !isPending && !hasResults && searchError === null;
  const isOpen =
    hasResults || openError !== null || searchError !== null || showNoResults;

  return (
    <div className="channel-search relative" ref={containerRef}>
      <form onSubmit={handleSearchSubmit} className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 w-full text-sm normal-case"
        />
      </form>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-popover text-popover-foreground rounded-md shadow-xl border border-border max-h-72 overflow-auto">
          {openError && (
            <div
              role="status"
              className="px-3 py-2 text-sm text-muted-foreground border-b border-border last:border-b-0"
            >
              {openError}
            </div>
          )}
          {searchError && (
            <div
              role="status"
              className="px-3 py-2 text-sm text-destructive border-b border-border last:border-b-0"
            >
              {searchError}
            </div>
          )}
          {/*
            The empty state lives INSIDE the dropdown now. It used to be a
            second absolutely-positioned box carrying identical
            `absolute z-50 mt-1 w-full` classes, so whenever a refusal coexisted
            with an empty result set the two rendered on top of each other at
            the same coordinates.
          */}
          {showNoResults && (
            <div className="p-4 text-center text-sm text-muted-foreground">
              No results found for &ldquo;{query}&rdquo;
            </div>
          )}
          {/* Conversations Section (Consultants with consultations/subscriptions) */}
          {groupedConversations.length > 0 && (
            <>
              <div className="px-3 py-2 bg-muted border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Conversations
                </span>
              </div>
              {groupedConversations.map((conversation) => (
                <button
                  key={conversation.channelId}
                  type="button"
                  className="p-3 hover:bg-muted cursor-pointer w-full text-left border-b border-border last:border-b-0"
                  onClick={() => handleConversationClick(conversation)}
                >
                  <div className="flex items-center gap-3">
                    {/* Consultant Image */}
                    {conversation.counterpartyImage ? (
                      <Image
                        src={conversation.counterpartyImage}
                        alt={conversation.counterpartyName}
                        width={40}
                        height={40}
                        className="w-10 h-10 rounded-full flex-shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                        <span className="text-muted-foreground font-medium">
                          {conversation.counterpartyName.charAt(0)}
                        </span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      {/* Consultant Name */}
                      <div className="font-semibold text-foreground truncate">
                        {conversation.counterpartyName}
                      </div>

                      {/* Type indicators */}
                      <div className="flex items-center gap-1 mt-1">
                        <UserIcon className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {conversation.hasConsultation &&
                          conversation.hasSubscription
                            ? "Consultation & Subscription"
                            : conversation.hasConsultation
                              ? "Consultation"
                              : "Subscription"}
                        </span>
                      </div>

                      {/* What matched — see GroupedConversation.planTitles */}
                      {conversation.planTitles.length > 0 && (
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {conversation.planTitles.join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </>
          )}

          {/* Events Section (Webinars/Classes) */}
          {events.length > 0 && (
            <>
              <div className="px-3 py-2 bg-muted border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Events
                </span>
              </div>
              {events.map((event) => {
                const config =
                  EVENT_TYPE_CONFIG[event.type as "webinar" | "class"];
                const Icon = config.icon;

                return (
                  <button
                    key={`${event.type}-${event.id}`}
                    type="button"
                    className="p-3 hover:bg-muted cursor-pointer w-full text-left border-b border-border last:border-b-0"
                    onClick={() => handleEventClick(event)}
                  >
                    <div className="flex items-start gap-3">
                      {/* Consultant Image */}
                      {event.counterpartyImage ? (
                        <Image
                          src={event.counterpartyImage}
                          alt={event.counterpartyName}
                          width={40}
                          height={40}
                          className="w-10 h-10 rounded-full flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                          <span className="text-muted-foreground font-medium">
                            {event.counterpartyName.charAt(0)}
                          </span>
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        {/* Event Name */}
                        <div className="font-semibold text-foreground truncate">
                          {event.name}
                        </div>

                        {/* Type Badge + Consultant Name */}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground text-xs font-medium">
                            <Icon className="w-3 h-3" />
                            {config.label}
                          </span>
                          <span className="text-sm text-muted-foreground truncate">
                            {event.counterpartyName}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
};
