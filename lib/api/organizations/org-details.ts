/**
 * Client-side fetcher for `GET /api/organizations/[orgId]`.
 *
 * Extracted so every consumer on the org dashboard can share a single
 * queryFn behind the react-query key `["organization", orgId]`. Before
 * this existed, each caller inlined its own queryFn (or tried the
 * `enabled: false` trick to read from the shared cache). React-Query v5
 * requires a queryFn even when `enabled` is false, so "cache-only" was
 * a footgun. With the shared fetcher:
 *
 * - The org layout owns the authoritative fetch (it renders first).
 * - Child pages (e.g. /invitations) pass the same fetcher + queryKey,
 *   react-query dedupes, and the cached payload always has the full
 *   `OrgDetailsResponse` shape — no sparse-shape drift, no "missing
 *   queryFn" crash.
 *
 * Error strategy: THROWS on non-2xx. Call sites that want a
 * degraded / fail-closed view should catch via react-query's
 * `errorBoundary` / `onError`, not inside this fetcher.
 */

import {
  flattenOrgDetails,
  type OrgDetailsResponse,
  type RawOrgDetailsResponse,
} from "@/types/org-details";

export function orgDetailsQueryKey(orgId: string) {
  return ["organization", orgId] as const;
}

export async function fetchOrgDetails(
  orgId: string,
): Promise<OrgDetailsResponse> {
  const res = await fetch(`/api/organizations/${orgId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to load organization");
  }
  const raw = (await res.json()) as RawOrgDetailsResponse;
  return flattenOrgDetails(raw);
}
