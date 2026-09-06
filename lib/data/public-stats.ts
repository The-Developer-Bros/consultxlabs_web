/**
 * Derivation of the numbers shown on public marketing surfaces.
 *
 * Pure and dependency-free on purpose: every public page that wants to show a
 * figure goes through here, so "is this number real?" is one question with one
 * answer rather than a judgement made separately in each hero.
 *
 * The rule these builders enforce is that a number appears only when it is both
 * derived from data and large enough to mean something. Below that, the caller
 * renders early-stage copy with no number at all — never a padded placeholder.
 * The pages this replaced fell back to "10K+" experts, a "4.9" rating, "50K+"
 * and "25K+" whenever the real figures were zero, which is the entire
 * pre-launch state; fabricated social proof on a public page is a
 * misleading-advertisement exposure under the Consumer Protection Act 2019,
 * not a positioning choice. (#1485, #1490)
 */

/**
 * Minimum published reviews before a directory-wide average rating is a claim
 * anyone can stand behind rather than one person's anecdote.
 */
export const MIN_REVIEWS_FOR_PUBLIC_RATING = 5;

/** One consultant's publishable score and the reviews standing behind it. */
export interface IRatedProfile {
  publishedRating: number | null;
  reviewCount: number;
}

export interface IDirectoryRating {
  /** Mean over REVIEWS, not over consultants; 0 when none qualify. */
  averageRating: number;
  /** The reviews that actually fed that mean — the gate's denominator. */
  publishedReviewCount: number;
}

/**
 * The directory-wide "Average Rating" as a visitor reads that label: the mean
 * over published REVIEWS, `Σ(rating × reviewCount) / Σ(reviewCount)`, not the
 * mean over consultants.
 *
 * Weighting matters because the unweighted figure lets a five-review newcomer
 * outvote an expert with a hundred: A at 100×4.0 with B at 5×5.0 reads 4.5
 * unweighted and 4.05 weighted, and only the second is a number the platform
 * could defend. It is also the conservative one, and it counts exactly the
 * population the `MIN_REVIEWS_FOR_PUBLIC_RATING` gate counts, so the figure and
 * its threshold can no longer disagree about who they are describing.
 *
 * Prisma's `_avg` cannot express this, so both loaders fetch the gated rows and
 * call in here — the row set is the verified directory and both callers are
 * cached. Profiles below the #705 suppression threshold carry a NULL
 * `publishedRating` and are skipped, so their reviews neither move the mean nor
 * help clear the gate. Rounding happens at display only; the maths stays exact.
 */
export function deriveDirectoryRating(
  profiles: IRatedProfile[],
): IDirectoryRating {
  let weightedSum = 0;
  let reviews = 0;

  for (const profile of profiles) {
    if (profile.publishedRating === null || profile.reviewCount <= 0) continue;
    weightedSum += profile.publishedRating * profile.reviewCount;
    reviews += profile.reviewCount;
  }

  return {
    averageRating: reviews > 0 ? weightedSum / reviews : 0,
    publishedReviewCount: reviews,
  };
}

export interface IPublicStat<K extends string> {
  key: K;
  /** The raw figure, for callers that animate it (the landing counters). */
  value: number;
  /** The same figure pre-formatted, for callers that render it directly. */
  display: string;
  label: string;
}

export type ExpertStatKey = "experts" | "rating" | "sessions";
export type ProgramStatKey = "classes" | "webinars" | "learners";

export interface IExpertStatsInput {
  /** Verified, non-deleted consultant profiles. */
  totalConsultants: number;
  /** Review-weighted mean of the PUBLISHED scores; 0 when none qualify. */
  averageRating: number;
  /** Published reviews across the directory — the rating's denominator. */
  publishedReviewCount: number;
  /** Meetings actually held: COMPLETED slots, not appointments. */
  completedSessions: number;
}

export interface IProgramStatsInput {
  /** Class plans a visitor can actually find and buy. */
  publishedClassCount: number;
  /** Webinar plans a visitor can actually find and buy. */
  publishedWebinarCount: number;
  /** Distinct learners holding a confirmed or attended seat on an event. */
  enrolledLearnerCount: number;
}

/** `1234` → `"1,234"`, with the grouping this platform's audience reads. */
function formatCount(value: number): string {
  return value.toLocaleString("en-IN");
}

/**
 * Stats for the two expert-facing heroes (`/` and `/explore/experts`).
 *
 * An empty array is a correct and expected result before launch, and is what
 * both callers get today.
 */
export function buildExpertHeroStats(
  input: IExpertStatsInput,
): IPublicStat<ExpertStatKey>[] {
  const stats: IPublicStat<ExpertStatKey>[] = [];

  if (input.totalConsultants > 0) {
    stats.push({
      key: "experts",
      value: input.totalConsultants,
      display: formatCount(input.totalConsultants),
      label: input.totalConsultants === 1 ? "Active Expert" : "Active Experts",
    });
  }

  if (
    input.averageRating > 0 &&
    input.publishedReviewCount >= MIN_REVIEWS_FOR_PUBLIC_RATING
  ) {
    stats.push({
      key: "rating",
      value: input.averageRating,
      display: input.averageRating.toFixed(1),
      label: "Average Rating",
    });
  }

  if (input.completedSessions > 0) {
    stats.push({
      key: "sessions",
      value: input.completedSessions,
      display: formatCount(input.completedSessions),
      label:
        input.completedSessions === 1
          ? "Session Completed"
          : "Sessions Completed",
    });
  }

  return stats;
}

/**
 * Stats for the `/explore/programs` hero.
 *
 * The counts are of PUBLISHED plans, because a stat on a public page should
 * count the things that page can actually show you, and learners are counted as
 * distinct people rather than seats so that one person on four webinars is one
 * learner.
 */
export function buildProgramHeroStats(
  input: IProgramStatsInput,
): IPublicStat<ProgramStatKey>[] {
  const stats: IPublicStat<ProgramStatKey>[] = [];

  if (input.publishedClassCount > 0) {
    stats.push({
      key: "classes",
      value: input.publishedClassCount,
      display: formatCount(input.publishedClassCount),
      label:
        input.publishedClassCount === 1
          ? "Class Available"
          : "Classes Available",
    });
  }

  if (input.publishedWebinarCount > 0) {
    stats.push({
      key: "webinars",
      value: input.publishedWebinarCount,
      display: formatCount(input.publishedWebinarCount),
      label:
        input.publishedWebinarCount === 1 ? "Live Webinar" : "Live Webinars",
    });
  }

  if (input.enrolledLearnerCount > 0) {
    stats.push({
      key: "learners",
      value: input.enrolledLearnerCount,
      display: formatCount(input.enrolledLearnerCount),
      label:
        input.enrolledLearnerCount === 1
          ? "Learner Enrolled"
          : "Learners Enrolled",
    });
  }

  return stats;
}
