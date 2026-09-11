// SDK-free module that owns the shared module-level Stream client refs and the
// logout disconnect helper. Split out of StreamProvider so SDK-free callers
// (Navbar, UserDropdown, org/admin/staff layouts) that only need
// disconnectStreamClients no longer statically link the heavy Stream
// video/chat SDK into their bundles. Types are `import type` only (erased at
// runtime); we never construct an SDK class here, only call methods on already-
// instantiated client objects, so this file imports no SDK runtime code.

import type { StreamChat } from "stream-chat";
import type { StreamVideoClient } from "@stream-io/video-react-sdk";
import { streamLogger } from "@/lib/stream-logger";
import { clearAllStreamCaches } from "@/lib/stream-cache";
// Type-only SDK imports there too, so this stays SDK-free — see the note above.
import { resetStreamConnection } from "@/lib/stream/connection-store";

// Module-level client instances to avoid re-creating on remount.
// Owned here (not in StreamProvider) so the disconnect helper and the provider
// share one source of truth without the helper dragging in the SDK.
let globalChatClient: StreamChat | null = null;
let globalVideoClient: StreamVideoClient | null = null;
let currentUserId: string | null = null;

// Accessors/mutators used by StreamProvider. The provider reads/writes these
// shared refs through these functions instead of owning the module state.
export function getGlobalChatClient(): StreamChat | null {
  return globalChatClient;
}
export function setGlobalChatClient(client: StreamChat | null): void {
  globalChatClient = client;
}
export function getGlobalVideoClient(): StreamVideoClient | null {
  return globalVideoClient;
}
export function setGlobalVideoClient(client: StreamVideoClient | null): void {
  globalVideoClient = client;
}

// #248: the video connect is deferred to requestIdleCallback, so the global
// client may not exist yet at the instant a user clicks Join. Poll briefly for
// it (the StreamProvider mounted on this route is already connecting) rather
// than erroring out on the first null read. Resolves null if it never appears
// within the window so the caller can show a soft "try again" message.
export async function waitForGlobalVideoClient(
  timeoutMs = 4000,
  intervalMs = 150,
): Promise<ReturnType<typeof getGlobalVideoClient>> {
  const existing = getGlobalVideoClient();
  if (existing) return existing;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const client = getGlobalVideoClient();
    if (client) return client;
  }
  return getGlobalVideoClient();
}
/**
 * Context for a `waitForGlobalVideoClient` that came back empty, in the terms
 * that separate a cold start from a real failure (#1067).
 *
 * Reaching the singleton on a cold load costs the provider's dynamic chunk,
 * `useUserData`'s serial profile fetches, and a `requestIdleCallback` with a
 * 2s timeout — none of which the 4s wait above knows about. A Join clicked
 * seconds after the page opened is that race; one clicked minutes in, with no
 * `connectedStreamUserId`, is the provider genuinely failing to connect.
 */
export function describeVideoClientWait(waitedMs: number): {
  waitedMs: number;
  msSincePageLoad: number | null;
  connectedStreamUserId: string | null;
} {
  return {
    waitedMs,
    msSincePageLoad:
      typeof performance === "undefined" ? null : Math.round(performance.now()),
    connectedStreamUserId: getCurrentStreamUserId(),
  };
}

export function getCurrentStreamUserId(): string | null {
  return currentUserId;
}
export function setCurrentStreamUserId(userId: string | null): void {
  currentUserId = userId;
}

/**
 * Disconnect all Stream clients and clear global state.
 * Call this before signing out to ensure clean disconnection.
 */
export async function disconnectStreamClients(): Promise<void> {
  // #1304 review — capture what we are tearing down, and only clear THAT.
  //
  // The awaits below take real time, and the provider retries connecting on
  // failure. A retry landing mid-teardown publishes new clients and new store
  // state, and the code after the awaits would then null a client nobody asked
  // it to touch and reset a snapshot describing a live session — leaving the
  // app connected on Stream's side and disconnected in its own state.
  //
  // The ref-nulling half of that race predates this change; adding
  // `resetStreamConnection` widened it to the store, which is what surfaced it.
  const teardownChat = globalChatClient;
  const teardownVideo = globalVideoClient;

  const promises: Promise<void>[] = [];

  if (globalChatClient) {
    const client = globalChatClient;
    promises.push(
      client.disconnectUser().then(() => {
        streamLogger.debug("Chat client disconnected on logout");
      }),
    );
  }

  if (globalVideoClient) {
    const videoClient = globalVideoClient;
    promises.push(
      videoClient.disconnectUser().then(() => {
        streamLogger.debug("Video client disconnected on logout");
      }),
    );
  }

  // allSettled (not all): a rejected disconnectUser() must NOT skip the global
  // state teardown below — leaving stale client refs after a failed logout
  // would let the next login adopt the prior user's connection.
  const results = await Promise.allSettled(promises);
  for (const result of results) {
    if (result.status === "rejected") {
      streamLogger.warn("Stream disconnect rejected on logout", {
        error: result.reason,
      });
    }
  }

  // Clear global state regardless of disconnect OUTCOME — a failed
  // `disconnectUser` must not leak the ref — but only for the clients this call
  // actually tore down. If a newer connection replaced one while we waited, it
  // is not ours to null.
  const supersededChat = globalChatClient !== teardownChat;
  const supersededVideo = globalVideoClient !== teardownVideo;

  if (!supersededChat) globalChatClient = null;
  if (!supersededVideo) globalVideoClient = null;

  if (supersededChat || supersededVideo) {
    // Worth a line: it means a sign-out and a reconnect interleaved, and the
    // reconnect won. Nothing is broken, but the session the user ended is not
    // the session the app is now holding.
    streamLogger.warn(
      "Stream teardown superseded by a newer connection; leaving it alone",
      { supersededChat, supersededVideo },
    );
    return;
  }

  currentUserId = null;
  clearAllStreamCaches();

  // #1280 PR 7 — the connection STORE has to go too, not just the client refs.
  //
  // `resetStreamConnection` was written for exactly this and then never called
  // from anywhere: `grep` returned one hit, its own definition. The gap it left
  // is real. This function nulls the globals above, but the store — which
  // `useStreamConnection` reads through `useSyncExternalStore` — kept reporting
  // `{ chatConnected: true, videoConnected: true, clients: <the objects just
  // torn down> }`. Anything rendering between sign-out and the provider
  // unmounting saw a connected snapshot pointing at disconnected clients, and
  // the next user's session started against the previous user's state until the
  // provider republished.
  //
  // The obvious reading was that the helper was dead code to delete. It was the
  // opposite: a correct helper nobody had wired up.
  resetStreamConnection();

  // Clear sessionStorage sync flags so a re-login triggers a fresh sync
  if (typeof sessionStorage !== "undefined") {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("stream_sync_"))
      .forEach((k) => sessionStorage.removeItem(k));
  }
}
