import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Building2,
  Globe,
  Users,
  BadgeCheck,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import prisma from "@/lib/prisma";
import { eventPlanDiscoverableWhere } from "@/lib/api/plans/visibility";

import {
  ORG_DIRECTORY_TYPE_LABEL,
  ORG_SIZE_BUCKET_LABEL,
} from "@/lib/labels/org-labels";
import { cache } from "react";
import type { Metadata } from "next";

// One select for all four plan relations so the org card shape cannot drift
// per type. `subtitle` is the line the card renders under the title.
const PUBLIC_PLAN_CARD_SELECT = {
  id: true,
  title: true,
  subtitle: true,
  description: true,
  price: true,
  priceCurrency: true,
} as const;


// ISR per orgSlug, not force-dynamic. The cache key is the org being viewed,
// never the viewer: no session is read here or in any layout above, and the
// query is already scoped to `isPublic` ACTIVE orgs, so the HTML is public by
// construction.
//
// 5 minutes. This surface links straight into checkout-bound plan pages and the
// plan lists are gated by eventPlanDiscoverableWhere(), so a withdrawn plan
// lingering in cached HTML is a dead-end click — which is why archiving or
// hiding a plan purges this path on demand rather than waiting out the window.
export const revalidate = 300;

// Required for `revalidate` above to be anything other than dead config: Next
// renders a dynamic segment dynamically unless generateStaticParams exists, and
// silently ignores the interval. The empty array is the documented "all paths at
// runtime" shape — nothing is prerendered during `next build`, so org pages stay
// off the build-time cross-region pooler connect (#932) and each renders on its
// first request instead. dynamicParams defaults to true, so a slug not in the
// array still renders on demand rather than 404ing.
// https://nextjs.org/docs/15/app/api-reference/functions/generate-static-params
export function generateStaticParams() {
  return [];
}

