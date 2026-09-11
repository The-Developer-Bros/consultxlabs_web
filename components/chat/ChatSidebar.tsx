"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDistanceToNow } from "date-fns";
import { RefreshCwIcon } from "lucide-react";
import {
  useEffect,
  useState,
  useCallback,
  useRef,
  memo,
  startTransition,
} from "react";
import type { Channel, Event } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { ChannelSearch } from "./ChannelSearch";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { InitializeUserChannelsButton } from "./InitializeUserChannelsButton";
import { DebugDialog } from "./DebugDialog";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  buildOrgChannelFilter,
  getChannelDisplayInfo,
  isUsableDmChannel,
} from "./utils/channelUtils";
import { useChatPane } from "./ChatPaneContext";
import { useOrgScope } from "@/hooks/useOrgScope";
import { scopeOrgId } from "@/lib/api/scope/parse";
import { useSession } from "@/lib/auth-client";
import { useServerSessionFacts } from "@/components/dashboard/ServerUserId";

// Custom channel item component for the sidebar - memoized for performance
const ChannelItem = memo(
  ({
    channel,
    isActive,
    onClick,
  }: {
    channel: Channel;
    isActive: boolean;
    onClick: () => void;
  }) => {
    const { client } = useChatContext();
    const isTeamChannel = channel.type === "team";

    // Get display info using shared utility
    const displayInfo = !isTeamChannel
      ? getChannelDisplayInfo(channel, client?.userID)
      : {
          displayName: channel.data?.name || channel.id || "",
          displayImage: undefined,
          isGroupDM: false,
          memberCount: Object.keys(channel.state.members || {}).length,
          statusText: "",
          fullGroupName: undefined,
        };

    const displayName = displayInfo.displayName;
    const displayImage = displayInfo.displayImage;
    const isGroupDM = displayInfo.isGroupDM;
    const memberCount = displayInfo.memberCount;

    // Get unread count directly from the channel
    const unreadCount = channel.countUnread();
    const hasUnread = unreadCount > 0;

    // Last message preview and timestamp
    const messages = channel.state.messages;
    const lastMessage =
      messages.length > 0 ? messages[messages.length - 1] : null;
    const lastMessageText = lastMessage?.text
      ? lastMessage.text.length > 30
        ? lastMessage.text.substring(0, 30) + "..."
        : lastMessage.text
      : lastMessage
        ? "Sent an attachment"
        : null;
    const lastMessageTime = lastMessage?.created_at
      ? formatDistanceToNow(new Date(lastMessage.created_at), {
          addSuffix: false,
        })
      : null;

    return (
      <button
        onClick={onClick}
        // Hover used to be the same blue-700 as the active row, so pointing at
        // any conversation made it look selected.
        className={`w-full text-left px-4 py-2 transition-colors ${isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
        title={displayName}
        aria-current={isActive ? "true" : undefined}
      >
        <div className="flex items-center min-w-0">
          {/* Avatar / channel icon */}
          {isTeamChannel ? (
            <span className="text-muted-foreground mr-2 flex-shrink-0">#</span>
          ) : (
            <div className="relative mr-2 flex-shrink-0">
              <Avatar className="w-6 h-6">
                {/* No placeholder fallback src — it always loaded, so the
                    initials below were unreachable. */}
                <AvatarImage src={displayImage} />
                <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
              </Avatar>
              {isGroupDM && (
                <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-primary rounded-full border border-card flex items-center justify-center">
                  <span className="text-[8px] text-primary-foreground font-bold">
                    G
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Two-row content area */}
          <div className="flex-1 min-w-0">
            {/* Row 1: channel name + timestamp */}
            <div className="flex items-center justify-between">
              <span
                className={`font-medium truncate ${hasUnread ? "font-bold" : ""}`}
                title={
                  isGroupDM
                    ? displayInfo.fullGroupName ||
                      `Group chat with ${memberCount} members`
                    : displayName
                }
              >
                {displayName}
              </span>
              {lastMessageTime && (
                <span className="text-[10px] text-muted-foreground ml-2 flex-shrink-0">
                  {lastMessageTime}
                </span>
              )}
            </div>

            {/* Row 2: last message preview + unread badge */}
            <div className="flex items-center justify-between">
              {lastMessageText ? (
                <span className="text-xs text-muted-foreground truncate">
                  {lastMessageText}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground italic truncate">
                  No messages yet
                </span>
              )}
              {hasUnread && (
                <div className="bg-destructive text-destructive-foreground text-xs rounded-full w-5 h-5 flex items-center justify-center ml-2 flex-shrink-0">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </div>
              )}
            </div>
          </div>
        </div>
      </button>
    );
  },
);

ChannelItem.displayName = "ChannelItem";

// One loading language across chat: the same Skeleton primitive the rest of
// the dashboard uses, shaped like the rows it stands in for.
const ChannelListSkeleton = () => (
  <div className="space-y-2 p-4">
    {[1, 2, 3].map((i) => (
      <div key={i} className="flex items-center gap-3">
        <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
        <div className="flex-1 space-y-1">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

export const ChatSidebar = () => {
  const { client, setActiveChannel } = useChatContext();
  const { openConversation } = useChatPane();
  // The app role, NOT `client.user.role` — mapRoleToStream collapses every
  // non-staff account to Stream's `"user"`, so the old `=== "consultant"`
  // check here could never be true.
  const { data: session } = useSession();
  const serverFacts = useServerSessionFacts();
  const appRole = session?.user?.role ?? serverFacts.role;
  const isConsultant = appRole === "CONSULTANT";
  // Channels can only be created against a webinar or class the viewer hosts,
  // so a consultee's dropdown had exactly one entry: "No events found".
  const canCreateChannels =
    isConsultant || appRole === "ADMIN" || appRole === "STAFF";
  // Route-pinned under /dashboard/organization/[orgId]/ — that mount scopes
  // itself to the org and this option is ignored there. Everywhere else this
  // component renders is a PERSONAL dashboard, and ADR 19 pins personal to
  // `organizationId: null`, so B2C is the right default rather than the hook's
  // `first-org` (which silently hid a member's B2C threads behind whichever org
  // happened to be first, and hid a second org's entirely).
  const { scope } = useOrgScope({ defaultForOrgMember: "personal" });
  const [teamChannels, setTeamChannels] = useState<Channel[]>([]);
  const [directMessages, setDirectMessages] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  // #248: mirror activeChannelId into a ref so handleChannelDeleted can read the
  // current selection WITHOUT depending on the state. Without this, every
  // channel selection changed handleChannelDeleted's identity, which re-ran the
  // event-listener effect and detached/re-attached the Stream listener on each
  // click. The listener effect now depends only on `client`.
  const activeChannelIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialSelectionDoneRef = useRef(false);
  // #248 dedupe: guard against overlapping/duplicate channel fetches. The
  // sidebar effect used to re-run (and refetch) on every channel selection and
  // on useCallback identity churn, firing the queryChannels storm. We track the
  // *key* (client+scope) currently in flight, not just a boolean: skipping only
  // the SAME key means an org-scope switch DURING an in-flight fetch is not
  // silently dropped (the prior bug left the new scope marked "fetched" while
  // showing the old scope's data).
  const inFlightFetchKeyRef = useRef<string | null>(null);
  // Tracks the client+scope we've SUCCESSFULLY fetched for, so the initial-fetch
  // effect is a no-op on unrelated re-renders. Recorded only after a request
  // succeeds (not when a fetch is skipped) so a skipped/failed fetch never
  // marks a scope as done. Refetch still happens on a genuine client/scope change.
  const fetchedKeyRef = useRef<string | null>(null);
  /**
   * How many rows Stream has actually returned per list, before filtering.
   *
   * The pagination offset must count what the SERVER has handed over, not what
   * survived `isUsableDmChannel`. Using `directMessages.length` meant every
   * phantom dropped from a page shifted the next offset backwards by one, so
   * page two re-fetched rows already on screen and the tail of the list became
   * unreachable — the filter silently ate the pagination.
   */
  const fetchedCountRef = useRef<{ team: number; messaging: number }>({
    team: 0,
    messaging: 0,
  });

  // Pagination state
  const [hasMoreTeamChannels, setHasMoreTeamChannels] = useState(true);
  const [hasMoreDMChannels, setHasMoreDMChannels] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Stable key for the current (client + org-scope) pair. Both the in-flight
  // guard and the "already fetched" record key off this so a scope switch is a
  // genuinely different key (and thus never skipped against an unrelated fetch).
  const computeFetchKey = useCallback((): string | null => {
    if (!client?.userID) return null;
    // scopeOrgId, not `kind === "org"`: `orgMember` pins an org too, so keying
    // on the kind alone gave two different orgs the SAME cache key (#674).
    const pinnedOrgId = scopeOrgId(scope);
    const scopeKey = pinnedOrgId ? `org:${pinnedOrgId}` : scope.kind;
    return `${client.userID}::${scopeKey}`;
  }, [client, scope]);

  // Function to fetch channels initially and on significant changes
  const fetchChannels = useCallback(async () => {
    if (!client?.userID) {
      // Don't set loading to false here, wait for client
      return;
    }

    const fetchKey = computeFetchKey();

    // #248 dedupe: skip only if the SAME key is already in flight. A different
    // key (e.g. an org-scope switch mid-fetch) must proceed so the new scope
    // actually loads instead of inheriting the in-flight scope's result.
    if (inFlightFetchKeyRef.current === fetchKey) {
      return;
    }
    inFlightFetchKeyRef.current = fetchKey;

    setIsLoading(true);
    setError(null);

    try {
      // #674 org-scope filter — see buildOrgChannelFilter for what each scope
      // kind means and why `orgMember` has to pin too.
      const orgFilter: Record<string, unknown> = buildOrgChannelFilter(scope);
      const filter = {
        members: { $in: [client.userID] },
        ...orgFilter,
      };
      const sort: { last_message_at: -1 } = { last_message_at: -1 };
      const options = {
        watch: true, // Crucial for real-time updates
        state: true,
        limit: 20, // Reduced initial limit for faster loading
        // Sidebar previews need recent context, not full history: 100/channel ×
        // 40 channels hydrated ~4,000 messages just to paint a list (Stream's
        // storage-and-bandwidth guidance: align limits with actual need).
        // Opening a channel paginates deeper history on demand.
        message_limit: 10,
        presence: false, // Disable presence for initial load to improve performance
      };

      // Fetch channels in parallel
      const [teamResponse, dmResponse] = await Promise.all([
        client.queryChannels({ ...filter, type: "team" }, sort, options),
        client.queryChannels({ ...filter, type: "messaging" }, sort, options),
      ]);

      // Staleness guard: if a newer-keyed fetch (e.g. a scope switch) started
      // while this request was in flight, drop this late response instead of
      // overwriting the current scope's channels with the old scope's data.
      if (inFlightFetchKeyRef.current !== fetchKey) {
        return;
      }

      const usableDms = dmResponse.filter(isUsableDmChannel);

      setTeamChannels(teamResponse);
      // Phantoms filtered out here rather than hidden at render: a row that is
      // merely styled as unavailable is still selectable, still opens, and still
      // accepts a message. See isUsableDmChannel.
      setDirectMessages(usableDms);

      // Raw counts, for the next page's offset.
      fetchedCountRef.current = {
        team: teamResponse.length,
        messaging: dmResponse.length,
      };

      // Update pagination state — measured against the RAW response length, not
      // the filtered one. `response.length === limit` is Stream's
      // "there may be more" signal, and comparing a filtered count to the limit
      // would report no-more-pages the moment a single phantom is dropped from
      // an otherwise full page.
      setHasMoreTeamChannels(teamResponse.length === options.limit);
      setHasMoreDMChannels(dmResponse.length === options.limit);

      // Record success: only NOW is this scope's data actually loaded. Marking
      // it earlier (or on skip) is what let a switched scope show stale data.
      fetchedKeyRef.current = fetchKey;

      // Auto-select the most recent channel on initial load
      if (!initialSelectionDoneRef.current) {
        initialSelectionDoneRef.current = true;
        const mostRecentTeam = teamResponse[0];
        // The FILTERED list — auto-selecting `dmResponse[0]` could open a
        // phantom on load, which is the exact thing being filtered out
        // everywhere else.
        const mostRecentDM = usableDms[0];
        let channelToSelect = null;
        if (mostRecentTeam && mostRecentDM) {
          const teamTime = new Date(
            (mostRecentTeam.data?.last_message_at as string) || 0,
          ).getTime();
          const dmTime = new Date(
            (mostRecentDM.data?.last_message_at as string) || 0,
          ).getTime();
          channelToSelect = dmTime >= teamTime ? mostRecentDM : mostRecentTeam;
        } else {
          channelToSelect = mostRecentTeam || mostRecentDM || null;
        }
        if (channelToSelect) {
          setActiveChannel(channelToSelect);
          setActiveChannelId(channelToSelect.cid || null);
        }
      }
    } catch (err) {
      console.error("Error fetching channels:", err);
      setError("Failed to load channels. Please try refreshing.");
    } finally {
      setIsLoading(false);
      // #248: release the in-flight guard only if WE are still the in-flight
      // fetch. If a newer-keyed fetch started after us, leave its key in place
      // so it isn't wrongly treated as not-in-flight.
      if (inFlightFetchKeyRef.current === fetchKey) {
        inFlightFetchKeyRef.current = null;
      }
    }
    // Why `scope` is in deps: when the operator toggles the org-context
    // dropdown (or navigates into /dashboard/organization/<orgId>/...),
    // useOrgScope's `scope` shifts and we must refetch the channel list
    // through the new filter. Without this, the inbox keeps showing the
    // previous tenant's threads until a hard reload.
  }, [client, setActiveChannel, scope, computeFetchKey]);

  // Function to load more channels (pagination)
  const loadMoreChannels = useCallback(
    async (type: "team" | "messaging") => {
      if (!client?.userID || isLoadingMore) return;

      const hasMore = type === "team" ? hasMoreTeamChannels : hasMoreDMChannels;

      if (!hasMore) return;

      // The scope this page belongs to, captured before the request goes out.
      const pageKey = computeFetchKey();

      setIsLoadingMore(true);

      try {
        // Mirror the org-scope filter from `fetchChannels` so the
        // load-more page stays in the same tenant context.
        const orgFilter: Record<string, unknown> = buildOrgChannelFilter(scope);
        const filter = {
          members: { $in: [client.userID] },
          type,
          ...orgFilter,
        };
        const sort: { last_message_at: -1 } = { last_message_at: -1 };

        // Raw fetched count, never `currentChannels.length` — see
        // fetchedCountRef.
        const offset = fetchedCountRef.current[type];

        const options = {
          watch: true,
          state: true,
          limit: 20,
          message_limit: 10, // Match the initial-load trim above
          presence: false,
          offset,
        };

        const response = await client.queryChannels(filter, sort, options);

        // Staleness guard, the same one `fetchChannels` applies to its own late
        // response: switching org mid-pagination let Acme's page two land on
        // Zeta's list, cross-tenanting the inbox the scope filter exists to
        // keep apart — and corrupting the offset the next page reads. Stale
        // when a newer scope has already loaded, or when one is in flight.
        const supersededByLoaded = fetchedKeyRef.current !== pageKey;
        const supersededByInFlight =
          inFlightFetchKeyRef.current !== null &&
          inFlightFetchKeyRef.current !== pageKey;
        if (supersededByLoaded || supersededByInFlight) return;

        fetchedCountRef.current[type] += response.length;

        if (type === "team") {
          setTeamChannels((prev) => [...prev, ...response]);
          setHasMoreTeamChannels(response.length === options.limit);
        } else {
          setDirectMessages((prev) => [
            ...prev,
            ...response.filter(isUsableDmChannel),
          ]);
          // Raw length again — see fetchChannels.
          setHasMoreDMChannels(response.length === options.limit);
        }
      } catch (error) {
        console.error(`Error loading more ${type} channels:`, error);
      } finally {
        setIsLoadingMore(false);
      }
    },
    [
      client,
      // `teamChannels` / `directMessages` are deliberately absent: the offset
      // now comes from `fetchedCountRef`, so this callback no longer reads
      // either list. Keeping them would rebuild it on every incoming message.
      hasMoreTeamChannels,
      hasMoreDMChannels,
      isLoadingMore,
      scope,
      computeFetchKey,
    ],
  );

  // Handle individual channel deletion without full refresh
  const handleChannelDeleted = useCallback(
    (deletedChannelId: string) => {
      // Remove from team channels
      setTeamChannels((prevChannels) =>
        prevChannels.filter((ch) => ch.cid !== deletedChannelId),
      );

      // Remove from direct messages
      setDirectMessages((prevChannels) =>
        prevChannels.filter((ch) => ch.cid !== deletedChannelId),
      );

      // Clear active channel if it was the deleted one. Read the ref (not the
      // state) so this handler's identity stays stable across selections and the
      // event-listener effect below isn't re-run on every channel click.
      if (activeChannelIdRef.current === deletedChannelId) {
        setActiveChannel(undefined);
        setActiveChannelId(null);
      }
    },
    [setActiveChannel],
  );

  // Handle user being removed from channel
  const handleUserRemovedFromChannel = useCallback(
    (channelId: string) => {
      handleChannelDeleted(channelId); // Same logic as deletion
    },
    [handleChannelDeleted],
  );

  // Handle individual channel creation without full refresh
  const handleChannelCreated = useCallback(async () => {
    if (!client?.userID) return;

    try {
      // Only query for channels that might have been just created
      // Use a more recent timestamp filter to avoid loading all channels
      const recentFilter = {
        members: { $in: [client.userID] },
        // created_at: { $gte: new Date(Date.now() - 60000) } // Last minute
      };

      const [recentTeamChannels, recentDMChannels] = await Promise.all([
        client.queryChannels(
          { ...recentFilter, type: "team" },
          { created_at: -1 },
          { limit: 5, state: true },
        ),
        client.queryChannels(
          { ...recentFilter, type: "messaging" },
          { created_at: -1 },
          { limit: 5, state: true },
        ),
      ]);

      // Add any new channels to existing lists (avoiding duplicates)
      setTeamChannels((prevChannels) => {
        const existingIds = new Set(prevChannels.map((ch) => ch.cid));
        const newChannels = recentTeamChannels.filter(
          (ch) => !existingIds.has(ch.cid),
        );
        if (newChannels.length > 0) {
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });

      setDirectMessages((prevChannels) => {
        const existingIds = new Set(prevChannels.map((ch) => ch.cid));
        const newChannels = recentDMChannels.filter(
          (ch) => !existingIds.has(ch.cid) && isUsableDmChannel(ch),
        );
        if (newChannels.length > 0) {
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });
    } catch (err) {
      console.error("Error handling individual channel creation:", err);
      // Fallback to full refresh if individual handling fails
      fetchChannels();
    }
  }, [client, fetchChannels]);

  // Manual refresh function
  const handleRefresh = () => {
    fetchChannels();
  };

  // #248: Initial fetch — runs once per (client + org-scope), NOT on every
  // channel selection. Previously this lived in the same effect as the event
  // listener, whose deps included `activeChannelId`; selecting a channel
  // re-ran the effect and refired the full queryChannels pair, producing the
  // home/chat call-storm. The key guard makes unrelated re-renders a no-op
  // while still refetching on a real client or scope change.
  useEffect(() => {
    if (!client?.userID) {
      setIsLoading(true);
      setTeamChannels([]);
      setDirectMessages([]);
      fetchedKeyRef.current = null;
      inFlightFetchKeyRef.current = null;
      return;
    }

    const fetchKey = computeFetchKey();
    if (fetchedKeyRef.current === fetchKey) {
      return; // already SUCCESSFULLY fetched for this client+scope
    }
    // Do NOT pre-mark fetchedKeyRef here — fetchChannels records it only after
    // its request succeeds, so a skipped (in-flight) or failed fetch can't leave
    // a scope marked done with another scope's data.
    // Reset auto-selection so a scope switch can pick a fresh default channel.
    initialSelectionDoneRef.current = false;
    fetchChannels();
  }, [client, scope, fetchChannels, computeFetchKey]);

  // #248: Event listener — attached once per client (not per channel click).
  // Kept separate from the initial fetch so selecting a channel no longer tears
  // down/re-attaches the listener or refires queryChannels.
  useEffect(() => {
    if (client) {
      // Listener for events that might require a channel list update.
      // Nothing is logged here on purpose: this is bound to `*.**`, so the
      // line that used to sit at the top printed EVERY Stream event payload —
      // message bodies included — to the production browser console.
      const handleEvent = (event: Event) => {
        let channelUpdated = false;

        // Update channel lists based on events
        if (
          event.type === "notification.added_to_channel" &&
          event.channel &&
          event.user?.id === client.userID
        ) {
          const newChannel = client.channel(
            event.channel.type,
            event.channel.id,
          );
          if (event.channel.type === "team") {
            setTeamChannels((prev) => [newChannel, ...prev]);
          } else if (event.channel.type === "messaging") {
            setDirectMessages((prev) => [newChannel, ...prev]);
          }
          channelUpdated = true;
        } else if (
          event.type === "notification.removed_from_channel" &&
          event.channel &&
          event.user?.id === client.userID
        ) {
          handleUserRemovedFromChannel(event.channel.cid || event.channel.id);
          channelUpdated = true;
        } else if (event.type === "channel.deleted" && event.channel) {
          handleChannelDeleted(event.channel.cid || event.channel.id);
          channelUpdated = true;
        }

        // Refresh channel object in state if it was updated (e.g., new message, read status)
        // This relies on the channel object reference changing or having updated state
        if (
          event.channel &&
          !channelUpdated &&
          (event.type === "message.new" ||
            event.type === "notification.message_new" ||
            event.type === "message.read" ||
            event.type === "channel.updated")
        ) {
          const updatedChannel = client.channel(
            event.channel.type,
            event.channel.id,
          );
          if (event.channel.type === "team") {
            setTeamChannels((prev) =>
              prev.map((ch) =>
                ch.cid === event.channel?.id ? updatedChannel : ch,
              ),
            );
          } else if (event.channel.type === "messaging") {
            setDirectMessages((prev) =>
              prev.map((ch) =>
                ch.cid === event.channel?.id ? updatedChannel : ch,
              ),
            );
          }
        }
      };

      // #1280 2.6 — the SINGLE-argument form is the "every event" listener.
      //
      // `client.on("*.**", handler)` registers under the LITERAL key `"*.**"`;
      // there is no wildcard matching in the SDK's dispatcher, which only ever
      // looks up `listeners.all` and `listeners[event.type]`. No Stream event
      // has the type `"*.**"`, so this entire live channel-list updater never
      // fired once — the list only ever changed on an explicit refetch, while
      // the unread badge pointing at it updated correctly because
      // `useChatUnreadCount` already uses the right form.
      client.on(handleEvent);

      return () => {
        client.off(handleEvent);
      };
    }
    // #248: deps intentionally exclude `fetchChannels` and `activeChannelId` so
    // the listener is not re-attached on every channel selection. It re-attaches
    // only when the client or the channel-mutation handlers genuinely change.
  }, [client, handleChannelDeleted, handleUserRemovedFromChannel]);

  const handleChannelSelect = useCallback(
    (channel: Channel) => {
      // Use startTransition for non-urgent updates to improve perceived performance
      startTransition(() => {
        setActiveChannelId(channel.cid || null);
      });

      // Set active channel immediately for instant feedback
      setActiveChannel(channel);

      // Below `md` the conversation replaces this list (#1134). No-op above it.
      openConversation();

      // Mark channel as read asynchronously (only if channel is properly initialized)
      if (channel.initialized && channel.cid) {
        channel.markRead().catch(() => {
          // Silently ignore markRead errors - they can occur during rapid channel switching
        });
      }
    },
    [setActiveChannel, openConversation],
  );

  // #248: keep activeChannelIdRef in lockstep with the state so the stable
  // handleChannelDeleted handler can read the current selection from the ref.
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Debug Stream tools: local hostname only — never on deployed/preview hosts
  // even if NODE_ENV were somehow still "development".
  const [showLocalDebugTools, setShowLocalDebugTools] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const host = window.location.hostname;
    setShowLocalDebugTools(host === "localhost" || host === "127.0.0.1");
  }, []);

  return (
    // Width belongs to ChatLayout now: full-bleed below `md`, a 320px column
    // above it. Hardcoding `w-80` here is what made mobile unusable (#1134).
    <div className="flex h-full w-full flex-col bg-card text-card-foreground md:border-r md:border-border">
      {/* Header with Title and Refresh */}
      <div className="p-4 border-b border-border flex justify-between items-center">
        <h1 className="text-xl font-bold">Chats</h1>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                disabled={isLoading}
                className="text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Refresh channels</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Search Bar */}
      <div className="p-4">
        <ChannelSearch />
      </div>

      {/* Channel Sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Team Channels Section */}
        <div className="px-4 py-2 flex justify-between items-center sticky top-0 bg-card z-10">
          <h2 className="font-semibold">Channels</h2>
          {canCreateChannels && (
            <CreateChannelDialog
              onChannelCreated={handleChannelCreated}
              // Custom (non-event) channels are admin/staff-only server-side.
              // Without this the option renders for consultants and every
              // submission 403s.
              canCreateCustomChannel={
                appRole === "ADMIN" || appRole === "STAFF"
              }
            />
          )}
        </div>
        {isLoading ? (
          <ChannelListSkeleton />
        ) : error ? (
          <div className="p-4 text-center text-sm text-destructive">
            <p>{error}</p>
            <Button
              onClick={handleRefresh}
              variant="secondary"
              size="sm"
              className="mt-2"
            >
              Try Again
            </Button>
          </div>
        ) : teamChannels.length > 0 ? (
          <div>
            {teamChannels.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                isActive={channel.cid === activeChannelId}
                onClick={() => handleChannelSelect(channel)}
              />
            ))}
            {hasMoreTeamChannels && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMoreChannels("team")}
                  disabled={isLoadingMore}
                  className="w-full text-muted-foreground hover:bg-muted text-sm"
                >
                  {isLoadingMore
                    ? "Loading..."
                    : `Showing ${teamChannels.length} channels — Load more`}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-muted-foreground text-sm">
            No team channels found.
          </div>
        )}

        {/* Conversations Section (Consultations, Subscriptions).
            Deliberately NOT sticky: two `sticky top-0` headers in one scroll
            container pin to the same offset and overlap each other. */}
        <div className="mt-4 bg-card px-4 py-2">
          <h2 className="font-semibold">Conversations</h2>
        </div>
        {isLoading ? (
          <ChannelListSkeleton />
        ) : error ? (
          // Was an empty div on the theory that the Channels error above says
          // enough — so on failure this section just vanished.
          <div className="p-4 text-center text-sm text-destructive">
            <p>Conversations could not be loaded.</p>
          </div>
        ) : (
          // NOT `directMessages.length > 0 ? list : emptyState`.
          //
          // The list is filtered (phantom DMs are dropped, see
          // isUsableDmChannel) but `hasMoreDMChannels` is measured against the
          // RAW page length. So a page whose 20 rows are all phantoms leaves the
          // list empty with more pages still to come — and with the load-more
          // button living inside the non-empty branch, the empty state rendered
          // "No conversations yet" over a stranded list the user could not
          // reach. The button is now tied to `hasMoreDMChannels` alone, and the
          // empty state only claims there is nothing when there is genuinely
          // nothing left to fetch.
          <div>
            {directMessages.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                isActive={channel.cid === activeChannelId}
                onClick={() => handleChannelSelect(channel)}
              />
            ))}

            {directMessages.length === 0 && !hasMoreDMChannels && (
              <div className="p-4 text-center text-muted-foreground text-sm">
                {isConsultant
                  ? "No conversations yet. Conversations will appear here once clients book sessions."
                  : "No conversations yet. Book a consultation to start chatting."}
              </div>
            )}

            {hasMoreDMChannels && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMoreChannels("messaging")}
                  disabled={isLoadingMore}
                  className="w-full text-muted-foreground hover:bg-muted text-sm"
                >
                  {isLoadingMore
                    ? "Loading..."
                    : directMessages.length === 0
                      ? "Load conversations"
                      : `Showing ${directMessages.length} conversations — Load more`}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer Section — Debug tools, localhost only */}
      {showLocalDebugTools && (
        <div className="mt-auto space-y-2 border-t border-border p-4">
          <InitializeUserChannelsButton
            userId={client?.userID || ""}
            className="w-full"
            onSuccess={handleRefresh}
          />
          <DebugDialog
            userId={client?.userID || ""}
            variant="ghost"
            className="w-full text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        </div>
      )}
    </div>
  );
};
