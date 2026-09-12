import type { Prisma, ReviewTrack } from "@prisma/client";
import type {
  publicReviewSelect,
  PublicReview,
} from "@/lib/data/review-public";

/**
 * A review row exactly as the public projection returns it, before sanitising.
 *
 * Derived from `publicReviewSelect` rather than restated, so adding a column to
 * the allowlist cannot leave the type behind — and, more importantly, so a column
 * NOT on the allowlist cannot be referenced by a component that then compiles.
 */
export type TConsultantReview = Prisma.ConsultantReviewGetPayload<{
  select: typeof publicReviewSelect;
}>;

/**
 * What a PUBLIC surface actually receives: anonymity applied and a
 * moderation-removed reply dropped. Components must handle the reviewer being
 * absent rather than be typed as though they are always there.
 */
export type TPublicConsultantReview = PublicReview<TConsultantReview>;

/**
 * Which tracks a consultant has at least one live review in. Answered by its own
 * query, never derived from a paginated review list: a GROUP review past the
 * page would otherwise hide the whole track.
 */
export type TReviewTrackPresence = Record<ReviewTrack, boolean>;
