"use client";

// Heavy Stream SDK implementation. This module is ONLY loaded via next/dynamic
// from StreamProvider.tsx (ssr:false). Keeping every Stream SDK import + the two
// SDK stylesheets in a separate module is what actually code-splits the SDK out
// of the synchronous bundle of every route that mounts <StreamProvider>. #248
//
// NOTE (flagged to reviewer): this file is outside the originally-scoped edit
// set, but a real next/dynamic split is impossible without a separate module —
// dynamic()-wrapping a component defined in the same file does not code-split,
// since its static imports stay in the parent chunk. See StreamProvider.tsx.

import { useCallback, useEffect, useState, useRef } from "react";
import { StreamChat } from "stream-chat";
import { StreamVideoClient } from "@stream-io/video-react-sdk";
import {
  chatTokenProvider,
  tokenProvider,
} from "@/actions/stream/chat/stream.action";
import { upsertUserToStream } from "@/actions/stream/chat/user.action";
import { syncUserEventChannels } from "@/actions/stream/chat/event-channel.action";
import { useUserData } from "@/hooks/useUserData";
import { mapRoleToStream } from "@/lib/user";
import { streamLogger } from "@/lib/stream-logger";
import { setStreamConnection } from "@/lib/stream/connection-store";

/**
 * The connector takes no `children`. It renders nothing and publishes the
 * connection to the store instead — see lib/stream/connection-store.ts for why
 * (SSR of the dashboard subtree, and the remount storm).
 */
export interface StreamConnectorProps {
  userId: string;
  enableChat?: boolean;
  enableVideo?: boolean;
}
// Shared module-level client refs now live in an SDK-free module so SDK-free
// callers can disconnect on logout without linking the Stream SDK. #248
import {
  getGlobalChatClient,
  setGlobalChatClient,
  getGlobalVideoClient,
  setGlobalVideoClient,
  getCurrentStreamUserId,
  setCurrentStreamUserId,
  disconnectStreamClients,
} from "@/lib/stream/disconnect";

// Stream CSS co-located with the heavy impl so the ~2 stylesheets ship only
// inside this lazy chunk (was previously imported at provider module top-level
// and by both dashboard layouts).
import "stream-chat-react/dist/css/v2/index.css";
import "@stream-io/video-react-sdk/dist/css/styles.css";

// Client-side only: tracks which users have completed initial sync within this
// browser tab's module lifecycle. Separate from the server-side Set in stream-cache.ts.
const clientSyncCompletedUsers = new Set<string>();

/**
 * Undo the "sync kicked" marks so a later render can retry.
 *
 * Safe to clear the in-memory marker here despite it meaning "kicked, possibly
 * in flight" — this runs only once the promise has settled, so there is nothing
 * left in flight to double up on.
 */
function markSyncIncomplete(userId: string, syncKey: string) {
  clientSyncCompletedUsers.delete(userId);
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem(syncKey);
  }
}

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

/**
 * The two clients as ONE value, deliberately. Held separately they were set by
 * two async connects that race, so the element in the wrapper slot below
 * changed TYPE between renders — `children`, then `<StreamVideo>`, then
 * `<Chat>`, in whichever order the sockets happened to settle. React cannot
 * reconcile a type change in place: it unmounts and remounts the entire
 * subtree, which here is the whole dashboard. That is the remount storm behind
 * "I pressed Join ten times" — an in-flight join was torn down under the user.
 *
 * `null` means "not settled yet", which is distinct from a settled result whose
 * `chat` or `video` is null because that connect failed.
 */
interface SettledStreamClients {
  chat: StreamChat | null;
  video: StreamVideoClient | null;
}

