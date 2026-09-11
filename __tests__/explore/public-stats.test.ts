/**
 * #1485 / #1490 — the public heroes used to render fabricated social proof.
 * /explore/experts fell back to "10K+" experts and a "4.9" rating whenever the
 * real figures were zero (which is the entire pre-launch state) and rendered a
 * hardcoded "50K+ Sessions Completed"; the landing page counted "10,000+ Active
 * Users", "500+ Expert Mentors" and "50,000+ Sessions Completed"; and
 * /explore/programs fell back to "500+ Classes Available", "200+ Live Webinars"
 * and "25K+ Students Enrolled" — that last one even on the data path.
 *
 * These pin the derivation, not the layout: a figure that is not yet meaningful
 * produces no entry at all, and no entry can carry one of the literals that
 * were there before.
 */

import {
  buildExpertHeroStats,
  buildProgramHeroStats,
  deriveDirectoryRating,
  MIN_REVIEWS_FOR_PUBLIC_RATING,
} from "../../lib/data/public-stats";

/** Every hardcoded figure this change removed, across all three heroes. */
const FABRICATED = [
  "10K+",
  "4.9",
  "50K+",
  "10,000+",
  "500+",
  "50,000+",
  "200+",
  "25K+",
];

const NO_EXPERTS = {
  totalConsultants: 0,
  averageRating: 0,
  publishedReviewCount: 0,
  completedSessions: 0,
};

const NO_PROGRAMS = {
  publishedClassCount: 0,
  publishedWebinarCount: 0,
  enrolledLearnerCount: 0,
};

describe("deriveDirectoryRating", () => {
  it("weights by review, so a five-review newcomer cannot outvote a busy expert", () => {
    const rating = deriveDirectoryRating([
      { publishedRating: 4.0, reviewCount: 100 },
      { publishedRating: 5.0, reviewCount: 5 },
    ]);

    // (4.0 × 100 + 5.0 × 5) / 105 = 4.0476…, displayed "4.0". The unweighted
    // mean would read 4.5 — half a star of social proof conjured out of one
    // lightly-reviewed profile. Asserted raw: rounding is a display concern.
    expect(rating.averageRating).toBeCloseTo(425 / 105, 10);
    expect(rating.publishedReviewCount).toBe(105);
    expect(rating.averageRating.toFixed(1)).toBe("4.0");
  });

  it("skips suppressed profiles entirely, so their reviews never clear the gate", () => {
    // #705 leaves `publishedRating` NULL below the suppression threshold; those
    // reviews back no published number and must not count toward the one that
    // licenses showing it.
    const rating = deriveDirectoryRating([
      { publishedRating: null, reviewCount: 40 },
      { publishedRating: 4.5, reviewCount: 2 },
    ]);

    expect(rating.averageRating).toBe(4.5);
    expect(rating.publishedReviewCount).toBe(2);
    expect(rating.publishedReviewCount).toBeLessThan(
      MIN_REVIEWS_FOR_PUBLIC_RATING,
    );
    expect(buildExpertHeroStats({ ...NO_EXPERTS, ...rating })).toEqual([]);
  });

  it("returns a zero rating rather than NaN when nothing qualifies", () => {
    expect(deriveDirectoryRating([])).toEqual({
      averageRating: 0,
      publishedReviewCount: 0,
    });
    expect(
      deriveDirectoryRating([{ publishedRating: 5, reviewCount: 0 }]),
    ).toEqual({ averageRating: 0, publishedReviewCount: 0 });
  });
});

describe("buildExpertHeroStats", () => {
  it("emits nothing at all when every figure is zero", () => {
    expect(buildExpertHeroStats(NO_EXPERTS)).toEqual([]);
  });

  it("omits the sessions stat when no session has been completed", () => {
    const stats = buildExpertHeroStats({
      ...NO_EXPERTS,
      totalConsultants: 12,
      completedSessions: 0,
    });

    expect(stats.map((s) => s.key)).toEqual(["experts"]);
    expect(stats.some((s) => s.label === "Sessions Completed")).toBe(false);
  });

  it("omits the rating until enough published reviews stand behind it", () => {
    const belowThreshold = buildExpertHeroStats({
      ...NO_EXPERTS,
      averageRating: 4.6,
      publishedReviewCount: MIN_REVIEWS_FOR_PUBLIC_RATING - 1,
    });
    expect(belowThreshold).toEqual([]);

    const atThreshold = buildExpertHeroStats({
      ...NO_EXPERTS,
      averageRating: 4.6,
      publishedReviewCount: MIN_REVIEWS_FOR_PUBLIC_RATING,
    });
    expect(atThreshold).toEqual([
      { key: "rating", value: 4.6, display: "4.6", label: "Average Rating" },
    ]);
  });

  it("renders the real figures when they exist", () => {
    const stats = buildExpertHeroStats({
      totalConsultants: 12,
      averageRating: 4.25,
      publishedReviewCount: 30,
      completedSessions: 87,
    });

    expect(stats).toEqual([
      { key: "experts", value: 12, display: "12", label: "Active Experts" },
      { key: "rating", value: 4.25, display: "4.3", label: "Average Rating" },
      {
        key: "sessions",
        value: 87,
        display: "87",
        label: "Sessions Completed",
      },
    ]);
  });
});

describe("buildProgramHeroStats", () => {
  it("emits nothing at all when the catalogue is empty", () => {
    expect(buildProgramHeroStats(NO_PROGRAMS)).toEqual([]);
  });

  it("never emits a learners stat when nobody is enrolled", () => {
    const stats = buildProgramHeroStats({
      ...NO_PROGRAMS,
      publishedClassCount: 3,
      publishedWebinarCount: 2,
    });

    expect(stats.map((s) => s.key)).toEqual(["classes", "webinars"]);
    expect(stats.some((s) => s.key === "learners")).toBe(false);
  });

  it("renders the real figures when they exist", () => {
    expect(
      buildProgramHeroStats({
        publishedClassCount: 1,
        publishedWebinarCount: 4,
        enrolledLearnerCount: 26,
      }),
    ).toEqual([
      { key: "classes", value: 1, display: "1", label: "Class Available" },
      { key: "webinars", value: 4, display: "4", label: "Live Webinars" },
      {
        key: "learners",
        value: 26,
        display: "26",
        label: "Learners Enrolled",
      },
    ]);
  });
});

// The literals every hero used to fall back to. Most of them fired precisely
// when the data was thin, so thin data is where this has to hold. A genuinely
// measured 4.9 is a different string with the same digits and is allowed — the
// defect was never the number, it was the invention.
describe("no fabricated literal survives, on the inputs that used to produce them", () => {
  it("holds for the expert heroes", () => {
    const thin = [
      NO_EXPERTS,
      { ...NO_EXPERTS, totalConsultants: 1, completedSessions: 1 },
      { ...NO_EXPERTS, averageRating: 4.9, publishedReviewCount: 1 },
    ];

    for (const input of thin) {
      for (const stat of buildExpertHeroStats(input)) {
        expect(FABRICATED).not.toContain(stat.display);
      }
    }
  });

  it("holds for the programs hero", () => {
    const thin = [
      NO_PROGRAMS,
      { ...NO_PROGRAMS, publishedClassCount: 1 },
      {
        publishedClassCount: 2,
        publishedWebinarCount: 1,
        enrolledLearnerCount: 3,
      },
    ];

    for (const input of thin) {
      for (const stat of buildProgramHeroStats(input)) {
        expect(FABRICATED).not.toContain(stat.display);
      }
    }
  });
});
