import { cache } from "react";
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import { stripAnonymousReviewers } from "@/lib/data/review-privacy";
import { consultantPublicScalars } from "@/lib/data/consultant-public";

/**
 * Server-side data access for the expert detail page.
 * Uses the public access pattern (verified only, public user fields).
 */

export const getConsultantDetail = cache(async (consultantId: string) => {
  // Public expert detail page — explicit allowlist `select` instead of bare
  // `include` so we (a) never leak India statutory PII (panNumber, tdsRate,
  // ibanOrAccount, swiftBic, residencyStatus, etc.) onto a public route, and
  // (b) avoid the "Decimal cannot be passed to Client Components" runtime
  // error from `tdsRate: Decimal?` (added by the enterprise compliance
  // scaffolds). Add new fields here only if the public profile actually
  // renders them. Surfaced during May 2026 enterprise readiness audit.
  const consultant = await prisma.consultantProfile.findUnique({
    where: {
      id: consultantId,
      verificationStatus: "VERIFIED",
      // #781 §B — soft-deleted profiles leave public surfaces (treated as not-found)
      deletedAt: null,
    },
    select: {
      id: true,
      description: true,
      experience: true,
      rating: true,
      // #705 — the published score and the count behind it. `rating` above is
      // the RAW mean and stays internal; the profile shows this one.
      publishedRating: true,
      reviewCount: true,
      headline: true,
      websiteUrl: true,
      twitterUrl: true,
      githubUrl: true,
      videoIntroUrl: true,
      languages: true,
      toolsAndTechnologies: true,
      mentoringStyle: true,
      sessionTypes: true,
      profileCompletionPercentage: true,
      isVerified: true,
      verificationStatus: true,
      totalMenteesHelped: true,
      domainId: true,
      scheduleType: true,
      userId: true,
      isIndependent: true,
      createdAt: true,
      updatedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          image: true,
          profileDisplayImage: true,
          bio: true,
          city: true,
          country: true,
          linkedinUrl: true,
          timezone: true,
          workExperiences: {
            orderBy: [
              { isCurrent: "desc" as const },
              { startDate: "desc" as const },
            ],
          },
          education: {
            orderBy: { endYear: "desc" as const },
          },
          certifications: {
            orderBy: { issueDate: "desc" as const },
          },
        },
      },
      domain: true,
      subDomains: true,
      tags: true,
      slotsOfAvailabilityWeekly: true,
      slotsOfAvailabilityCustom: true,
      consultationPlans: true,
      subscriptionPlans: {
        include: {
          subscriptionContents: {
            orderBy: { order: "asc" as const },
          },
        },
      },
      webinarPlans: true,
      classPlans: true,
    },
  });
  if (!consultant) return null;

  // The Prisma client extension at lib/prisma.ts:121-124 converts BigInt
  // `price` → Number for all four plan models. But the rows returned by
  // the extended client are Proxy-wrapped; Next.js's RSC serializer
  // flags them as "objects with symbol properties (nodejs.util.inspect.custom)".
  // JSON round-trip strips every non-serializable artifact (Proxies,
  // symbols, methods) and yields true plain objects. Dates become ISO
  // strings — downstream client components already format them via
  // formatInTimeZone / date-fns, so this is safe here.
  try {
    return JSON.parse(JSON.stringify(consultant)) as typeof consultant;
  } catch (error) {
    // A throw here means the row picked up something non-JSON-safe (a
    // serialization regression, not a missing/empty result) — the public
    // detail page would otherwise 500 with no trace of why.
    reportSentryError(error, { subsystem: "consultant" });
    throw error;
  }
});

export const getConsultantReviews = cache(
  async (consultantProfileId: string) => {
    const reviews = await prisma.consultantReview.findMany({
      // #693 — moderation-removed reviews stay hidden from the public page
      where: { consultantProfileId, deletedAt: null },
      take: 20,
      include: {
        consultantProfile: {
          select: {
            ...consultantPublicScalars,
            user: { select: { name: true } },
          },
        },
        consulteeProfile: {
          include: { user: { select: { name: true, image: true } } },
        },
      },
      orderBy: { rating: "desc" },
    });
    // The reviewer chose to be unnamed; that has to hold in the payload.
    return stripAnonymousReviewers(reviews);
  },
);
