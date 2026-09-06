import { unstable_cache } from "next/cache";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import type { IConsultantCardData } from "@/types/consultant";
import { deriveDirectoryRating } from "@/lib/data/public-stats";

/**
 * Server-side data access for the explore experts page.
 *
 * Exports two flavors of each function:
 *  - Raw (e.g. fetchExpertsMetadata) — pure Prisma, no cache. Used by API routes.
 *  - Cached (e.g. getExpertsMetadata) — unstable_cache wrapper (cross-request Next
 *    data cache, #932). Used by Server Components.
 */

/**
 * Shared include shape for consultant list queries.
 *
 * Typed via `satisfies Prisma.ConsultantProfileInclude` so Prisma's
 * generated types validate the shape at compile time — the returned
 * rows are then automatically narrow-typed with all the nested relations
 * (user, domain, subDomains, tags, reviews, subscriptionPlans) without
 * requiring `as const` or runtime narrowing at the caller.
 */
export const consultantListInclude = {
  user: {
    select: {
      id: true,
      name: true,
      image: true,
      profileDisplayImage: true,
      workExperiences: {
        select: { company: true, companyDomain: true, isCurrent: true },
        take: 3,
      },
    },
  },
  domain: { select: { id: true, name: true } },
  subDomains: { select: { id: true, name: true } },
  tags: { select: { id: true, name: true } },
  reviews: { where: { deletedAt: null }, select: { rating: true }, take: 10 },
  subscriptionPlans: {
    select: {
      id: true,
      title: true,
      price: true,
      priceCurrency: true,
      durationInMonths: true,
      sessionsPerWeek: true,
      emailSupport: true,
      totalSessions: true,
      // Drive the card's Trial CTA from real data instead of showing it
      // unconditionally — a plan with no trial had a button that dead-ended.
      trialEnabled: true,
      trialPriceInPaise: true,
    },
    take: 5,
  },
} satisfies Prisma.ConsultantProfileInclude;

// Separate include for org membership.
//
// Arch 4-Modified shape: a consultant belongs to an org via `Membership`
// (relation name "ConsultantMembership"). "Consultant" in the org context
// is `MemberRole.EXPERT`, and a hosting org is `Organization.canHost=true`.
//
// Typed via `satisfies` so Prisma's generated include types validate the
// filter at compile time (no `as const` string-literal narrowing needed).
export const orgMembershipInclude = {
  memberships: {
    where: {
      role: "EXPERT",
      status: "ACTIVE",
      organization: {
        canHost: true,
        status: "ACTIVE",
        // The badge deep-links to /explore/enterprise/organisations/{slug},
        // which only serves opted-in, non-deleted orgs — without these the card
        // rendered a link straight to a 404. #781 §B soft-deletes orgs rather
        // than removing them, so ACTIVE alone doesn't exclude them.
        isPublic: true,
        deletedAt: null,
      },
    },
    orderBy: { createdAt: "asc" },
    select: {
      organization: {
        select: {
          name: true,
          slug: true,
          brandingProfile: { select: { logo: true } },
        },
      },
    },
    take: 1,
  },
} satisfies Prisma.ConsultantProfileInclude;

// Merged include for the public card-shaped reads (explore list route + curated
// rows). Returning the raw row would carry the consultant's statutory PII scalars
// (panNumber, ibanOrAccount, swiftBic, TDS/residency/MSME, ...) — so EVERY caller
// must project through `toConsultantCard`, never spread the row. (#945)
export const consultantCardInclude = {
  ...consultantListInclude,
  ...orgMembershipInclude,
} satisfies Prisma.ConsultantProfileInclude;

// Derived from the EXTENDED prisma delegate via Prisma.Result, NOT a vanilla
// GetPayload: the money result-extension (lib/prisma.ts) changes the payload type,
// so GetPayload wouldn't match what the extended findMany actually returns.
type ConsultantCardRow = Prisma.Result<
  typeof prisma.consultantProfile,
  { include: typeof consultantCardInclude },
  "findMany"
