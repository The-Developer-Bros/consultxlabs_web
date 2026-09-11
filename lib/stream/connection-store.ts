import type { StreamChat } from "stream-chat";
import type { StreamVideoClient } from "@stream-io/video-react-sdk";

/**
 * Module-level store for the Stream connection, read via `useSyncExternalStore`.
 *
 * Why a store and not React state: the provider used to WRAP `children` and
 * swap the wrapper set once the sockets settled (`children` → `<StreamVideo>` →
 * `<Chat>`). React tears down a subtree when the element type at a position
 * changes, so that swap remounted the whole dashboard — the remount storm
 * behind "I pressed Join ten times" (#248). Publishing to a store instead lets
 * the connector render `null` as a SIBLING of `children`, so nothing above the
 * dashboard ever changes shape.
 *
 * It also un-blocks SSR. The connector is still `ssr: false`, but `ssr: false`
 * skips server rendering for the component AND its children — so while it
 * wrapped the dashboard, no dashboard markup reached the HTML at all. Measured
 * on #1102: `<h1` never appeared in the document and FCP sat at ~6s regardless
 * of Suspense boundaries.
 */
export interface StreamClients {
  chat: StreamChat | null;
  video: StreamVideoClient | null;
}

export interface StreamConnectionSnapshot {
  clients: StreamClients | null;
  chatConnected: boolean;
  videoConnected: boolean;
  isConnecting: boolean;
  error: string | null;
}

const INITIAL: StreamConnectionSnapshot = {
  clients: null,
  chatConnected: false,
  videoConnected: false,
  isConnecting: false,
  error: null,
};

let snapshot: StreamConnectionSnapshot = INITIAL;
const listeners = new Set<() => void>();

export function subscribeStreamConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStreamConnectionSnapshot(): StreamConnectionSnapshot {
  return snapshot;
}

/**
 * Server snapshot must be a STABLE reference, not a fresh object — React calls
 * this during SSR and would loop forever on a new identity each time.
 */
export function getStreamConnectionServerSnapshot(): StreamConnectionSnapshot {
  return INITIAL;
}

export function setStreamConnection(
  patch: Partial<StreamConnectionSnapshot>,
): void {
  const next = { ...snapshot, ...patch };
  // Bail on no-op writes so consumers do not re-render on every heartbeat.
  const unchanged = (
    Object.keys(next) as (keyof StreamConnectionSnapshot)[]
  ).every((k) => next[k] === snapshot[k]);
  if (unchanged) return;
  snapshot = next;
  for (const l of listeners) l();
}

/** Test/logout helper — drops connection state without touching the clients. */
export function resetStreamConnection(): void {
  snapshot = INITIAL;
  for (const l of listeners) l();
}
