import { HydrationBoundary, QueryClient, dehydrate } from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";


import { MembersTabs } from "./MembersTabs";
import { getOrgMembers, ORG_MEMBERS_PER_PAGE } from "@/lib/data/org-members";

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // members.read — the roster is an operator surface (BILLING_ADMIN is
  // operator-blind by role design; the old `|| finance` branch let it in).
  // Guard before the SSR prefetch dehydrates the roster.
  const access = await requireOrgAccess(orgId, { permission: "members.read" });
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  const queryClient = new QueryClient();

  // #902 — the key + shape MUST match the client's first query
  // (["org-members", orgId, "", 1] → {members,total}) or hydration misses and
  // the roster re-fetches on mount (the bug this fixes).
  await Promise.allSettled([
    queryClient.prefetchQuery({
      queryKey: ["org-members", orgId, "", 1],
      queryFn: () => getOrgMembers(orgId, { page: 1, perPage: ORG_MEMBERS_PER_PAGE }),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <MembersTabs orgId={orgId} />
    </HydrationBoundary>
  );
}
