import { Prisma } from "@prisma/client";
import type { ConsultantPublicScalars } from "@/lib/data/consultant-public";
import type { SanitisedReview } from "@/lib/data/review-privacy";

/**
 * Review with both consultant and consultee profile data.
 * Matches the include pattern in GET /api/user/reviews.
 * Used by home page testimonials and upcoming events sections.
 * The consultantProfile is projected to the public allowlist (no statutory PII). (#946)
 */
export type TConsultantReview = Prisma.ConsultantReviewGetPayload<{
  include: {
    consultantProfile: {
      select: ConsultantPublicScalars & {
        user: {
          select: {
            name: true;
          };
        };
      };
    };
    consulteeProfile: {
      include: {
        user: {
          select: {
            name: true;
            image: true;
          };
        };
      };
    };
  };
}>;

/**
 * What a PUBLIC surface actually receives. Every public read runs its rows
 * through `stripAnonymousReviewer`, which nulls the reviewer's profile and the
 * two ids that identify them, so a component rendering these must handle the
 * absence rather than be typed as though the reviewer is always there.
 */
export type TPublicConsultantReview = SanitisedReview<TConsultantReview>;

/** @deprecated Use TPublicConsultantReview instead */
export type ReviewWithProfiles = TPublicConsultantReview;
