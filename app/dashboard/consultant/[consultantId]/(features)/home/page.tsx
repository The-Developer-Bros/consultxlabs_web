import { Suspense } from "react";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import HomePageClient from "./HomePageClient";
import { HomeSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { NeedsYouCard } from "@/components/dashboard/NeedsYouCard";
import { getSession } from "@/lib/auth-server";
import { getConsultantDashboard } from "@/lib/data/consultant-dashboard";
import { getNeedsYouSummary } from "@/lib/data/needs-you";
import { requirePersonalProfileAccess } from "@/lib/auth/personal-dashboard-access";

type PageProps = {
  params: Promise<{ consultantId: string }>;
};

// The page stays FIRST in this file on purpose. The suspended sections below
// hold the reads, and __tests__/security/personal-dashboard-ssr-ownership.test.ts
// asserts the ownership guard appears ahead of them in source order. Runtime
// ordering is guaranteed regardless — the guard is awaited before the JSX
// naming those sections is returned, so neither can start early — but keeping
// the source in the same order keeps that invariant cheap to verify.
export default async function HomePage({ params }: Readonly<PageProps>) {
  const { consultantId } = await params;
  // Ownership is enforced HERE, not by the layout: the layout is a client
  // component, so its check runs after this server render has already read
  // and streamed the data. See lib/auth/personal-dashboard-access.ts.
  //
  // This await deliberately stays OUTSIDE the Suspense boundaries. It is the
  // authorization gate, and streaming chrome before it resolves would paint
  // dashboard shell for someone who is about to be redirected.
  const access = await requirePersonalProfileAccess("consultant", consultantId);

  // Free: requirePersonalProfileAccess above already resolved this exact call,
  // and getSession is React.cache'd per render, so both share one entry.
  const session = await getSession(true);
  // An ADMIN/STAFF inspecting someone else's dashboard would otherwise be
  // greeted by their OWN name, since the session is the viewer's. The owner's
  // name lives in the layout's cached profile, which is not available here
  // without another round trip — so inspectors get a neutral title instead.
  const firstName = access.isInspecting
    ? null
    : session?.user?.name?.split(" ")[0];

  // Everything below streams. Measured before this change: the first byte
  // already arrived at ~0.4s, but the response did not complete until ~4.9s
  // and FCP landed at 6.2s, because the page awaited every query before
  // returning any JSX. The queries are unchanged — they just no longer gate
  // the shell.
  return (
    <>
      {/* Real text, rendered server-side outside every boundary. A skeleton
          cannot trigger FCP — it has no text, image or SVG — which is why the
          first pass moved the shell to 458ms and left FCP at ~6s anyway. */}
      <DashboardHeader
        title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        subtitle="Here's what's happening with your appointments today"
      />
      {/* fallback={null}, not a skeleton: NeedsYouCard renders nothing for a
          consultant with no org contexts, so a placeholder would flash a card
          that then vanishes. */}
      {!access.isInspecting && (
        <Suspense fallback={null}>
          <NeedsYouSection userId={access.userId} consultantId={consultantId} />
        </Suspense>
      )}
      <Suspense fallback={<HomeSkeleton withHeader={false} />}>
        <DashboardSection consultantId={consultantId} />
      </Suspense>
    </>
  );
}

/**
 * Cross-context roll-up (ADR 19's sanctioned "derived read"). Rendered only for
 * the profile owner: the summary keys off the VIEWER's memberships, which are
 * not the owner's when an ADMIN/STAFF inspects, so it would answer a question
 * nobody asked. Failure is non-fatal — the card is supplementary and the page
 * must not 500 because a count timed out.
 */
async function NeedsYouSection({
  userId,
  consultantId,
}: Readonly<{ userId: string; consultantId: string }>) {
  const needsYou = await getNeedsYouSummary(userId, consultantId).catch(
    () => null,
  );
  if (!needsYou) return null;
  return (
    <div className="px-4 pt-4 sm:px-6 lg:px-8">
      <NeedsYouCard summary={needsYou} />
    </div>
  );
}

/**
 * #890 — SSR prefetch the dashboard so the client useQuery hydrates without a
 * fetch waterfall. Key MUST match createConsultantQueries(...).dashboard:
 * ["consultant-dashboard", id]. The Home query is NOT org-scoped (the route
 * filters by consultantProfileId only), so there is a single deterministic
 * payload to prefetch.
 *
 * The prefetch and the dehydrate must stay together in this component:
 * dehydrate only captures what has already resolved, so hoisting either half
 * back into the page would serialize an empty cache.
 */
async function DashboardSection({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const queryClient = new QueryClient();
  // Swallow, don't rethrow: a read failure should degrade to a client-side
  // fetch rather than surfacing the Suspense error boundary for the whole tab.
  await queryClient
    .prefetchQuery({
      queryKey: ["consultant-dashboard", consultantId],
      queryFn: () => getConsultantDashboard(consultantId),
    })
    .catch(() => undefined);

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <HomePageClient consultantId={consultantId} />
    </HydrationBoundary>
  );
}
