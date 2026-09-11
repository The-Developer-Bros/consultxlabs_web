"use client";

import { createContext, useContext, useMemo } from "react";

/**
 * The session user's id, resolved on the SERVER and handed to the client
 * dashboard layouts.
 *
 * Those layouts derive identity from `useSession()`, a client hook that is
 * still pending during SSR — so `getEffectiveUserId(session)` is `undefined`
 * there, their `["user-details", userId]` query keys become
 * `["user-details", undefined]`, and a server-side seed of the real key is
 * never read. That is why they render `PersonalDashboardShellSkeleton` instead
 * of `children` server-side, and why no dashboard markup reaches the HTML at
 * all (#1103 measurement: no `<h1`, no nav, FCP ~6s).
 *
 * A context rather than a prop because `app/dashboard/layout.tsx` passes the
 * layouts through `children` and cannot hand them props directly.
 *
 * Identity only — never authorization. The guards still resolve the session
 * themselves; this exists so the FIRST render can name the right query key.
 */
/**
 * Facts the SERVER already knows about the session, for client code whose first
 * render would otherwise have to wait on `useSession()`.
 *
 * `userId` fixes the query keys (see above). `role` and `firstOrgId` fix the
 * ORG SCOPE segment: `useOrgScope` derives it from `useSession()` too, so during
 * SSR it always resolved to `personal` while the server pages computed `all` for
 * org members / admins / staff — a guaranteed prefetch-key miss on every
 * hydration, then a second key flip once the session landed.
 */
export interface ServerSessionFacts {
  userId: string | undefined;
  role: string | undefined;
  firstOrgId: string | null;
}

const EMPTY: ServerSessionFacts = {
  userId: undefined,
  role: undefined,
  firstOrgId: null,
};

const ServerSessionFactsContext = createContext<ServerSessionFacts>(EMPTY);

export function ServerUserIdProvider({
  userId,
  role,
  firstOrgId = null,
  children,
}: Readonly<{
  userId: string | undefined;
  role?: string | undefined;
  firstOrgId?: string | null;
  children: React.ReactNode;
}>) {
  const value = useMemo(
    () => ({ userId, role, firstOrgId }),
    [userId, role, firstOrgId],
  );
  return (
    <ServerSessionFactsContext.Provider value={value}>
      {children}
    </ServerSessionFactsContext.Provider>
  );
}

export function useServerUserId(): string | undefined {
  return useContext(ServerSessionFactsContext).userId;
}

export function useServerSessionFacts(): ServerSessionFacts {
  return useContext(ServerSessionFactsContext);
}
