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
import type { ReviewTrack } from "@prisma/client";

/**
 * The ONE score a single-slot surface should show — a card, a directory row.
 *
 * Two published numbers do not fit in one star, so the surface has to choose, and
 * the honest choice is the track that matches what it is selling: a person card
 * prefers their 1:1 reputation, a webinar or class card prefers the group one.
 * Falling back to the other track is deliberate — a consultant who only ever runs
 * webinars has a real, earned score, and hiding it because the card happens to be
 * a person card would be worse than labelling it.
 *
 * NULL means SUPPRESSED, and every caller must render that as "not enough rated
 * sessions yet" rather than as 0.0. That is the whole reason the raw mean is no
 * longer in the public allowlist.
 */
export function displayedScore(
  profile: {
    publishedRatingOneToOne: number | null;
    publishedRatingGroup: number | null;
  },
  prefer: ReviewTrack = "ONE_TO_ONE",
): { score: number | null; track: ReviewTrack | null } {
  const first =
    prefer === "GROUP"
      ? ([profile.publishedRatingGroup, "GROUP"] as const)
      : ([profile.publishedRatingOneToOne, "ONE_TO_ONE"] as const);
  const second =
    prefer === "GROUP"
      ? ([profile.publishedRatingOneToOne, "ONE_TO_ONE"] as const)
      : ([profile.publishedRatingGroup, "GROUP"] as const);
  if (first[0] !== null) return { score: first[0], track: first[1] };
  if (second[0] !== null) return { score: second[0], track: second[1] };
  return { score: null, track: null };
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
