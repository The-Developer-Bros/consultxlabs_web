/**
 * #1300 — the one projection every PUBLIC review read uses, and the one
 * sanitiser it runs through.
 *
 * The reads used a bare top-level `include:`, which on a root model returns
 * every scalar. That was already leaking the reviewer's private profile —
 * `aboutMe`, `goals`, `careerStage`, `skillsToDevelop`, `budgetPreference`,
 * `billingStateCode` — into the landing page's RSC payload for every named
 * reviewer, because the nested `consulteeProfile` include had the same shape.
 * 124 of 142 consultee profiles have `goals` filled in.
 *
 * It also made every future column public by default, which is how a
 * staff-internal `excludedReason` would have shipped to anonymous callers the
 * moment it was added. An allowlist inverts that: a new column is private until
 * somebody names it here, in a diff a reviewer reads.
 *
 * Same pattern and the same reasoning as `consultantPublicScalars` (#946).
 */
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import {
  stripAnonymousReviewer,
  type SanitisedReview,
} from "@/lib/data/review-privacy";

/**
 * Everything a public review surface is allowed to see.
 *
 * Deliberately absent: `consulteeProfileId` (an enumerable id nothing renders),
 * `revisionNo`, `ratedSessionAt`, `ratingCause`, `excludedFromAggregateAt`,
 * `excludedReason`, `excludedByUserId` (staff moderation material), and
 * `updatedAt` (which moves when the consultant replies, so it cannot be read as
 * "the review changed" — that is what `editedAt` is for).
 */
export const publicReviewSelect = {
  id: true,
  rating: true,
  reviewDescription: true,
  createdAt: true,
  /** NULL = never edited. BIS IS 19000:2022 asks that an edit be indicated. */
  editedAt: true,
  isAnonymous: true,
  consultantProfileId: true,
  /** Provenance for a "verified booking" badge. Stripped for anonymous rows,
   *  where it names the reviewer to the consultant who knows their own ids. */
  appointmentId: true,
  /** Which reputation this belongs to, so a card can say "group session". */
  track: true,
  /** The event key. Stripped for anonymous rows — `class:<id>` narrows the
   *  author to one run's roster. */
  ratingUnitId: true,
  /** The consultant's right of reply. `replyDeletedAt` is selected only so the
   *  sanitiser can act on it; it never reaches a component. */
  replyBody: true,
  repliedAt: true,
  replyDeletedAt: true,
  consultantProfile: {
    select: {
      ...consultantPublicScalars,
      user: { select: { name: true } },
    },
  },
  consulteeProfile: {
    // Only what a review card renders. NOT the profile row: that is where the
    // reviewer's career goals live.
    select: { user: { select: { name: true, image: true } } },
  },
} as const;

/** A review as a public surface receives it. */
export type PublicReview<T extends PublicReviewShape> = Omit<
  SanitisedReview<T>,
  "replyDeletedAt"
>;

interface PublicReviewShape {
  isAnonymous: boolean;
  replyBody?: string | null;
  repliedAt?: Date | null;
  replyDeletedAt?: Date | null;
}

/**
 * Strip the reviewer where they asked to be anonymous, and drop a reply staff
 * have removed.
 *
 * The second half is not hypothetical waiting to happen: `replyDeletedAt` exists
 * precisely so an abusive reply can be taken down without erasing the consumer
 * review underneath it, and every public read returned `replyBody` regardless.
 * The column was unreachable only because nothing wrote a reply at all.
 */
export function sanitisePublicReview<T extends PublicReviewShape>(
  review: T,
): PublicReview<T> {
  const stripped = stripAnonymousReviewer(review);
  const { replyDeletedAt, ...rest } = stripped as SanitisedReview<T> & {
    replyDeletedAt?: Date | null;
  };
  if (!replyDeletedAt) return rest as PublicReview<T>;
  return { ...rest, replyBody: null, repliedAt: null } as PublicReview<T>;
}

export function sanitisePublicReviews<T extends PublicReviewShape>(
  reviews: T[],
): PublicReview<T>[] {
  return reviews.map(sanitisePublicReview);
}
