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
 * Apply the floor, plus SECONDARY suppression.
 *
 * The floor alone is not enough when cohorts are published beside a total. If
 * exactly one cohort is hidden, its value is the total minus the published ones —
 * so an administrator with a calculator recovers precisely the thing the floor
 * exists to hide. Glint solves this with a second minimum on the number of
 * suppressed groups; the standard form is that you never hide exactly one.
 *
 * So: hide every cohort below the floor, and if that leaves exactly one hidden,
 * hide the smallest surviving cohort too. Either nothing is hidden or at least two
 * are, and the sum of the hidden ones is all that can be derived.
 */
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
  wider: { respondents: number },
  narrower: { respondents: number },
): boolean {
  const complement = wider.respondents - narrower.respondents;
  return complement > 0 && complement < ORG_QUALITY_MIN_RESPONDENTS;
}

export function applyCohortSuppression<T extends { respondents: number }>(
  cohorts: readonly T[],
): { published: T[]; suppressed: number } {
  let hidden = new Set(
    cohorts.filter((c) => c.respondents < ORG_QUALITY_MIN_RESPONDENTS),
  );

  if (hidden.size === 1) {
    // Hiding exactly one is the same as publishing it. Take the smallest cohort
    // that would otherwise have survived; ties break arbitrarily, which is fine
    // because either of two equal cohorts leaves the same arithmetic.
    const smallestSurvivor = cohorts
      .filter((c) => !hidden.has(c))
      .reduce<T | null>(
        (min, c) => (min === null || c.respondents < min.respondents ? c : min),
        null,
      );
    // If there is no survivor to pair it with, only one cohort exists and it is
    // below the floor: publish nothing rather than publish it.
    hidden = smallestSurvivor
      ? new Set([...hidden, smallestSurvivor])
      : new Set(cohorts);
  }

  return {
    published: cohorts.filter((c) => !hidden.has(c)),
    suppressed: hidden.size,
  };
}
