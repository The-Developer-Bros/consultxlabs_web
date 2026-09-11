import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { requireAuth } from "@/lib/auth-guard";
import { getWorkspaceSettings } from "@/lib/data/org-workspace";
import { SettingsPageClient } from "./SettingsPageClient";

/**
 * Server shell for the operator settings page. SSR-prefetches the
 * settings payload under ["org-workspace-settings", orgWorkspaceId] so
 * the client's useQuery hydrates from the dehydrated cache. The layout's
 * IDOR guard already ran; we resolve the userId here for the lib read.
 */
export default async function OrgWorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ orgWorkspaceId: string }>;
}) {
  const { orgWorkspaceId } = await params;
  const session = await requireAuth();
  const userId = session.user.id;

  const queryClient = new QueryClient();

  // Key MUST match SettingsPageClient's useQuery or hydration won't apply.
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-workspace-settings", orgWorkspaceId],
      queryFn: () => getWorkspaceSettings(userId, orgWorkspaceId),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SettingsPageClient orgWorkspaceId={orgWorkspaceId} />
    </HydrationBoundary>
  );
}
