"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import {
  getStreamConnectionServerSnapshot,
  getStreamConnectionSnapshot,
  subscribeStreamConnection,
} from "@/lib/stream/connection-store";

// Re-export the logout helper from the SDK-free module so existing importers of
// `disconnectStreamClients` from this path keep working unchanged. Callers that
// ONLY need disconnect should import it straight from "@/lib/stream/disconnect"
// to stay off the SDK bundle entirely (Navbar already does — see #248).
export { disconnectStreamClients } from "@/lib/stream/disconnect";

// ── Connection-state context ────────────────────────────────────────────────
// Defined in this SDK-free shell (not the heavy connector) so consumers like
// DebugDialog can import useStreamConnection without pulling the SDK.

export interface StreamConnectionState {
  chatConnected: boolean;
  videoConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  retryConnection: () => void;
}

const DEFAULT_CONNECTION_STATE: StreamConnectionState = {
  chatConnected: false,
  videoConnected: false,
  isConnecting: false,
  error: null,
  retryConnection: () => {},
};

export const StreamConnectionContext = createContext<StreamConnectionState>(
  DEFAULT_CONNECTION_STATE,
);

export const useStreamConnection = (): StreamConnectionState => {
  return useContext(StreamConnectionContext);
};

export interface StreamProviderProps {
  children: React.ReactNode;
  userId: string;
  enableChat?: boolean;
  enableVideo?: boolean;
}

// The connector holds the SDK + the websocket lifecycle and renders NOTHING.
// ssr:false keeps the browser-only SDK off the server, and because it no longer
// wraps `children`, that no longer costs the dashboard its server rendering.
const StreamConnector = dynamic(() => import("@/providers/StreamProviderImpl"), {
  ssr: false,
});

/**
 * SDK-free shell. Renders `children` DIRECTLY — server-side included — and
 * mounts the connector as a sibling.
 *
 * Two bugs this shape exists to prevent, both measured:
 *
 *  1. `ssr: false` skips server rendering for the component AND its children.
 *     While the connector wrapped the dashboard, no dashboard markup reached
 *     the HTML: `<h1` never appeared in the document and FCP sat at ~6s no
 *     matter what happened on the server (#1102 measurements A/B/C).
 *  2. The connector used to swap the wrapper set once the sockets settled
 *     (`children` → `<StreamVideo>` → `<Chat>`). A changed element type at a
 *     position remounts that whole subtree — the storm behind "I pressed Join
 *     ten times" (#248). Children now sit in a fixed position forever.
 *
 * The SDK's own `<Chat>` / `<StreamVideo>` contexts are mounted by the surfaces
 * that actually consume them (the Messages tabs and /meetings), not here.
 */
const StreamProvider = ({ children, ...connectorProps }: StreamProviderProps) => {
  const snapshot = useSyncExternalStore(
    subscribeStreamConnection,
    getStreamConnectionSnapshot,
    getStreamConnectionServerSnapshot,
  );

  const retryConnection = useCallback(() => {
    // The connector owns the retry loop; it listens for this event so the
    // shell does not have to import anything from the SDK bundle to expose it.
    window.dispatchEvent(new CustomEvent("stream:retry-connection"));
  }, []);

  const value: StreamConnectionState = {
    chatConnected: snapshot.chatConnected,
    videoConnected: snapshot.videoConnected,
    isConnecting: snapshot.isConnecting,
    error: snapshot.error,
    retryConnection,
  };

  return (
    <StreamConnectionContext.Provider value={value}>
      {children}
      <StreamConnector {...connectorProps} />
    </StreamConnectionContext.Provider>
  );
};

export default StreamProvider;
