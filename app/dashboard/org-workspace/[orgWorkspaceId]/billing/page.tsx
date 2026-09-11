import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { requireAuth } from "@/lib/auth-guard";
import { getWorkspaceBillingRollup } from "@/lib/data/org-workspace";
import { workspaceBillingQueryKey } from "../workspace-billing-keys";
import { BillingPageClient } from "./BillingPageClient";

/**
 * Server shell for the operator billing overview. SSR-prefetches the
 * cross-org billing roll-up under the SAME key the home page uses
 * (["org-workspace-billing", orgWorkspaceId]) so navigating home↔billing
 * hits one cached entry. The layout's IDOR guard already ran; we resolve
 * the userId here for the lib read.
 */
export default async function OrgWorkspaceBillingPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const queryClient = new QueryClient();

  // Key MUST match BillingPageClient's useWorkspaceBilling or hydration
  // won't apply, which is why both read it from workspace-billing-keys.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: workspaceBillingQueryKey(orgWorkspaceId),
      queryFn: () => getWorkspaceBillingRollup(userId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <BillingPageClient orgWorkspaceId={orgWorkspaceId} />
    </HydrationBoundary>
  );
}