>[number];

/**
 * Project a consultant row to the PUBLIC card shape. This is an explicit
 * allowlist on purpose: the row carries India statutory PII (PAN, bank/SWIFT,
 * TDS, residency, MSME) that must NEVER reach a public response or the
 * Server→Client boundary. Add a field here only if a card actually renders it.
 */
export function toConsultantCard(row: ConsultantCardRow): IConsultantCardData {
  const { memberships, ...c } = row;
  const firstOrg = memberships[0]?.organization ?? null;
  return {
    id: c.id,
    // #705 — the suppressed-below-threshold score, never the raw mean. Null
    // renders as "not enough reviews yet" rather than a number one client can
    // define.
    rating: c.publishedRating,
    reviewCount: c.reviewCount,
    headline: c.headline,
    experience: c.experience,
    description: c.description,
    createdAt: c.createdAt,
    isVerified: c.isVerified,
    languages: c.languages,
    user: c.user,
    domain: c.domain,
    subDomains: c.subDomains,
    tags: c.tags,
    reviews: c.reviews,
    subscriptionPlans: c.subscriptionPlans.map((p) => ({
      id: p.id,
      title: p.title,
      // BigInt (paise) → Number for serialization; fits Number.MAX_SAFE_INTEGER.
      price: Number(p.price),
      priceCurrency: p.priceCurrency,
      durationInMonths: p.durationInMonths,
      sessionsPerWeek: p.sessionsPerWeek,
      emailSupport: p.emailSupport,
      totalSessions: p.totalSessions,
      trialEnabled: p.trialEnabled,
      // BigInt (paise) → Number, same as `price` above.
      trialPriceInPaise: Number(p.trialPriceInPaise),
    })),
    organizationBadge: firstOrg
      ? {
          name: firstOrg.name,
          slug: firstOrg.slug,
          logo: firstOrg.brandingProfile?.logo ?? null,
        }
      : null,
  };
}

// Shared sort → orderBy for the consultants list (the API route + the cached
// default page below). Unknown/absent sort falls back to name A→Z.
export function orderByForSort(
  sort: string,
): Prisma.ConsultantProfileOrderByWithRelationInput {
  switch (sort) {
    case "nameDesc":
      return { user: { name: "desc" } };
    case "reviewCount":
    case "trending":
      // #705 — the denormalized count, which excludes soft-deleted reviews.
      // `{ reviews: { _count: "desc" } }` counted them: Prisma cannot filter a
      // relation _count inside orderBy, so a moderated-away review kept
      // pushing its consultant up the trending list.
      return { reviewCount: "desc" };
    case "rating":
      // The PUBLISHED score, nulls last. Sorting on the raw mean let a 5.0 from
      // a single session outrank a 4.8 from two hundred.
      return { publishedRating: { sort: "desc", nulls: "last" } };
    case "newest":
      return { createdAt: "desc" };
    case "nameAsc":
    default:
      return { user: { name: "asc" } };
  }
}

// ---------------------------------------------------------------------------
// Experts metadata (filters, domain grid, language list)
// ---------------------------------------------------------------------------