const StreamProviderImpl = ({
  userId,
  enableChat = true,
  enableVideo = true,
}: StreamConnectorProps) => {
  const [clients, setClients] = useState<SettledStreamClients | null>(null);
  const [chatConnected, setChatConnected] = useState(false);
  const [videoConnected, setVideoConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // We need BOTH a ref and state for retry count: the ref (connectionAttemptsRef)
  // is used inside setTimeout/async closures where state would be stale, while
  // this state variable drives re-renders so the UI shows the correct attempt count.
  const [, setRetryCount] = useState(0);

  // Use ref for connection attempts to avoid stale closures in retry logic
  const connectionAttemptsRef = useRef(0);
  // Guard against concurrent connectUser calls (race: connectVideo resolves first,
  // triggers re-render + effect re-run before connectChat has set globalChatClient)
  const isChatConnectingRef = useRef(false);
  // Track retry timeout so we can cancel on unmount
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const { userDetails, isLoading } = useUserData(userId);

  // Token caching with expiry tracking — use ref to avoid triggering re-renders
  // (useState here caused getCachedToken → connectChat → connectServices to
  //  be recreated on every token fetch, making the connectUser useEffect fire
  //  repeatedly and producing "Consecutive calls to connectUser" warnings)
  // Each token type has its own expiry to avoid one overwriting the other's validity window.
  const tokenCacheRef = useRef<{
    userId?: string;
    chatToken?: string;
    chatExpiresAt?: number;
    videoToken?: string;
    videoExpiresAt?: number;
  }>({});

  const isTokenValid = useCallback(
    (type: "chat" | "video", forUserId: string) => {
      const cache = tokenCacheRef.current;
      // Identity-scoped: a token minted for a prior user must never satisfy
      // this one, even while still unexpired.
      if (cache.userId !== forUserId) return false;
      const token = type === "chat" ? cache.chatToken : cache.videoToken;
      const expiresAt =
        type === "chat" ? cache.chatExpiresAt : cache.videoExpiresAt;
      if (!token || !expiresAt) return false;
      // Check if token expires within next 5 minutes
      return Date.now() < expiresAt - 5 * 60 * 1000;
    },
    [],
  );

  // In-flight token requests, shared so concurrent callers (the prefetch
  // effect below + the connect effects) get ONE server-action round trip
  // instead of racing duplicates. Keyed by userId: a request minted for a
  // prior identity must never resolve for the current one.
  const tokenPromiseRef = useRef<{
    userId?: string;
    chat?: Promise<string>;
    video?: Promise<string>;
  }>({});

  const getCachedToken = useCallback(
    async (type: "chat" | "video"): Promise<string> => {
      // A user switch invalidates both caches wholesale before any read.
      if (
        tokenCacheRef.current.userId !== userId ||
        tokenPromiseRef.current.userId !== userId
      ) {
        tokenCacheRef.current = { userId };
        tokenPromiseRef.current = { userId };
      }

      if (isTokenValid(type, userId)) {
        const cache = tokenCacheRef.current;
        return type === "chat" ? cache.chatToken! : cache.videoToken!;
      }

      const existing = type === "chat" ? tokenPromiseRef.current.chat : tokenPromiseRef.current.video;
      if (existing) return existing;

      // Generate new token
      const request =
        type === "chat"
          ? chatTokenProvider(userId)
          : tokenProvider(userId);
      if (type === "chat") tokenPromiseRef.current.chat = request;
      else tokenPromiseRef.current.video = request;

      void request.then(
        (newToken) => {
          // Cache with 50-minute expiry (tokens usually last 1 hour)
          const expiresAt = Date.now() + 50 * 60 * 1000;
          if (type === "chat") {
            tokenCacheRef.current.chatToken = newToken;
            tokenCacheRef.current.chatExpiresAt = expiresAt;
          } else {
            tokenCacheRef.current.videoToken = newToken;
            tokenCacheRef.current.videoExpiresAt = expiresAt;
          }
        },
        () => {},
      );
      // `.finally` returns a DERIVED promise that re-rejects when the request
      // fails; left unattached that is an unhandled rejection on every failed
      // mint. The catch swallows exactly that derived rejection — the original
      // still propagates to `return request` callers.
      void request.finally(() => {
        if (tokenPromiseRef.current.userId !== userId) return;
        if (type === "chat" && tokenPromiseRef.current.chat === request) {
          delete tokenPromiseRef.current.chat;
        }
        if (type === "video" && tokenPromiseRef.current.video === request) {
          delete tokenPromiseRef.current.video;
        }
      }).catch(() => {});

      return request;
    },
    [userId, isTokenValid],
  );

  // Prefetch both tokens at mount — BEFORE userDetails resolve. Token minting
  // needs only `userId`, but connectUser used to wait for useUserData first and
  // only THEN paid a server-action round trip for the token: two serial waits
  // on the critical path of every dashboard/meetings load. Starting the fetch
  // immediately lets it complete during the user-data query, so connectUser
  // starts the WebSocket the moment its other inputs are ready. Fire-and-forget:
  // failures are handled by the normal connect paths, which re-request via
  // getCachedToken (cleared promise ref → fresh attempt).
  useEffect(() => {
    if (!apiKey || !userId) return;
    if (enableChat && !isTokenValid("chat", userId)) {
      void getCachedToken("chat").catch(() => {});
    }
    if (enableVideo && !isTokenValid("video", userId)) {
      void getCachedToken("video").catch(() => {});
    }
  }, [userId, enableChat, enableVideo, getCachedToken, isTokenValid]);

  // Exponential backoff retry logic
  const getRetryDelay = useCallback((attempt: number) => {
    return Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
  }, []);

  // connectChat/connectVideo RESOLVE to their client (or null) instead of each
  // setting its own state, so the caller can commit both at once and the tree
  // changes shape a single time. See SettledStreamClients.
  const connectChat = useCallback(async () => {
    if (!enableChat || !userDetails || !apiKey) return null;

    // Check if we already have a global client for this user - adopt it
    const adoptable = getGlobalChatClient();
    if (getCurrentStreamUserId() === userDetails.id && adoptable) {
      streamLogger.debug("Adopting existing chat client", {
        userId: userDetails.id,
      });
      setChatConnected(true);
      return adoptable;
    }

    // Prevent concurrent connectUser calls (e.g. connectVideo re-render race)
    if (isChatConnectingRef.current) {
      streamLogger.debug("Chat connection already in progress, skipping", {
        userId: userDetails.id,
      });
      return getGlobalChatClient();
    }

    isChatConnectingRef.current = true;

    try {
      streamLogger.debug("Connecting to Stream Chat", {
        userId: userDetails.id,
      });

      const client = StreamChat.getInstance(apiKey);

      // If the singleton is already connected to this user (e.g. StreamVideoClient
      // connected it internally), adopt it directly without calling connectUser again.
      if (client.userID && client.userID === userDetails.id) {
        streamLogger.debug("Adopting already-connected Stream Chat singleton", {
          userId: userDetails.id,
        });
        setGlobalChatClient(client);
        setCurrentStreamUserId(userDetails.id);
        setChatConnected(true);
        return client;
      }

      // Ensure user exists in Stream's database (only if not synced before)
      if (!clientSyncCompletedUsers.has(userDetails.id)) {
        try {
          await upsertUserToStream(userDetails.id);
          streamLogger.debug("User upserted to Stream", {
            userId: userDetails.id,
          });
        } catch (upsertError) {
          streamLogger.warn("User upsert failed, continuing", {
            userId: userDetails.id,
            error: upsertError,
          });
        }
      }

      const streamRole = mapRoleToStream(userDetails.role);

      await client.connectUser(
        {
          id: userDetails.id,
          name: userDetails.name ?? userDetails.id,
          image: userDetails.image ?? undefined,
          role: streamRole,
        },
        () => getCachedToken("chat"),
      );

      // Store in global references
      setGlobalChatClient(client);
      setCurrentStreamUserId(userDetails.id);

      setChatConnected(true);

      // Initial channel sync — once per user per browser session.
      // The in-memory Set resets on page reload (client module re-evaluation),
      // so we persist to sessionStorage to survive refreshes within the same tab.
      const syncKey = `stream_sync_${userDetails.id}`;
      const alreadySynced =
        clientSyncCompletedUsers.has(userDetails.id) ||
        (typeof sessionStorage !== "undefined" &&
          sessionStorage.getItem(syncKey) === "1");

      if (!alreadySynced) {
        // #1134 P1-19 — NOT awaited. This used to block the connect: the sync
        // costs roughly `1 + W + C + D + ceil(N/100)` Stream round-trips in
        // batches of five, so a consultant with 200 clients waited 8-20 seconds
        // with chat apparently dead before `chatConnected` ever went true.
        //
        // Chat is usable the moment the socket is up; channels stream into the
        // sidebar as they land, because it already re-renders on Stream events.
        // A tab closed mid-sync is caught by the reconcile cron, which is where
        // eventual correctness belongs — not on the critical path of every
        // dashboard load.
        streamLogger.info("Starting initial channel sync (background)", {
          userId: userDetails.id,
        });
        // Marked BEFORE the call, not after: this flag means "we have kicked
        // the sync for this user", and marking on completion let a re-render
        // start a second one while the first was still in flight.
        clientSyncCompletedUsers.add(userDetails.id);
        void syncUserEventChannels(userDetails.id)
          .then((result) => {
            // `syncUserEventChannels` reports failure by RESOLVING with
            // `{ success: false }` rather than rejecting, so a `.then` that
            // ignores its argument treats a failed sync as a completed one —
            // and `sessionStorage` then suppresses the retry for the rest of
            // the tab's life. The `.catch` below only ever saw the thrown case.
            if (!result?.success) {
              markSyncIncomplete(userDetails.id, syncKey);
              streamLogger.warn("Channel sync reported failure", {
                userId: userDetails.id,
                error: result?.error,
              });
              return;
            }
            if (typeof sessionStorage !== "undefined") {
              sessionStorage.setItem(syncKey, "1");
            }
            streamLogger.info("Initial channel sync completed", {
              userId: userDetails.id,
            });
          })
          .catch((syncError) => {
            // Deliberately not persisted to sessionStorage, so the next load
            // retries rather than assuming this user is reconciled.
            markSyncIncomplete(userDetails.id, syncKey);
            streamLogger.warn("Channel sync failed", {
              userId: userDetails.id,
              error: syncError,
            });
          });
      } else {
        streamLogger.debug("Skipping channel sync (already completed)", {
          userId: userDetails.id,
        });
      }

      streamLogger.info("Chat connection established", {
        userId: userDetails.id,
      });
      return client;
    } catch (error) {
      streamLogger.warn("Chat connection failed (will retry)", {
        userId: userDetails.id,
      });
      setChatConnected(false);
      throw error;
    } finally {
      isChatConnectingRef.current = false;
    }
  }, [enableChat, userDetails, getCachedToken]);

  const connectVideo = useCallback(async () => {
    if (!enableVideo || !userDetails || !apiKey) return null;

    // Check if we already have a global client for this user - adopt it
    const adoptable = getGlobalVideoClient();
    if (getCurrentStreamUserId() === userDetails.id && adoptable) {
      streamLogger.debug("Adopting existing video client", {
        userId: userDetails.id,
      });
      setVideoConnected(true);
      return adoptable;
    }

    try {
      streamLogger.debug("Connecting to Stream Video", {
        userId: userDetails.id,
      });

      const client = new StreamVideoClient({
        apiKey: apiKey,
        user: {
          id: userDetails.id,
          name: userDetails.name ?? userDetails.id,
          image: userDetails.image ?? undefined,
        },
        tokenProvider: () => getCachedToken("video"),
      });

      // Store in global reference
      setGlobalVideoClient(client);
      setCurrentStreamUserId(userDetails.id);

      setVideoConnected(true);
      streamLogger.info("Video connection established", {
        userId: userDetails.id,
      });
      return client;
    } catch (error) {
      streamLogger.error("Video connection failed", error, {
        userId: userDetails.id,
      });
      setVideoConnected(false);
      throw error;
    }
  }, [enableVideo, userDetails, getCachedToken]);

  // Stable connectServices function using ref pattern for retry logic
  const connectServices = useCallback(async () => {
    if (isLoading || !userDetails) return;

    setIsConnecting(true);
    setError(null);

    try {
      // allSettled, not all: `all` rejects on the first failure and abandons the
      // other client's result, so a chat failure discarded a perfectly good
      // video client. Both outcomes are now committed together, which is also
      // what keeps the tree from changing shape twice.
      const [chatResult, videoResult] = await Promise.allSettled([
        connectChat(),
        connectVideo(),
      ]);

      setClients({
        chat: chatResult.status === "fulfilled" ? chatResult.value : null,
        video: videoResult.status === "fulfilled" ? videoResult.value : null,
      });

      const failure = [chatResult, videoResult].find(
        (result) => result.status === "rejected",
      );
      if (failure?.status === "rejected") throw failure.reason;

      connectionAttemptsRef.current = 0; // Reset on success
      setRetryCount(0);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Connection failed";
      setError(errorMessage);

      // Implement exponential backoff retry using ref
      connectionAttemptsRef.current += 1;
      setRetryCount(connectionAttemptsRef.current); // Sync state for UI display
      const currentAttempts = connectionAttemptsRef.current;

      if (currentAttempts < 5) {
        // Max 5 attempts
        const delay = getRetryDelay(currentAttempts);
        streamLogger.debug(`Retrying connection in ${delay}ms`, {
          attempt: currentAttempts,
        });
        setIsConnecting(false);
        retryTimeoutRef.current = setTimeout(() => {
          // Re-run connection (the ref ensures we get current attempt count)
          connectServices();
        }, delay);
        return;
      } else {
        streamLogger.error("Max connection attempts reached", error);
      }
    } finally {
      setIsConnecting(false);
    }
    // enableChat/enableVideo are not read here any more: each connect returns
    // null when its own flag is off, and both are already deps of those
    // callbacks, so listing them again only invalidates this one needlessly.
  }, [isLoading, userDetails, connectChat, connectVideo, getRetryDelay]);

  const retryConnection = useCallback(() => {
    connectionAttemptsRef.current = 0;
    setError(null);
    connectServices();
  }, [connectServices]);

  // Initialize connections.
  // connectServices is in deps and may cause re-fires when its useCallback
  // identity changes, but this is safe because:
  // - connectChat guards with globalChatClient + currentUserId check (no-op if already connected)
  // - syncUserEventChannels is guarded by sessionStorage (no-op after first sync)
  //
  // #248: this impl is only mounted via next/dynamic, so the SDK + this connect
  // logic are already deferred off the home critical path. We additionally
  // schedule the initial connect in requestIdleCallback (with a setTimeout
  // fallback) so the connect-storm (connectUser + syncUserEventChannels) doesn't
  // compete with first paint of whatever dashboard route mounted the provider.
  useEffect(() => {
    if (!(!isLoading && userDetails && apiKey)) {
      return;
    }

    let idleHandle: number | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
      // Check if user changed - if so, disconnect old user first.
      // Use disconnectStreamClients (global refs) rather than any local
      // teardown: on a fresh remount for a different user the local `clients`
      // state is null while the GLOBAL clients still point at the PREVIOUS
      // user, so a local teardown would no-op and leak the prior user's
      // connection, which the new connect would then adopt.
      if (
        getCurrentStreamUserId() &&
        getCurrentStreamUserId() !== userDetails.id
      ) {
        streamLogger.info("User changed, reconnecting", {
          from: getCurrentStreamUserId(),
          to: userDetails.id,
        });
        // Reset local token cache + attempt counter so the new user connects
        // with fresh tokens (disconnectStreamClients owns the global teardown).
        tokenCacheRef.current = {};
        connectionAttemptsRef.current = 0;
        disconnectStreamClients()
          .catch((err) => {
            // Never block the new user's connect on a prior-user disconnect
            // failure; disconnectStreamClients already clears global refs.
            streamLogger.warn(
              "Prior-user disconnect failed, connecting anyway",
              {
                error: err,
              },
            );
          })
          .finally(() => {
            connectServices();
          });
      } else {
        connectServices();
      }
    };

    // Defer the connect off the critical path (#248) — but only briefly.
    //
    // The timeout was 2000ms, and on a cold load that is not a ceiling, it is
    // the ACTUAL wait: the main thread is saturated by dashboard hydration and
    // by evaluating the Stream Chat + Video chunk, so the browser never finds
    // an idle period and fires at the deadline every time. Two seconds of the
    // Messages skeleton were this line.
    //
    // The deferral still earns its place — it keeps the socket handshake from
    // competing with first paint of the dashboard behind it — so it stays, at a
    // budget that yields to hydration without becoming the dominant cost. If
    // this ever needs tuning again, measure with `streamLogger.timing()` rather
    // than guessing; it warns above 5s and currently has no callers.
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = (
        window as Window & {
          requestIdleCallback: (
            cb: () => void,
            opts?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback(run, { timeout: 300 });
    } else {
      timeoutHandle = setTimeout(run, 0);
    }

    // Don't disconnect on unmount - keep global clients alive for tab switching
    // Only disconnect when user explicitly logs out or changes
    return () => {
      // Cancel pending scheduled connect + any pending retry timeout to avoid
      // state updates after unmount.
      if (
        idleHandle !== undefined &&
        typeof window !== "undefined" &&
        "cancelIdleCallback" in window
      ) {
        (
          window as Window & {
            cancelIdleCallback: (handle: number) => void;
          }
        ).cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = undefined;
      }
      // Intentionally not calling disconnect() here
      // Global clients are reused across component remounts
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userDetails?.id, isLoading, connectServices]);

  // Publish to the store rather than wrapping children. The wrapper set used to
  // be derived here — `children` → `<StreamVideo>` → `<Chat>` — which changed
  // the element type at that position once the sockets settled and remounted
  // the whole dashboard (#248). The SDK contexts are now mounted by the
  // surfaces that consume them; this component only reports state.
  useEffect(() => {
    setStreamConnection({
      clients,
      chatConnected,
      videoConnected,
      isConnecting,
      error,
    });
  }, [clients, chatConnected, videoConnected, isConnecting, error]);

  // The shell exposes `retryConnection` without importing the SDK bundle, so it
  // asks for a retry by event rather than by calling into here directly.
  useEffect(() => {
    const onRetry = () => retryConnection();
    window.addEventListener("stream:retry-connection", onRetry);
    return () => window.removeEventListener("stream:retry-connection", onRetry);
  }, [retryConnection]);

  // Renders nothing: it is a sibling of `children`, not a wrapper. Consumers
  // read connection state from the context in providers/StreamProvider.tsx.
  return null;
};

export default StreamProviderImpl;
