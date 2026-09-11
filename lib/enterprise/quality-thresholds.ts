/**
 * #1300 — how small a cohort may be before an organisation stops being shown its
 * members' satisfaction.
 *
 * ADR 20 draws the line at metadata versus content, and a member's rating of a
 * session is content. An aggregate is the exception that makes an organisation's
 * quality question answerable at all — so the aggregate has to actually be
 * anonymous, which is a numeric claim rather than a vibe.
 *
 * These are Microsoft Viva Glint's published defaults, the closest thing this
 * problem has to an industry standard: 5 respondents before a score is reported
 * and 10 before free-text is, with a secondary suppression rule on top. Culture
 * Amp reports 5. Qualtrics merges too-small groups into the next-smallest rather
 * than showing them. Ours was 3, chosen when the underlying rows were one per
 * booking rather than one per call.
 *
 * They are code constants, deliberately, and not per-organisation settings. Glint
 * makes a point of freezing its thresholds once a survey has collected data,
 * because an administrator who can lower the bar after seeing the shape of the
 * responses can lower it until the aggregate identifies somebody. A constant
 * cannot be tuned by the party it protects — the same argument
 * `MIN_RATED_UNITS_FOR_PUBLIC_SCORE` makes for the public score.
 */

/** Respondents needed before any average is reported to an organisation. */
export const ORG_QUALITY_MIN_RESPONDENTS = 5;

/**
 * Respondents needed before free-text would be reported.
 *
 * Nothing reaches this threshold today, because no organisation surface returns a
 * comment at all — ADR 20 keeps the note participant-only. The constant exists so
 * whoever is next asked for "just the comments, aggregated" has a number to point
 * at rather than a judgement call, and so the two floors are visibly different.
 */
export const ORG_QUALITY_MIN_RESPONDENTS_FOR_COMMENTS = 10;

/**
 * Whether a narrower TIME WINDOW may be published beside the wider one it sits
 * inside.
 *
 * `applyCohortSuppression` protects the per-consultant breakdown, and nothing
 * protected the two windows — but they are the same attack. `last30` is a subset
 * of `overall`, so publishing both counts and both averages publishes the
 * complement: the respondents who answered EARLIER than 30 days ago, and their
 * mean, by subtraction. Six all-time respondents beside five recent ones names
 * the sixth person's rating exactly.
 *
 * So the narrower window is withheld whenever its complement is a cohort we would
 * have refused to publish on its own. A complement of zero is safe — the two
 * windows describe the same people and there is nothing outside to recover.
 */
export function suppressNarrowerWindow(
  /** The people who have a response OUTSIDE the narrower window — counted, not
   *  inferred. Subtracting respondent counts is only a LOWER bound on this,
   *  because somebody who answered both before and inside the window belongs to
   *  both sets: `wider - narrower` counts the people with *no* recent response,
   *  and the older responses come from those plus the overlap. The lower bound
   *  errs toward suppressing, so it was safe rather than leaky — but it withheld
   *  a published window that did not need withholding, and the caller already
   *  holds the rows to count the real thing. */
  complement: { respondents: number },
): boolean {
  return (
    complement.respondents > 0 &&
    complement.respondents < ORG_QUALITY_MIN_RESPONDENTS
  );
}

/**
 * Apply the floor, plus SECONDARY suppression.
 *
 * The floor alone is not enough when cohorts are published beside a total: the
 * hidden cohorts are, collectively, the total minus the published ones. So the
 * HIDDEN set must itself clear the floor — counted in distinct PEOPLE, because
 * one respondent can sit in several cohorts, and "two hidden groups" can be two
 * ratings by the same person. Glint's form is a minimum count of suppressed
 * groups; this is the same rule stated on respondents.
 *
 * Hide every cohort below the floor; while the hidden people number fewer than
 * the floor, hide the smallest survivor too; with no survivor left, hide all.
 * Every cohort the caller wants in the arithmetic belongs in `cohorts`, including
 * an unattributed one, or its complement is a hidden group this never sees.
 *
 * `suppressed` is the count of hidden cohorts, stated only when the hidden
 * people clear the floor. Below it nothing is published at all, and "N
 * withheld" would describe a group too small to describe.
 */
export function applyCohortSuppression<
  T extends { respondentIds: ReadonlySet<string> },
>(cohorts: readonly T[]): { published: T[]; hidden: T[]; suppressed: number } {
  const people = (set: Iterable<T>) => {
    const ids = new Set<string>();
    for (const c of set) for (const id of c.respondentIds) ids.add(id);
    return ids.size;
  };
  const hidden = new Set(
    cohorts.filter((c) => c.respondentIds.size < ORG_QUALITY_MIN_RESPONDENTS),
  );
  while (hidden.size > 0 && people(hidden) < ORG_QUALITY_MIN_RESPONDENTS) {
    const smallestSurvivor = cohorts
      .filter((c) => !hidden.has(c))
      .reduce<T | null>(
        (min, c) =>
          min === null || c.respondentIds.size < min.respondentIds.size
            ? c
            : min,
        null,
      );
    if (!smallestSurvivor) break;
    hidden.add(smallestSurvivor);
  }
  const hiddenList = cohorts.filter((c) => hidden.has(c));
  return {
    published: cohorts.filter((c) => !hidden.has(c)),
    hidden: hiddenList,
    suppressed:
      people(hiddenList) >= ORG_QUALITY_MIN_RESPONDENTS ? hiddenList.length : 0,
  };
}
