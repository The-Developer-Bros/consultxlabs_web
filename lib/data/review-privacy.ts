/**
 * #705 — anonymity has to hold at the API boundary, not in the component.
 *
 * `isAnonymous` is a display choice the reviewer made; stripping the name only
 * where it is rendered would still ship it in the payload, and a public review
 * feed is exactly the thing people read with devtools open. Every public read
 * passes its rows through here, so there is one place to get it right.
 *
 * Authenticity is unaffected — the review is welded to a paid, attended session
 * either way, which is what separates this from the anonymous public reviews
 * Google stepped away from.
 */

/** The shape every public review read shares. */
interface AnonymisableReview {
  isAnonymous: boolean;
  consulteeProfile?: unknown;
  /**
   * The FK Prisma returns for EVERY row unless a `select` leaves it out. The
   * public reads all use a bare top-level `include:`, so nulling only the
   * nested relation left this scalar in the payload — and it is the join key.
   */
  consulteeProfileId?: string;
  /**
   * Provenance. Harmless to a stranger, decisive to the reviewed consultant:
   * they know their own appointment ids, so this names the reviewer to the one
   * party the flag exists to withhold them from.
   */
  appointmentId?: string | null;
}

/**
 * What a sanitised row actually is. The old signature returned `T`, which was a
 * lie: the anonymous branch sets `consulteeProfile` to null, so a caller whose
 * `T` declares that relation non-nullable — `consultant-detail.ts` includes it
 * with `user` — was handed a type promising a profile that is not there, and
 * `review.consulteeProfile.user.name` type-checked its way to a runtime crash.
 * Widening it makes the null explicit and forces every reader to handle it.
 */
export type SanitisedReview<T extends AnonymisableReview> = Omit<
  T,
  "consulteeProfile" | "consulteeProfileId" | "appointmentId"
> & {
  consulteeProfile: T["consulteeProfile"] | null;
  consulteeProfileId: T["consulteeProfileId"] | null;
  appointmentId: T["appointmentId"] | null;
};

export function stripAnonymousReviewer<T extends AnonymisableReview>(
  review: T,
): SanitisedReview<T> {
  // Gate on the FLAG only. The old `|| !review.consulteeProfile` short-circuit
  // meant a row whose relation was not included skipped the strip entirely and
  // shipped its identifying scalars.
  if (!review.isAnonymous) return review as SanitisedReview<T>;
  // The WHOLE profile goes, not just the name and avatar. Leaving
  // `consulteeProfile.id` behind was a de-anonymisation vector: the same person
  // reviewing one expert under their name and another anonymously shipped the
  // SAME profile id in both public payloads, so the two could be joined and the
  // anonymous one attributed. An opaque id is only opaque until it appears
  // twice.
  return {
    ...review,
    consulteeProfile: null,
    consulteeProfileId: null,
    appointmentId: null,
  };
}

export function stripAnonymousReviewers<T extends AnonymisableReview>(
  reviews: T[],
): SanitisedReview<T>[] {
  return reviews.map(stripAnonymousReviewer);
}
