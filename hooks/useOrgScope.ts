"use client";

/**
 * useOrgScope — client-side hook for the #674 / B1-hybrid scope split.
 * Mirrors `lib/api/scope/parse.ts` on the server side.
 *
 * URL `?orgScope=...` is the source of truth — no localStorage. Setter
 * uses `router.replace` so toggling the dropdown doesn't pollute the
 * back stack.
 *
 * Three values, three behaviors:
 *   - `personal` (default)
 *   - `<orgId>`
 *   - `all` (admin/staff only, gated server-side)
 *
 * Route-pinned mode: when the page lives under
 * `/dashboard/organization/[orgId]/...`, the `orgIdFromPath` is detected
 * and the hook forces `scope = org:<orgId>` regardless of the URL
 * param. This prevents the org dashboard from leaking into personal-
 * scope mode if a stray `?orgScope=personal` is appended.
 */

import { useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams, usePathname } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { useServerSessionFacts } from "@/components/dashboard/ServerUserId";

export type Scope =
  | { kind: "personal" }
  | { kind: "org"; orgId: string }
  | { kind: "all" };

export interface UseOrgScopeResult {
  scope: Scope;
  /** URL-form serialization — `personal | <orgId> | all`. */
  serialized: string;
  setScope: (next: Scope) => void;
  /** True if the URL path pins the scope (org dashboard route). */
  pinned: boolean;
  /**
   * Convenience: the orgId the hook resolved to, or null. Backwards-
   * compatible with the older single-purpose `{ orgId }` shape.
   */
  orgId: string | null;
}

function parseRaw(raw: string | null): Scope {
  const v = raw?.trim();
  if (!v || v === "personal") return { kind: "personal" };
  if (v === "all") return { kind: "all" };
  return { kind: "org", orgId: v };
}

function serialize(scope: Scope): string {
  if (scope.kind === "personal") return "personal";
  if (scope.kind === "all") return "all";
  return scope.orgId;
}

export interface UseOrgScopeOptions {
  /**
   * Default scope for org members when the URL has no `?orgScope=`.
   *   - "first-org" (default) — land on their first org so org-funded
   *     items surface without a manual toggle.
   *   - "all" — land on the union view (personal + every org). Only
   *     safe on pages that hit `allowAllForOwner: true` routes (see
   *     lib/api/scope/parse.ts) — e.g. the consultee appointments
   *     page, where seeing the full picture by default is the most
   *     useful landing state.
   *   - "personal" — B2C only, even for org members. For surfaces that
   *     ADR 19 splits strictly by org-ness and that have a separate
   *     org-tree counterpart, so merging the two here would duplicate a
   *     destination rather than complete one. Chat is the case: the org
   *     half lives at /dashboard/organization/[orgId]/messages.
   * ADMIN / STAFF default to "all" regardless of this option — EXCEPT when a
   * caller passes "personal" explicitly, which wins for everyone. A privileged
   * user landing on the union of a surface that has a separate org-tree half
   * would see the org rows twice, once here and once there.
   * B2C users (no orgs) always default to "personal".
   */
  defaultForOrgMember?: "first-org" | "all" | "personal";
}

export function useOrgScope(
  options?: UseOrgScopeOptions,
): UseOrgScopeResult {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const defaultForOrgMember = options?.defaultForOrgMember ?? "first-org";

  const orgIdFromPath =
    typeof params?.orgId === "string" ? params.orgId : null;
  const pinned = Boolean(
    orgIdFromPath && pathname?.startsWith("/dashboard/organization/"),
  );

  // Fall back to the server-resolved facts. useSession() is still pending
  // during SSR, so without this both values are empty there and the scope
  // always resolved to `personal` — while the server pages computed `all` for
  // org members / admins / staff. The scope segment is part of the query key
  // (["consultee-events", id, scopeKey]), so every such user got a guaranteed
  // hydration miss and then a second key flip once the session landed. The
  // appointments pages document this and work around it by prefetching only
  // "personal", which is why org members get no hydration on their busiest tab.
  const serverFacts = useServerSessionFacts();
  const role = session?.user?.role ?? serverFacts.role;
  const firstOrgId =
    session?.user?.organizationMemberships?.[0]?.organizationId ??
    serverFacts.firstOrgId;

  const scope: Scope = useMemo(() => {
    if (pinned && orgIdFromPath) {
      return { kind: "org", orgId: orgIdFromPath };
    }
    const raw = searchParams?.get("orgScope") ?? null;
    // URL is the source of truth. Honor whatever it says.
    if (raw) return parseRaw(raw);

    // An explicit "personal" wins even for privileged users: the caller is
    // saying this surface is the B2C half of a split, and an admin landing on
    // the union there would see the org rows twice — once here and once in the
    // org tree.
    if (defaultForOrgMember === "personal") return { kind: "personal" };
    if (role === "ADMIN" || role === "STAFF") return { kind: "all" };
    if (firstOrgId) {
      return defaultForOrgMember === "all"
        ? { kind: "all" }
        : { kind: "org", orgId: firstOrgId };
    }
    return { kind: "personal" };
  }, [
    pinned,
    orgIdFromPath,
    searchParams,
    role,
    firstOrgId,
    defaultForOrgMember,
  ]);

  const setScope = useCallback(
    (next: Scope) => {
      if (pinned) return; // No-op when route-pinned.
      const sp = new URLSearchParams(searchParams?.toString() ?? "");
      // Always write the param so the URL reflects the user's choice.
      // Previously we omitted `?orgScope=personal` because personal was
      // the implicit default. Now that the default is role-dependent
      // (first org for org members, all for admins), omitting the
      // param would let the default rule snap the user back instantly,
      // making "Personal only" effectively unselectable.
      sp.set("orgScope", serialize(next));
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [pinned, pathname, router, searchParams],
  );

  return {
    scope,
    serialized: serialize(scope),
    setScope,
    pinned,
    orgId: scope.kind === "org" ? scope.orgId : null,
  };
}