/** Raw function — importable by API routes (no React.cache). */
export async function fetchExpertsMetadata() {
  const [
    domainsWithSubs,
    tags,
    consultantMetadata,
    availableLanguages,
    availableCompanies,
  ] = await Promise.all([
    // Domains + subdomains
    prisma.domain.findMany({
      include: {
        subDomains: {
          select: { id: true, name: true, domainId: true },
        },
      },
    }),
    // Tags
    prisma.tag.findMany({
      select: { id: true, name: true, domainId: true },
    }),
    // Consultant metadata (counts, domain breakdown, avg rating, sessions)
    // #781 §B — soft-deleted profiles leave public surfaces
    (async () => {
      const [
        totalConsultants,
        consultantsByDomain,
        ratedProfiles,
        completedSessions,
      ] = await Promise.all([
        prisma.consultantProfile.count({
          where: { verificationStatus: "VERIFIED", deletedAt: null },
        }),
        prisma.domain.findMany({
          select: {
            id: true,
            name: true,
            _count: {
              select: {
                consultantProfiles: {
                  where: { verificationStatus: "VERIFIED", deletedAt: null },
                },
              },
            },
          },
        }),
        // #1485 — the PUBLISHED score, not the raw `rating` mean. `rating`
        // defaults to 0 and every unreviewed profile carries that default, so
        // averaging it across the directory was not a number anyone could
        // defend. `publishedRating` is NULL below the #705 suppression
        // threshold, so filtering it out leaves only publishable scores. The
        // rows are weighted by review in `deriveDirectoryRating` rather than
        // by `_avg`, which cannot express a weighted mean.
        prisma.consultantProfile.findMany({
          where: {
            verificationStatus: "VERIFIED",
            deletedAt: null,
            publishedRating: { not: null },
          },
          select: { publishedRating: true, reviewCount: true },
        }),
        // #1485 — the real "sessions completed" figure, replacing a hardcoded
        // "50K+". The unit is the SLOT, not the appointment: a slot is one
        // meeting, and COMPLETED means it was actually held (a MeetingSession
        // ended, or a consultant marked it). `Appointment` carries no status
        // of its own, and a subscription appointment spans many meetings.
        // UNVERIFIED (past, no meeting record) is deliberately excluded — it
        // may well have happened offline, but "may have" is not a claim.
        prisma.slotOfAppointment.count({
          where: { completionStatus: "COMPLETED", deletedAt: null },
        }),
      ]);

      return {
        totalConsultants,
        consultantsByDomain: consultantsByDomain.map((d) => ({
          id: d.id,
          name: d.name,
          consultantCount: d._count.consultantProfiles,
        })),
        ...deriveDirectoryRating(ratedProfiles),
        completedSessions,
      };
    })(),
    // Available languages — distinct across verified consultants. ORM read + JS
    // dedupe (no raw SQL): pull the verified profiles' `languages` arrays and
    // flatten/unique/sort in app code. The verified-consultant set is small enough
    // that this is cheaper than it looks and avoids a Postgres `unnest`.
    prisma.consultantProfile
      .findMany({
        where: { verificationStatus: "VERIFIED", deletedAt: null },
        select: { languages: true },
      })
      .then((rows) =>
        Array.from(new Set(rows.flatMap((r) => r.languages)))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b)),
      ),
    // Available companies (from verified consultants' work experiences)
    prisma.workExperience
      .findMany({
        where: {
          company: { not: "" },
          user: {
            consultantProfile: {
              verificationStatus: "VERIFIED",
              deletedAt: null,
            },
          },
        },
        select: { company: true },
        distinct: ["company"],
        orderBy: { company: "asc" },
      })
      .then((result) => result.map((r) => r.company)),
  ]);

  return {
    domains: domainsWithSubs.map((d) => ({ id: d.id, name: d.name })),
    subdomains: domainsWithSubs.flatMap((d) =>
      d.subDomains.map((sd) => ({
        id: sd.id,
        name: sd.name,
        domainId: sd.domainId,
      })),
    ),
    tags,
    consultantMetadata,
    availableLanguages,
    availableCompanies,
  };
}

// Cross-request cached wrapper for Server Components: the filter metadata
// (domains, tags, counts) changes slowly, so serve it from the Next data cache
// rather than opening a cross-region pooled connection per request (#932).
export const getExpertsMetadata = unstable_cache(
  fetchExpertsMetadata,
  ["experts-metadata"],
  { revalidate: 300, tags: ["experts"] },
);

