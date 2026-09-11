import { Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import {
  DEFAULT_ORGANISATION_FILTERS,
  getOrganisationsMetadata,
  getOrganisationsPage,
} from "@/lib/data/explore-organisations";
import { withBuildTimeRetry } from "@/lib/data/fail-open";

import OrganisationsInteractiveContent, {
  OrganisationsGridSkeleton,
} from "./OrganisationsInteractiveContent";

// ISR, not force-dynamic. The directory reads no session and no searchParams
// (filtering is client-side in OrganisationsInteractiveContent), and it lists
// only `isPublic` ACTIVE orgs, so every visitor is entitled to the same HTML.
//
// force-dynamic made this uncacheable at the CDN (Next sends dynamic pages
// `private, no-store`), so every visit paid a cross-region DB round trip for a
// list that turns over on the order of days.
//
// This route IS prerendered during `next build` (#932): the reads run in the
// build environment and no longer degrade at all (#1119), so a transient pooler
// failure fails the build instead of baking an empty directory.
//
// 5 minutes: unlike the expert reads this one has no unstable_cache layer, so
// the interval is the only thing between visitors and the DB. Orgs going public
// purge this path on demand at the write sites.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "Explore Organisations | Familiarise",
  description:
    "Discover expert networks, consulting agencies, and learning institutions on Familiarise. Browse their curated experts and programs.",
};

async function OrganisationsDirectory() {
  // Both reads throw on a transient pooler timeout (cross-region cold connect,
  // #932). They used to degrade, which was safe while this route was dynamic and
  // is not now that it is ISR — a degraded directory would be cached and replayed
  // to everyone (#1119).
  const [meta, firstPage] = await Promise.all([
    withBuildTimeRetry(getOrganisationsMetadata),
    withBuildTimeRetry(() => getOrganisationsPage(DEFAULT_ORGANISATION_FILTERS)),
  ]);

  return (
    <OrganisationsInteractiveContent
      metadata={meta}
      initialItems={firstPage.items}
      initialTotal={firstPage.total}
    />
  );
}

export default function ExploreOrganisationsPage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Hero */}
      <section className="relative overflow-hidden bg-zinc-950 pt-32 pb-16">
        <div className="absolute inset-0">
          <div className="animate-blob absolute left-1/4 top-1/4 h-[500px] w-[500px] rounded-full bg-zinc-800/30 blur-[120px]" />
          <div className="animate-blob animation-delay-2000 absolute bottom-1/4 right-1/4 h-[400px] w-[400px] rounded-full bg-zinc-700/20 blur-[100px]" />
        </div>
        <div className="grid-pattern absolute inset-0 opacity-20" />

        <div className="relative z-10 mx-auto max-w-[1400px] px-4 md:px-8">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-zinc-700/50 bg-zinc-800/50 px-4 py-2 backdrop-blur-sm">
              <Sparkles className="h-4 w-4 text-white" />
              <span className="text-sm font-medium text-zinc-300">
                Expert Networks &amp; Agencies
              </span>
            </div>
            <h1 className="text-fluid-4xl mb-6 font-bold tracking-tight text-white">
              Explore <span className="silver-text">Organisations</span>
            </h1>
            <p className="mx-auto max-w-xl text-lg text-zinc-300">
              Discover expert networks, consulting agencies, and learning
              institutions on Familiarise. Book their curated experts directly.
            </p>
          </div>
        </div>
      </section>

      <Suspense
        fallback={
          <section className="py-10 md:py-16">
            <div className="mx-auto max-w-[1400px] px-4 md:px-8">
              <OrganisationsGridSkeleton />
            </div>
          </section>
        }
      >
        <OrganisationsDirectory />
      </Suspense>
    </main>
  );
}
