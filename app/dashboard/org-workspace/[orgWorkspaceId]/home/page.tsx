import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { requireAuth } from "@/lib/auth-guard";
import {
  getOperatorOrganizations,
  getWorkspaceBillingRollup,
} from "@/lib/data/org-workspace";
import { workspaceBillingQueryKey } from "../workspace-billing-keys";
import { HomePageClient } from "./HomePageClient";

/**
 * Server shell for the operator home. SSR-prefetches the org list
 * (["org-workspace-orgs"]) and the cross-org billing roll-up
 * (["org-workspace-billing", orgWorkspaceId]) so the client's useQuery /
 * useWorkspaceBilling hydrate from the dehydrated cache. The layout's
 * IDOR guard already ran; we resolve the userId here for the lib reads.
 */
export default async function OrgWorkspaceHomePage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const queryClient = new QueryClient();

  // Query keys MUST match HomePageClient's useQuery / useWorkspaceBilling
  // or hydration won't apply.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-workspace-orgs"],
      queryFn: () => getOperatorOrganizations(userId),
    }),
    queryClient.prefetchQuery({
      queryKey: workspaceBillingQueryKey(orgWorkspaceId),
      queryFn: () => getWorkspaceBillingRollup(userId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient orgWorkspaceId={orgWorkspaceId} />
    </HydrationBoundary>
  );
}
