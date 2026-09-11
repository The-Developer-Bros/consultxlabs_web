import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { requireAuth } from "@/lib/auth-guard";
import { getWorkspaceActivity } from "@/lib/data/org-workspace";
import { ActivityPageClient } from "./ActivityPageClient";

/**
 * Server shell for the cross-org activity feed. SSR-prefetches the FIRST
 * page (cursor=null) under ["org-workspace-activity", orgWorkspaceId] via
 * prefetchInfiniteQuery with initialPageParam: null — byte-identical to
 * the client's useInfiniteQuery so hydration seeds page 1 and Load-more
 * continues client-side. The layout's IDOR guard already ran; we resolve
 * the userId here for the lib read.
 */
export default async function OrgWorkspaceActivityPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const queryClient = new QueryClient();

  await Promise.allSettled([
    queryClient.prefetchInfiniteQuery({
      queryKey: ["org-workspace-activity", orgWorkspaceId],
      queryFn: ({ pageParam }) =>
        getWorkspaceActivity(userId, pageParam as string | null),
      initialPageParam: null as string | null,
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ActivityPageClient orgWorkspaceId={orgWorkspaceId} />
    </HydrationBoundary>
  );
}
