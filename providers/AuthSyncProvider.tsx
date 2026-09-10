"use client";

import { useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import {
  postAuthSync,
  readAuthedFlag,
  subscribeAuthSync,
  writeAuthedFlag,
} from "@/lib/auth-broadcast";

/**
 * Keeps the auth session in sync across browser tabs.
 *
 * Mounted once at the root. It does two things:
 *   1. Listens for login/logout pings from peer tabs and refetches this tab's
 *      session so every `useSession()` consumer re-renders without a reload.
 *   2. Detects this tab's own logged-out⇄logged-in transition (covers email
 *      sign-in AND the OAuth/SSO redirect, which has no client fetch hook) and
 *      pings peers so they refetch too.
 *
 * Renders nothing. See `lib/auth-broadcast.ts` for why this is needed.
 */
export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();
  // In-memory fallback for the previous authed state, used when the cross-tab
  // localStorage flag is unavailable (private mode / blocked storage) so
  // BroadcastChannel sync still works there. Resets per page load.
  const previousAuthedRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    return subscribeAuthSync(() => {
      refetch?.();
    });
  }, [refetch]);

  useEffect(() => {
    // The loading phase is not a transition — wait for the session to resolve.
    if (isPending) return;

    const authed = !!session?.user;
    // Prefer THIS tab's last observed state: the wrapped `signOut` clears the
    // localStorage flag BEFORE the network call (shared-device fail-safe), so
    // by the time the session resolves null the flag already reads `false` and
    // flag-first comparison would swallow the logout ping. The in-memory ref
    // is immune to that pre-clear; it is undefined only on first resolution,
    // where we fall back to the flag so an OAuth/SSO full-page redirect (new
    // load, no client fetch hook) still pings peers.
    const previous = previousAuthedRef.current ?? readAuthedFlag();
    // typeof check: with storage blocked, readAuthedFlag() returns null —
    // `null !== undefined` would treat "no known before-state" as a transition
    // and fire a spurious login/logout ping on first resolution.
    if (typeof previous === "boolean" && previous !== authed) {
      postAuthSync({ type: authed ? "login" : "logout" });
    }
    previousAuthedRef.current = authed;
    // Also the reconciliation point for the navbar's optimistic first paint:
    // a resolved session rewrites the remembered shape in BOTH directions, and
    // `writeAuthedFlag(false)` drops the cached identity outright.
    writeAuthedFlag(
      authed,
      authed
        ? {
            name: session?.user?.name ?? null,
            image: session?.user?.image ?? null,
          }
        : null,
    );
  }, [isPending, session]);

  return null;
}
