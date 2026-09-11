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
 * The ONE score a single-slot surface shows — a card, a directory row, a header.
 *
 * The surface names the track it sells: a person surface shows the 1:1 score, a
 * webinar or class card shows the group score. There is NO fallback to the other
 * track (#1566): a group product must never wear a 1:1 reputation, and a person
 * card shows nothing until that person's 1:1 score publishes. The profile's
 * reviews section lists both tracks, which is where a group-only consultant's
 * score is visible.
 *
 * NULL means SUPPRESSED, and every caller must render that as "not enough rated
 * sessions yet" rather than as 0.0.
 */
export function displayedScore(
  profile: {
    publishedRatingOneToOne: number | null;
    publishedRatingGroup: number | null;
  },
  track: ReviewTrack = "ONE_TO_ONE",
): { score: number | null; track: ReviewTrack } {
  return {
    score:
      track === "GROUP"
        ? profile.publishedRatingGroup
        : profile.publishedRatingOneToOne,
    track,
  };
}

/** The Prisma `orderBy` for "best rated" on a person-level list: the 1:1 score,
 *  nulls last, exactly what the card shows. */
export const PERSON_SCORE_ORDER: Prisma.ConsultantProfileOrderByWithRelationInput[] =
  [{ publishedRatingOneToOne: { sort: "desc", nulls: "last" } }];

/** The Prisma `where` for "displayed score ≥ min" on a person-level list. */
export function personScoreAtLeast(
  min: number,
): Prisma.ConsultantProfileWhereInput {
  return { publishedRatingOneToOne: { gte: min } };
}

/** How many data points a displayed score rests on — "based on N". */
export function displayedScoreCount(
  profile: { ratedClientsOneToOne: number; ratedEventsGroup: number },
  track: ReviewTrack,
): number {
  return track === "GROUP"
    ? profile.ratedEventsGroup
    : profile.ratedClientsOneToOne;
}
