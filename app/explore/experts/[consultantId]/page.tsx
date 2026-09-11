import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  getConsultantDetail,
  getConsultantReviews,
} from "@/lib/data/consultant-detail";
import { TUserWithProfessionalBackground } from "@/types/user";
import { ExpertProfileClient } from "./ExpertProfileClient";
import { ConsultantSkeletonLoader } from "./components/ConsultantSkeletonLoader";

// ISR per consultantId, not force-dynamic. The cache key is the expert being
// viewed, never the viewer: this page reads no session, and the layout above it
// reads none either. Real-time bookability is NOT in this HTML — the client
// fetches /api/slots/availability-with-allocation on mount, so a cached
// document can't show a stale "free" slot.
//
// 5 minutes, and the read underneath is uncached (lib/data/consultant-detail.ts
// is React.cache, i.e. per-request only), so this is the largest saving in the
// change. An expert's own edits purge this path on demand at the write site, so
// they don't watch their changes sit stale.
export const revalidate = 300;

// Required for `revalidate` above to be anything other than dead config: Next
// renders a dynamic segment dynamically unless generateStaticParams exists, and
// silently ignores the interval. The empty array is the documented "all paths at
// runtime" shape — nothing is prerendered during `next build`, which is what we
// want here twice over: consultant cardinality is unbounded (prerendering every
// profile would bloat the build) and it keeps these reads off the build-time
// cross-region pooler connect (#932). dynamicParams defaults to true, so a slug
// not in the array still renders on demand rather than 404ing.
// https://nextjs.org/docs/15/app/api-reference/functions/generate-static-params
export function generateStaticParams() {
  return [];
}

type Params = Promise<{ consultantId: string }>;

export default async function ExpertProfile({
  params,
}: Readonly<{ params: Params }>) {
  const { consultantId } = await params;

  // This render is cacheable, so it must never swallow a failure: a 200 carrying
  // the old "taking a moment to load" shell was written to the Netlify durable
  // cache and replayed to everyone for the rest of the window (#1119). A transient
  // pooler timeout now reaches error.tsx instead, which caches nothing.
  //
  // Note what that costs, because it is not free: `generateStaticParams` returns
  // [], so a parameter being rendered for the first time has NO cached copy to
  // fall back on and its visitor gets the error boundary. Only a *revalidation*
  // of an already-cached profile keeps serving the last good copy.
  const [consultant, reviews] = await Promise.all([
    getConsultantDetail(consultantId),
    getConsultantReviews(consultantId),
  ]);

  if (!consultant || !consultant.user) {
    notFound();
  }

  return (
    <Suspense fallback={<ConsultantSkeletonLoader />}>
      <ExpertProfileClient
        consultantDetails={consultant}
        userDetails={consultant.user as TUserWithProfessionalBackground}
        reviews={reviews}
      />
    </Suspense>
  );
}