export type ExpertsMetadata = Awaited<ReturnType<typeof fetchExpertsMetadata>>;

// ---------------------------------------------------------------------------
// Curated experts (Featured / Trending / Newest rows)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recent reviews (for testimonial sections)
// ---------------------------------------------------------------------------

// `limit` must be an explicit arg of the cached fn (not a default) — unstable_cache
// keys on the args passed, so getRecentReviews() and getRecentReviews(6) would
// otherwise create two entries for the same data. The default lives on the wrapper.
const getCachedRecentReviews = unstable_cache(
  async (limit: number) => {
    return prisma.consultantReview.findMany({
      // #781 §B — soft-deleted profiles leave public surfaces
      // #693 — moderation-removed reviews leave public surfaces too
      where: {
        rating: { gte: 4 },
        deletedAt: null,
        consultantProfile: { deletedAt: null },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        consultantProfile: {
          include: {
            user: { select: { name: true } },
          },
        },
        consulteeProfile: {
          include: {
            user: { select: { name: true, image: true } },
          },
        },
      },
    });
  },
  ["recent-reviews"],
  { revalidate: 120, tags: ["reviews"] },
);

/** Recent high-quality reviews for social-proof sections (public landing). Cached
 *  cross-request — testimonials change slowly and staleness is invisible. (#932) */
export const getRecentReviews = (limit: number = 6) =>
  getCachedRecentReviews(limit);

// ---------------------------------------------------------------------------
// Curated experts (Featured / Trending / Newest rows)
// ---------------------------------------------------------------------------

// Cross-request cached: each (sort, limit) pair is keyed separately by
// unstable_cache, so the three curated rows share one cache entry apiece instead
// of re-querying the pooler on every explore load (#932).
//
// 300 to match /explore/experts' route-level revalidate rather than undercut it:
// Next takes the minimum of the segment interval and every data cache entry read
// during the render, so the old 120 was silently capping that page's ISR window.
export const getCuratedExperts = unstable_cache(
  async (sort: "rating" | "trending" | "newest", limit: number = 8) => {
    const rows = await prisma.consultantProfile.findMany({
      // #781 §B — soft-deleted profiles leave public surfaces
      where: { verificationStatus: "VERIFIED", deletedAt: null },
      orderBy: orderByForSort(sort),
      take: limit,
      include: consultantCardInclude,
    });
    // Project through the allowlist — never spread the row (statutory PII +
    // non-serializable Decimals must not cross the Server→Client boundary).
    return rows.map(toConsultantCard);
  },
  ["curated-experts"],
  { revalidate: 300, tags: ["experts"] },
);

// Cached default consultants page — the explore landing's most common read
// (unfiltered, verified, page 1). Keyed per (sort, limit) so the handful of
// default sort/limit combos each get one short-lived entry, served from the Next
// data cache instead of opening a cross-region pooled connection on every load.
// Tagged "experts" (same as getCuratedExperts) so it is cleared by the
// revalidateTag("experts") that consultant verify/edit/delete now fires via
// purgeExpertSurfaces (lib/data/public-cache.ts); the 60s revalidate is the
// backstop. (#945 — pairs with the route's no-store fail-open; #932 caching.)
export const getDefaultConsultantsPage = unstable_cache(
  async (sort: string, limit: number) => {
    const where: Prisma.ConsultantProfileWhereInput = {
      verificationStatus: "VERIFIED",
      deletedAt: null,
    };
    const [rows, total] = await Promise.all([
      prisma.consultantProfile.findMany({
        where,
        orderBy: orderByForSort(sort),
        take: limit,
        include: consultantCardInclude,
      }),
      prisma.consultantProfile.count({ where }),
    ]);
    return {
      data: rows.map(toConsultantCard),
      meta: { total, page: 1, limit, totalPages: Math.ceil(total / limit) },
    };
  },
  ["default-consultants-page"],
  { revalidate: 60, tags: ["experts"] },
);
