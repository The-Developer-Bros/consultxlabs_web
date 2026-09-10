import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { requireOnboarded } from "@/lib/auth-guard";
import { getUserDetails } from "@/lib/data/user-details";
import { toPlain } from "@/lib/data/serialize";
import { ServerUserIdProvider } from "@/components/dashboard/ServerUserId";

/**
 * Seeds the query that both personal dashboard layouts gate their render on.
 *
 * The consultant and consultee layouts are client components that return a
 * shell skeleton instead of `children` whenever their queries are loading —
 * always true during SSR, because nothing prefetched them. So no dashboard
 * markup reached the HTML at all: measured on #1103, the server response had
 * no `<h1`, none of the sidebar nav, and FCP sat at ~6s while "Welcome back"
 * arrived at 4.6s inside the RSC payload. That is the blocker underneath
 * #1102's Suspense boundaries and #1103's StreamProvider scoping — both real
 * fixes, both invisible until this one moves.
 *
 * Their guard is `(...loading) && !consultantData && !userDetails`, so seeding
 * EITHER query opens it. Seeding `user-details` here is deliberate on two
 * counts:
 *
 *  - This layout already resolves the session, and `user-details` is keyed on
 *    the SESSION user — never the profile id in the URL, which belongs to
 *    someone else when an ADMIN/STAFF inspects a dashboard.
 *  - The consultant read carries public/private access levels, #726
 *    plan-visibility filtering and PII narrowing. Re-deriving that for a
 *    prefetch is how the #946 leak happened; this is the viewer's own row.
 *
 * Living here rather than in a per-profile server layout covers consultant and
 * consultee with one seed, and avoids splitting either client layout into a
 * separate shell file — SonarCloud counts a renamed file as wholly new code and
 * then flags the long-standing duplication between the two layouts as new.
 *
 * The key MUST stay in step with both layouts' `useQuery`:
 * ["user-details", userId].
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireOnboarded();
  const queryClient = new QueryClient();

  // Swallow: a failed seed should degrade to the client fetch, not 500 every
  // dashboard route. Losing it only costs the server-rendered shell.
  await queryClient
    .prefetchQuery({
      queryKey: ["user-details", session.user.id],
      // The route responds `{ data: user }` and the client fetcher unwraps
      // `.data`, so the cached value is the user row itself.
      queryFn: async () => toPlain(await getUserDetails(session.user.id)),
    })
    .catch(() => undefined);

  return (
    <ServerUserIdProvider
      userId={session.user.id}
      role={session.user.role}
      firstOrgId={
        session.user.organizationMemberships?.[0]?.organizationId ?? null
      }
    >
      <HydrationBoundary state={dehydrate(queryClient)}>
        {children}
      </HydrationBoundary>
    </ServerUserIdProvider>
  );
}
