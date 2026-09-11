import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { HomePageClient } from "./HomePageClient";
import { getOrgAnalytics } from "@/lib/data/org-analytics";
import { getOrgActivityFeed } from "@/lib/data/org-activity";

export default async function OrgHomePage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const queryClient = new QueryClient();

  // /home is the universal landing page for every org role, so don't gate
  // the whole page. Only the analytics aggregate is operations-scoped
  // (mirrors GET /api/organizations/[orgId]/analytics + the client's
  // `enabled: isOperator || isFinanceLead`), so guard just the prefetch —
  // lower roles still get their overview, they simply don't dehydrate
  // operations data.
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });

  // queryKey MUST match HomePageClient's analytics useQuery
  // (["org-analytics", orgId]) or hydration won't apply. The home page's
  // primary read is the analytics aggregate — same key + payload the
  // analytics page uses.
  //
  // The operator activity feed (["org-activity", orgId]) is SSR-seeded too,
  // so operators stop seeing the activity card pop in after hydration (the
  // old client-only second waterfall). Same key + payload shape as
  // HomePageClient's fetchActivity ({ activity: rows }); the client query's
  // `enabled: isOperator` gate still governs whether it displays, and an
  // unused seed for a non-operator role with operations.read is a harmless
  // cache entry.
  if (!access.error) {
    await Promise.allSettled([
      queryClient.prefetchQuery({
        queryKey: ["org-analytics", orgId],
        queryFn: () => getOrgAnalytics(orgId),
      }),
      queryClient.prefetchQuery({
        queryKey: ["org-activity", orgId],
        queryFn: () =>
          getOrgActivityFeed(orgId, 5).then((rows) => ({ activity: rows })),
      }),
    ]);
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgId={orgId} />
    </HydrationBoundary>
  );
}
