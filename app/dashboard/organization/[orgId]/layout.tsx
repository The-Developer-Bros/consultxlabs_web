import * as Sentry from "@sentry/nextjs";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import OrgDashboardShell from "./OrgDashboardShell";
import { getOrgDetailsForSeed } from "@/lib/data/org-details-server";
import { orgDetailsQueryKey } from "@/lib/api/organizations/org-details";
import { toPlain } from "@/lib/data/serialize";

/**
 * Server shell that seeds the query the whole org tree gates on.
 *
 * `useOrgRole` reads `data?.membership.role ?? "LEARNER"` and
 * `orgDetailsQueryKey(orgId)` was never prefetched anywhere, so during SSR
 * `data` was undefined, the role failed closed to LEARNER, every operator
 * permission check failed, and ~15 components under this tree hit
 * `if (!allowed) return null`. The org dashboard emitted no markup at all.
 *
 * Two prefetches that already existed were dead on arrival behind that gate:
 * `analytics/page.tsx` seeds `["org-analytics", orgId]` with a comment
 * correctly insisting the key must match — it does — and
 * `AnalyticsPageClient` still returned null before reading it. Same for
 * `members/page.tsx`. Seeding here is what makes those two pay off.
 *
 * Worse than a blank shell: org home reads `isOperator` from that role, so the
 * server rendered the CONSUMER view and swapped to the operator dashboard after
 * hydration — a view-identity change, not a fill-in.
 *
 * Authorization is not weakened. `getOrgDetailsForSeed` runs the same
 * `requireOrgAccess(orgId, "LEARNER")` the API route runs, and returns null
 * rather than throwing so a non-member simply gets no seed.
 */
export default async function OrgDashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}>) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // Swallow: a failed seed must degrade to the client fetch, never 500 the
  // whole org tree. Losing it only costs the server-rendered shell.
  // Reported, not rethrown: a silent swallow makes a transient read failure and
  // a sustained auth/database outage look identical from the outside, since both
  // just degrade to the client fetch.
  const details = await getOrgDetailsForSeed(orgId).catch((err: unknown) => {
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "org-dashboard-seed" }, extra: { orgId } },
    );
    return null;
  });

  // Only seed a real read. Caching `null` is worse than not seeding: the client
  // gate reads `!org` either way, but a null cache entry also suppresses the
  // client's own fetch, so a non-member or a transient read failure would leave
  // the tree permanently empty instead of self-healing on hydration.
  if (details) {
    await queryClient.prefetchQuery({
      queryKey: orgDetailsQueryKey(orgId),
      queryFn: async () => toPlain(details),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <OrgDashboardShell params={params}>{children}</OrgDashboardShell>
    </HydrationBoundary>
  );
}