// React.cache so generateMetadata() and the page body share one query per request
// instead of running this heavy org read twice (more visible now it's per-request).
const fetchOrgBySlug = cache(async (slug: string) => {
  const row = await prisma.organization.findFirst({
    // canHost intentionally absent: the directory lists every opted-in ACTIVE
    // org, so requiring it here would 404 exactly the orgs the index links to.
    where: { slug, isPublic: true, status: "ACTIVE", deletedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      canSponsor: true,
      canHost: true,
      brandingProfile: {
        select: {
          logo: true,
          bannerImage: true,
          description: true,
          industry: true,
          website: true,
          sizeBucket: true,
          directoryType: true,
        },
      },
      // #778 elegance — the org "catalog" is its org-owned per-type plans
      // (organizationId set on the plan) that are publicly visible. The standalone
      // OrganizationPlan model was collapsed into these (one bookable shape).
      //
      // #catalog-archive — this page previously filtered `visibility` but not
      // `archivedAt`, so a withdrawn plan still rendered here and linked
      // straight into checkout. It was the one public surface bypassing
      // eventPlanDiscoverableWhere(); all four now carry the archive gate.
      consultationPlans: {
        where: eventPlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      subscriptionPlans: {
        where: eventPlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      webinarPlans: {
        where: eventPlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      classPlans: {
        where: eventPlanDiscoverableWhere(),
        select: PUBLIC_PLAN_CARD_SELECT,
        take: 6,
      },
      memberships: {
        where: {
          role: "EXPERT",
          status: "ACTIVE",
          consultantProfile: {
            verificationStatus: "VERIFIED",
            // NOT filtered on `isIndependent: false`. That column is derived —
            // "true iff zero ACTIVE EXPERT memberships at canHost orgs" — and is
            // only recomputed by recomputeConsultantIsIndependent() after a
            // membership mutation. Anything that writes memberships directly
            // (the seed, a backfill, a manual fix) leaves it stale, and a stale
            // `true` hid every expert on this page even though the membership
            // being selected here is itself the proof they aren't independent.
            // The join is the source of truth; the flag is a cache of it.
            deletedAt: null,
          },
        },
        select: {
          consultantProfile: {
            select: {
              id: true,
              headline: true,
              rating: true,
              isVerified: true,
              experience: true,
              user: {
                select: { name: true, image: true, profileDisplayImage: true },
              },
              domain: { select: { name: true } },
            },
          },
        },
        take: 12,
      },
    },
  });
  if (!row) return null;
  // Normalize the four org-owned per-type plan lists into one catalog array,
  // tagged with planType, so the sidebar render is unchanged.
  const organizationPlans = [
    ...row.consultationPlans.map((p) => ({
      ...p,
      planType: "CONSULTATION" as const,
    })),
    ...row.subscriptionPlans.map((p) => ({
      ...p,
      planType: "SUBSCRIPTION" as const,
    })),
    ...row.webinarPlans.map((p) => ({ ...p, planType: "WEBINAR" as const })),
    ...row.classPlans.map((p) => ({ ...p, planType: "CLASS" as const })),
  ].slice(0, 6);
  // Flatten brandingProfile into the org shape so the rest of the page reads
  // org.logo / org.description / etc. directly (avoids touching ~12 read sites).
  return {
    ...row,
    organizationPlans,
    logo: row.brandingProfile?.logo ?? null,
    bannerImage: row.brandingProfile?.bannerImage ?? null,
    description: row.brandingProfile?.description ?? null,
    industry: row.brandingProfile?.industry ?? null,
    website: row.brandingProfile?.website ?? null,
    sizeBucket: row.brandingProfile?.sizeBucket ?? null,
    directoryType: row.brandingProfile?.directoryType ?? null,
  };
});

type OrgData = NonNullable<Awaited<ReturnType<typeof fetchOrgBySlug>>>;

// Plan family → its public detail page. This used to be a map to checkout
// segments, so an org buyer weighing a multi-month programme for their team
// went straight to payment with nothing to read. All four types now have a
// detail page, so the card links there and checkout is reached from it.
const PLAN_DETAIL_PATH: Record<
  OrgData["organizationPlans"][number]["planType"],
  string
> = {
  CONSULTATION: "consultations",
  SUBSCRIPTION: "subscriptions",
  WEBINAR: "webinars",
  CLASS: "classes",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}): Promise<Metadata> {
  const { orgSlug } = await params;
  // The fallback used to be a generic title on a transient timeout, which was
  // right while this route was dynamic. It is ISR now, so that degraded head
  // would be cached and replayed to everyone; a 500 that caches nothing is the
  // better trade. Left bare so it fails the same way the page body below does —
  // they share one `React.cache`d read per request (#1119).
  const org = await fetchOrgBySlug(orgSlug);
  if (!org) return { title: "Organisation not found" };
  return {
    title: `${org.name} — Familiarise`,
    description: org.description ?? `Expert network on Familiarise`,
  };
}

function ExpertMiniCard({
  expert,
}: {
  expert: NonNullable<OrgData["memberships"][number]["consultantProfile"]>;
}) {
  return (
    <Link
      href={`/explore/experts/${expert.id}`}
      className="flex items-center gap-3 p-4 bg-card rounded-xl border border-border hover:border-border hover:shadow-md transition-all group"
    >
      <div className="relative w-12 h-12 flex-shrink-0">
        <Image
          src={
            expert.user.profileDisplayImage ??
            expert.user.image ??
            "/placeholder-user.jpg"
          }
          alt={expert.user.name}
          fill
          className="rounded-xl object-cover"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="font-semibold text-sm text-foreground group-hover:text-muted-foreground truncate">
            {expert.user.name}
          </p>
          {expert.isVerified && (
            <BadgeCheck className="w-4 h-4 text-foreground flex-shrink-0" />
          )}
        </div>
        {expert.headline && (
          <p className="text-xs text-muted-foreground truncate">
            {expert.headline}
          </p>
        )}
        <div className="flex items-center gap-2 mt-0.5">
          <div className="flex items-center gap-0.5">
            <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
            <span className="text-xs font-medium text-muted-foreground">
              {expert.rating.toFixed(1)}
            </span>
          </div>
          {expert.domain && (
            <span className="text-xs text-muted-foreground/70">
              {expert.domain.name}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = await fetchOrgBySlug(orgSlug);

  if (!org) notFound();

  // Lead with what the org *is* rather than its billing capability — "Hybrid"
  // is internal vocabulary that means nothing to a visitor. Falls back to the
  // derived capability only while directoryType is unset.
  const capabilityLabel = org.directoryType
    ? ORG_DIRECTORY_TYPE_LABEL[org.directoryType]
    : org.canSponsor && org.canHost
      ? "Hybrid"
      : "Host Agency";
  // Neutral taxonomy, no dark: variants — monochrome (filled vs muted).
  const capabilityClass = org.directoryType
    ? "bg-primary text-primary-foreground border-transparent"
    : "bg-muted text-muted-foreground border-border";

  const exclusiveExperts = org.memberships
    .map((m) => m.consultantProfile)
    .filter(Boolean) as NonNullable<
    OrgData["memberships"][number]["consultantProfile"]
  >[];

  return (
    <main className="min-h-screen bg-muted">
      {/* Banner — decorative dark cover header */}
      <div className="relative h-48 md:h-64 bg-gradient-to-br from-zinc-800 to-zinc-900 overflow-hidden">
        {org.bannerImage && (
          <Image
            src={org.bannerImage}
            alt=""
            fill
            className="object-cover opacity-40"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-zinc-900/60" />
      </div>

      <div className="max-w-[1100px] mx-auto px-4 md:px-8">
        {/* Back link */}
        <div className="py-4">
          <Link
            href="/explore/enterprise/organisations"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            All Organisations
          </Link>
        </div>

        {/* Org header card */}
        <div className="bg-card rounded-2xl border border-border p-6 md:p-8 mb-8 -mt-16 relative shadow-sm">
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            {/* Logo */}
            <div className="w-20 h-20 rounded-2xl bg-muted border-2 border-card shadow-md flex items-center justify-center overflow-hidden flex-shrink-0">
              {org.logo ? (
                <Image
                  src={org.logo}
                  alt={org.name}
                  width={80}
                  height={80}
                  className="object-contain"
                />
              ) : (
                <Building2 className="w-10 h-10 text-muted-foreground/70" />
              )}
            </div>

            {/* Details */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <h1 className="text-fluid-3xl font-bold text-foreground tracking-tight">
                  {org.name}
                </h1>
                <Badge
                  variant="outline"
                  className={`text-xs ${capabilityClass}`}
                >
                  {capabilityLabel}
                </Badge>
              </div>

              {org.industry && (
                <p className="text-muted-foreground text-sm mb-3">
                  {org.industry}
                </p>
              )}

              {org.description && (
                <p className="text-muted-foreground leading-relaxed mb-4 max-w-2xl">
                  {org.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-4">
                {/* Only hosting orgs have an expert roster; a sponsor-only org
                    showing "0 exclusive experts" reads as a defect. */}
                {org.canHost && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Users className="w-4 h-4 text-muted-foreground/70" />
                    <span>
                      <strong>{exclusiveExperts.length}</strong> exclusive
                      expert{exclusiveExperts.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                )}
                {org.sizeBucket && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Building2 className="w-4 h-4 text-muted-foreground/70" />
                    <span>{ORG_SIZE_BUCKET_LABEL[org.sizeBucket]}</span>
                  </div>
                )}
                {org.website && (
                  <a
                    href={org.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-foreground hover:text-muted-foreground transition-colors"
                  >
                    <Globe className="w-4 h-4" />
                    Website
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-16">
          {/* Main: Expert roster */}
          <div className="lg:col-span-2 space-y-6">
            {exclusiveExperts.length > 0 ? (
              <>
                {/* The sidebar CTA targets #experts; nothing carried that id. */}
                <h2
                  id="experts"
                  className="scroll-mt-28 text-xl font-bold text-foreground tracking-tight"
                >
                  Exclusive Experts
                </h2>
                {/* Single column at every width: two-up halved the card and
                    truncated most headlines mid-word ("Executive Coa…"), which
                    is the one line that tells you what the expert actually
                    does. Full width lets them read. */}
                <div className="grid grid-cols-1 gap-3">
                  {exclusiveExperts.map((expert) => (
                    <ExpertMiniCard key={expert.id} expert={expert} />
                  ))}
                </div>
              </>
            ) : (
              org.canHost && (
                <div className="flex flex-col items-center justify-center py-16 text-center bg-card rounded-2xl border border-border">
                  <Users className="w-10 h-10 text-muted-foreground/70 mb-3" />
                  <p className="text-muted-foreground">
                    No exclusive experts listed yet
                  </p>
                </div>
              )
            )}
          </div>

          {/* Sidebar: Org plans */}
          <div className="space-y-6">
            {org.organizationPlans.length > 0 && (
              <div className="bg-card rounded-2xl border border-border p-5">
                <h2 className="text-base font-bold text-foreground mb-4 tracking-tight">
                  Available Programs
                </h2>
                <div className="space-y-3">
                  {org.organizationPlans.map((plan) => (
                    <Link
                      key={plan.id}
                      href={`/explore/programs/plans/${PLAN_DETAIL_PATH[plan.planType]}/${plan.id}`}
                      className="block p-3 rounded-xl bg-muted border border-border hover:border-border hover:bg-card hover:shadow-sm transition-all group"
                    >
                      <p className="text-sm font-semibold text-foreground mb-0.5">
                        {plan.title}
                      </p>
                      {/* Prefer the authored one-liner; fall back to the
                          long description, which reads badly when clamped. */}
                      {(plan.subtitle || plan.description) && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {plan.subtitle || plan.description}
                        </p>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 capitalize"
                        >
                          {plan.planType.toLowerCase()}
                        </Badge>
                        {plan.price > 0 && (
                          <span className="text-xs font-semibold text-muted-foreground">
                            ₹{(plan.price / 100).toLocaleString("en-IN")}
                          </span>
                        )}
                      </div>
                      <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-foreground group-hover:text-muted-foreground">
                        Book
                        <ArrowRight className="w-3 h-3" />
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* CTA — intentional dark surface. Now that sponsor-only orgs can
                be listed, an experts CTA only makes sense where a roster
                actually exists; otherwise point at the org's own site. */}
            <div className="bg-primary rounded-2xl p-5 text-center">
              <Building2 className="w-8 h-8 text-primary-foreground/70 mx-auto mb-3" />
              <p className="text-primary-foreground font-semibold text-sm mb-1">
                Work with {org.name}
              </p>
              {exclusiveExperts.length > 0 ? (
                <>
                  <p className="text-primary-foreground/70 text-xs mb-4">
                    Browse their experts and book a session directly.
                  </p>
                  <Button
                    asChild
                    className="w-full bg-card text-foreground hover:bg-muted font-medium rounded-xl"
                  >
                    <Link href="#experts">Browse Experts</Link>
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-primary-foreground/70 text-xs mb-4">
                    {org.name} is listed on Familiarise.
                  </p>
                  {org.website && (
                    <Button
                      asChild
                      className="w-full bg-card text-foreground hover:bg-muted font-medium rounded-xl"
                    >
                      <a
                        href={org.website}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Visit website
                      </a>
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
