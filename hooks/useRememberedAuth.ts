"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import {
  readAuthedFlag,
  readAuthedIdentity,
  type AuthIdentity,
} from "@/lib/auth-broadcast";

/**
 * `useLayoutEffect` warns when React renders on the server; `useEffect` never
 * runs there at all, so it is the correct no-op stand-in. Standard isomorphic
 * pattern — this is the only copy in the repo, keep it that way.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type RememberedAuth = { authed: boolean; identity: AuthIdentity | null };

/**
 * The last resolved auth shape, read from localStorage AFTER commit but BEFORE
 * paint, so the first painted frame can show "Sign in" or the user's avatar
 * instead of a skeleton that lingers for the whole `/api/auth/get-session`
 * round trip (measured warm on prod: ~350 ms logged out, ~1,000 ms logged in —
 * the session fetch already dispatches within ±40 ms of FCP, so the delay IS
 * the round trip and there is no earlier moment to dispatch from).
 *
 * Returns `null` on the server render and on the first client render, which is
 * what keeps hydration byte-identical: reading localStorage during render would
 * be a mismatch and React would discard the tree.
 *
 * PRESENTATION ONLY. This value is attacker-controlled (it is just
 * localStorage) and may be stale for up to one round trip. Nothing may branch
 * on it except which chrome to paint — `/dashboard` is gated in
 * `middleware.ts` and again on the server.
 */
export function useRememberedAuth(): RememberedAuth | null {
  const [remembered, setRemembered] = useState<RememberedAuth | null>(null);

  useIsomorphicLayoutEffect(() => {
    const authed = readAuthedFlag();
    // No flag = a genuinely unknown visitor (first ever visit, cleared storage,
    // private mode). Keep the skeleton rather than guessing.
    if (authed === null) return;
    setRemembered({
      authed,
      identity: authed ? readAuthedIdentity() : null,
    });
  }, []);

  return remembered;
}

export type AuthViewMode = "unknown" | "authed" | "anonymous";

export interface AuthView {
  mode: AuthViewMode;
  name: string | null;
  image: string | null;
}

/**
 * Picks the auth chrome to render. Truth wins the moment the session resolves;
 * until then the remembered shape stands in for it.
 *
 * Accepted risk: a returning user whose session expired server-side sees their
 * avatar for up to ~1 s before it reverts to "Sign in". Cosmetic only — see the
 * hook's contract above.
 */
export function resolveAuthView(input: {
  isPending: boolean;
  user: { name?: string | null; image?: string | null } | null | undefined;
  remembered: RememberedAuth | null;
}): AuthView {
  const { isPending, user, remembered } = input;

  if (!isPending) {
    return user
      ? { mode: "authed", name: user.name ?? null, image: user.image ?? null }
      : { mode: "anonymous", name: null, image: null };
  }
  if (!remembered) return { mode: "unknown", name: null, image: null };
  return remembered.authed
    ? {
        mode: "authed",
        name: remembered.identity?.name ?? null,
        image: remembered.identity?.image ?? null,
      }
    : { mode: "anonymous", name: null, image: null };
}
