/**
 * @jest-environment node
 */

/**
 * #1300 — the cohort floor, and why a floor on its own is not enough.
 *
 * ADR 20 classifies a member's rating of a session as CONTENT, and the aggregate
 * is the one exception that lets an organisation answer "is this expert worth
 * re-booking". The exception is only defensible if the aggregate is genuinely
 * anonymous, and once a per-consultant breakdown is published beside an org total,
 * subtraction is the attack: hide exactly one cohort and its value is the total
 * minus the published ones.
 *
 * So the rule is not "hide the small ones" — it is "never hide exactly one".
 * Microsoft Viva Glint ships this as a second minimum on the number of suppressed
 * groups; Qualtrics merges a too-small group into the next-smallest instead. Both
 * are the same idea.
 */

import {
  ORG_QUALITY_MIN_RESPONDENTS,
  applyCohortSuppression,
  suppressNarrowerWindow,
} from "@/lib/enterprise/quality-thresholds";

const cohort = (respondents: number, id = `c${respondents}`) => ({
  consultantProfileId: id,
  respondents,
});

const FLOOR = ORG_QUALITY_MIN_RESPONDENTS;

describe("the cohort floor", () => {
  it("is the industry number, not the one we started with", () => {
    // Glint and Culture Amp both publish 5. Ours was 3, chosen when the rows were
    // one per booking rather than one per call — so one member rating three
    // sessions of a single subscription used to clear it alone.
    expect(FLOOR).toBe(5);
  });

  it("publishes every cohort when they all clear it", () => {
    const { published, suppressed } = applyCohortSuppression([
      cohort(FLOOR),
      cohort(FLOOR + 3),
      cohort(FLOOR + 10),
    ]);
    expect(published).toHaveLength(3);
    expect(suppressed).toBe(0);
  });

  it("hides a cohort below it", () => {
    const { published } = applyCohortSuppression([
      cohort(FLOOR + 5, "big"),
      cohort(FLOOR + 4, "mid"),
      cohort(1, "tiny"),
    ]);
    expect(published.map((c) => c.consultantProfileId)).not.toContain("tiny");
  });
});

describe("secondary suppression", () => {
  it("never hides exactly one, because one hidden cohort is a published one", () => {
    // Two big cohorts and one tiny one. Hiding only the tiny one leaves its total
    // recoverable by subtraction from the org figure, so the smallest survivor
    // goes with it.
    const { published, suppressed } = applyCohortSuppression([
      cohort(20, "big"),
      cohort(6, "small-but-over"),
      cohort(1, "tiny"),
    ]);
    expect(suppressed).toBe(2);
    const ids = published.map((c) => c.consultantProfileId);
    expect(ids).not.toContain("tiny");
    expect(ids).not.toContain("small-but-over");
    expect(ids).toEqual(["big"]);
  });

  it("leaves two already-hidden cohorts alone", () => {
    // Two below the floor is already enough: only their sum is derivable, which
    // is what the rule is for. Pulling in a third would be gratuitous.
    const { published, suppressed } = applyCohortSuppression([
      cohort(20, "big"),
      cohort(9, "also-big"),
      cohort(2, "tiny-a"),
      cohort(1, "tiny-b"),
    ]);
    expect(suppressed).toBe(2);
    expect(published.map((c) => c.consultantProfileId)).toEqual([
      "big",
      "also-big",
    ]);
  });

  it("publishes nothing when the only cohort is below the floor", () => {
    // There is no survivor to pair it with, so the choice is publish it or
    // publish nothing. An organisation with one expert and one respondent must not
    // be handed that respondent's rating.
    const { published, suppressed } = applyCohortSuppression([
      cohort(1, "only"),
    ]);
    expect(published).toEqual([]);
    expect(suppressed).toBe(1);
  });

  it("handles no cohorts at all", () => {
    expect(applyCohortSuppression([])).toEqual({
      published: [],
      suppressed: 0,
    });
  });

  it("does not mutate the input order of what it publishes", () => {
    // The route sorts by respondents before calling this, and the UI renders in
    // that order. Re-sorting here would silently change the reading order.
    const input = [cohort(30, "a"), cohort(20, "b"), cohort(10, "c")];
    expect(
      applyCohortSuppression(input).published.map((c) => c.consultantProfileId),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("overlapping time windows", () => {
  /** The people with a response OUTSIDE the narrower window. Counted from the
   *  rows by the caller, not inferred: `overall − last30` is only a LOWER bound,
   *  because anyone who answered both before and inside the window is in both
   *  cohorts. */
  const olderCohort = (respondents: number) =>
    suppressNarrowerWindow({ respondents });

  it("suppresses the recent window when only one person answered earlier", () => {
    // The case the floor waves through and subtraction defeats: both windows clear
    // 5, both averages publish, and the older cohort is one person — so their
    // rating is (overall × n) − (last30 × m). One person, named by arithmetic.
    expect(olderCohort(1)).toBe(true);
  });

  it("publishes both when the two windows hold the same people", () => {
    // Nothing sits outside the narrower window, so there is no complement to
    // recover. Suppressing here would hide a figure that leaks nothing.
    expect(olderCohort(0)).toBe(false);
  });

  it("publishes both when the older cohort clears the floor on its own", () => {
    // Five older respondents is a cohort we would have published unaided, so the
    // subtraction reveals an aggregate rather than a person.
    expect(olderCohort(ORG_QUALITY_MIN_RESPONDENTS)).toBe(false);
  });

  it("suppresses at every cohort size between one and the floor", () => {
    for (let n = 1; n < ORG_QUALITY_MIN_RESPONDENTS; n++) {
      expect(olderCohort(n)).toBe(true);
    }
    expect(olderCohort(ORG_QUALITY_MIN_RESPONDENTS)).toBe(false);
  });

  it("takes the real older cohort, not a difference of respondent counts", () => {
    // The regression this guards. Six all-time respondents and five recent ones
    // subtract to one, which would suppress — but if five of those six answered in
    // BOTH windows, the people with an older response number six, not one, and the
    // window was safe to publish all along. Subtraction lower-bounds the cohort, so
    // it errs toward withholding: safe, but it hides figures that leak nothing.
    //
    // The helper takes the counted cohort, so the same 6-and-5 pair resolves either
    // way depending on the overlap the caller measured.
    expect(olderCohort(6)).toBe(false); // six people answered earlier — publishable
    expect(olderCohort(1)).toBe(true); // one did — withhold
  });
});
