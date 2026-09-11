/**
 * #1300 — the pure display side of the two published scores.
 *
 * Deliberately its OWN module, importing nothing but a type. `lib/reviews.ts`
 * imports the Prisma client, and a client component that reaches for a helper
 * there pulls `@prisma/adapter-pg` → `pg` → `fs` into the browser bundle and the
 * Next build fails with "Module not found: Can't resolve 'fs'". `tsc` cannot see
 * that — it is a bundling boundary, not a type error — so the only thing that
 * catches it is a full build.
 *
 * `import type` is erased at compile time, so the `ReviewTrack` import costs
 * nothing at runtime.
 */
import type { Prisma, ReviewTrack } from "@prisma/client";

/**
 * The ONE score a single-slot surface should show — a card, a directory row.
 *
 * The surface asks for the track that matches what it is selling: a person card
 * prefers 1:1, a webinar or class card prefers group. Falling back to the other
 * track is allowed — a consultant who only runs webinars has an earned score —
 * but a fallback is `fellBack: true` and MUST be labelled (`trackLabel`), or a
 * group product silently wears a 1:1 reputation, the inference the split exists
 * to prevent.
 *
 * NULL means SUPPRESSED, and every caller must render that as "not enough rated
 * sessions yet" rather than as 0.0.
 */
export function displayedScore(
  profile: {
    publishedRatingOneToOne: number | null;
    publishedRatingGroup: number | null;
  },
  prefer: ReviewTrack = "ONE_TO_ONE",
): { score: number | null; track: ReviewTrack | null; fellBack: boolean } {
  const first =
    prefer === "GROUP"
      ? ([profile.publishedRatingGroup, "GROUP"] as const)
      : ([profile.publishedRatingOneToOne, "ONE_TO_ONE"] as const);
  const second =
    prefer === "GROUP"
      ? ([profile.publishedRatingOneToOne, "ONE_TO_ONE"] as const)
      : ([profile.publishedRatingGroup, "GROUP"] as const);
  if (first[0] !== null) {
    return { score: first[0], track: first[1], fellBack: false };
  }
  if (second[0] !== null) {
    return { score: second[0], track: second[1], fellBack: true };
  }
  return { score: null, track: null, fellBack: false };
}

/** The short label a card shows beside a score that came from the OTHER track. */
export function trackLabel(track: ReviewTrack | null): string | null {
  if (track === "GROUP") return "group sessions";
  if (track === "ONE_TO_ONE") return "1:1 sessions";
  return null;
}

/**
 * The Prisma `orderBy` for "best rated" on a person-level list: the 1:1 score
 * first, then the group score for consultants who have only that. Both indexed.
 * Matches `displayedScore(profile, "ONE_TO_ONE")`, so the sort and the star agree.
 */
export const PERSON_SCORE_ORDER: Prisma.ConsultantProfileOrderByWithRelationInput[] =
  [
    { publishedRatingOneToOne: { sort: "desc", nulls: "last" } },
    { publishedRatingGroup: { sort: "desc", nulls: "last" } },
  ];

/**
 * The Prisma `where` for "displayed score ≥ min" on a person-level list: the 1:1
 * score when there is one, else the group score. Same policy as the star.
 */
export function personScoreAtLeast(
  min: number,
): Prisma.ConsultantProfileWhereInput {
  return {
    OR: [
      { publishedRatingOneToOne: { gte: min } },
      { publishedRatingOneToOne: null, publishedRatingGroup: { gte: min } },
    ],
  };
}

/** How many data points a displayed score rests on — "based on N". */
export function displayedScoreCount(
  profile: { ratedClientsOneToOne: number; ratedEventsGroup: number },
  track: ReviewTrack | null,
): number {
  if (track === "GROUP") return profile.ratedEventsGroup;
  if (track === "ONE_TO_ONE") return profile.ratedClientsOneToOne;
  return 0;
}
