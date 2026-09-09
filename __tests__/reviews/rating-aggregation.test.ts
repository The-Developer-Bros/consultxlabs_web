/**
 * @jest-environment node
 */

/**
 * #1300 — the two published scores.
 *
 * The old blended score needed a denormalised bucket key to stop a 200-seat
 * webinar dominating a consultant's 1:1 practice. Two tracks make that
 * structural instead of arithmetic: a webinar cannot outweigh 1:1 work because it
 * is not in the same number. What is left to pin is what each track counts, and
 * what it refuses to publish:
 *
 *   1. 1:1 counts distinct CLIENTS. The unique on
 *      (consultantProfileId, consulteeProfileId, track) means a review IS a data
 *      point, so there is nothing to collapse.
 *   2. GROUP counts qualifying EVENTS. Every attendee of one webinar folds into
 *      one point, and the event only counts once at least
 *      MIN_GROUP_RESPONSES_PER_EVENT people answered — otherwise two replies out
 *      of two hundred buy a published score.
 *   3. Neither publishes below its threshold, so one review cannot define a new
 *      consultant.
 *   4. A score is SHRUNK toward the platform mean, so 5.0 from five ratings does
 *      not outrank 4.8 from two hundred.
 *   5. Legacy rows carry no track and contribute to NEITHER published score —
 *      unknown provenance fails closed, rather than being presumed 1:1.
 *
 * The individual review cards still render in every case; only the score is
 * weighted and suppressed.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import {
  recomputeConsultantRating,
  MIN_RATED_CLIENTS_ONE_TO_ONE,
  MIN_RATED_EVENTS_GROUP,
  MIN_GROUP_RESPONSES_PER_EVENT,
  SCORE_PRIOR_WEIGHT,
} from "@/lib/reviews";
import type { ReviewTrack } from "@prisma/client";

type Row = {
  rating: number;
  track: ReviewTrack | null;
  ratingUnitId: string | null;
  ratedSessionAt: Date | null;
  createdAt: Date;
};

const NOW = new Date("2026-09-10T00:00:00Z");
/** Shrinking toward the midpoint keeps the arithmetic legible in assertions. */
const PRIORS = {
  platformMeanOneToOne: 3,
  platformMeanGroup: 3,
  sampleCountOneToOne: 0,
  sampleCountGroup: 0,
};

/** One 1:1 review — one client, one data point. */
const solo = (rating: number): Row => ({
  rating,
  track: "ONE_TO_ONE",
  ratingUnitId: null,
  ratedSessionAt: NOW,
  createdAt: NOW,
});

/** `n` attendees of one group event, all giving `rating`. */
const event = (id: string, rating: number, n: number): Row[] =>
  Array.from({ length: n }, () => ({
    rating,
    track: "GROUP" as ReviewTrack,
    ratingUnitId: id,
    ratedSessionAt: NOW,
    createdAt: NOW,
  }));

/** A row written before `track` existed. */
const legacy = (rating: number): Row => ({
  rating,
  track: null,
  ratingUnitId: null,
  ratedSessionAt: null,
  createdAt: NOW,
});

type Written = {
  publishedRatingOneToOne: number | null;
  publishedRatingGroup: number | null;
  ratedClientsOneToOne: number;
  ratedEventsGroup: number;
  rawRatingOneToOne: number | null;
  rawRatingGroup: number | null;
  effectiveSampleOneToOne: number | null;
  rating: number;
  publishedRating: number | null;
  ratingUnitCount: number;
  reviewCount: number;
};

async function score(rows: Row[]): Promise<Written> {
  const update = jest.fn().mockResolvedValue({});
  const client = {
    consultantReview: { findMany: jest.fn().mockResolvedValue(rows) },
    consultantProfile: { update },
    scoringSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  await recomputeConsultantRating(client as never, "cp1", {
    priors: PRIORS,
    snapshotId: null,
    now: NOW,
  });
  return update.mock.calls[0][0].data as Written;
}

/** `(Σr + m·C) / (n + m)` at weight 1, rounded the way the code rounds. */
const shrunk = (ratings: number[], mean = 3) =>
  Math.round(
    ((ratings.reduce((a, b) => a + b, 0) + SCORE_PRIOR_WEIGHT * mean) /
      (ratings.length + SCORE_PRIOR_WEIGHT)) *
      100,
  ) / 100;

describe("the two tracks are separate numbers", () => {
  it("a 200-seat webinar cannot touch the 1:1 score at all", async () => {
    const clients = Array.from({ length: MIN_RATED_CLIENTS_ONE_TO_ONE }, () =>
      solo(5),
    );
    const withoutEvent = await score(clients);
    const withEvent = await score([...clients, ...event("webinar:w1", 2, 200)]);

    // The old failure mode was arithmetic — a bad event dragging the blend down.
    // Now it is not expressible: the event lands in a different column.
    expect(withEvent.publishedRatingOneToOne).toBe(
      withoutEvent.publishedRatingOneToOne,
    );
    expect(withEvent.ratedClientsOneToOne).toBe(MIN_RATED_CLIENTS_ONE_TO_ONE);
    expect(withEvent.ratedEventsGroup).toBe(1);
  });

  it("folds every attendee of one event into a single data point", async () => {
    const w = await score(event("webinar:w1", 4, 200));
    expect(w.ratedEventsGroup).toBe(1);
    expect(w.reviewCount).toBe(200);
    // One point of value 4, shrunk toward 3.
    expect(w.rawRatingGroup).toBe(4);
    expect(w.publishedRatingGroup).toBeNull(); // one event, below the gate
  });

  it("counts each class RUN separately, not classes as a category", async () => {
    // A CLASS mints one Appointment per enrolment, so grouping by session TYPE
    // would collapse a consultant's whole teaching history into one point.
    const rows = Array.from({ length: MIN_RATED_EVENTS_GROUP }, (_, i) =>
      event(`class:c${i}`, 5, MIN_GROUP_RESPONSES_PER_EVENT),
    ).flat();
    const s = await score(rows);
    expect(s.ratedEventsGroup).toBe(MIN_RATED_EVENTS_GROUP);
    expect(s.publishedRatingGroup).toBe(
      shrunk(Array(MIN_RATED_EVENTS_GROUP).fill(5)),
    );
  });

  it("ignores an event nobody answered enough of", async () => {
    // Two replies out of two hundred is not evidence about the consultant, and
    // without this floor it would be a published score.
    const thin = await score(
      event("webinar:w1", 5, MIN_GROUP_RESPONSES_PER_EVENT - 1),
    );
    expect(thin.ratedEventsGroup).toBe(0);
    expect(thin.publishedRatingGroup).toBeNull();
    expect(thin.rawRatingGroup).toBeNull();
    // The reviews still exist and still render.
    expect(thin.reviewCount).toBe(MIN_GROUP_RESPONSES_PER_EVENT - 1);
  });
});

describe("suppression below the threshold", () => {
  it("publishes nothing on either track below its gate", async () => {
    const s = await score([
      ...Array.from({ length: MIN_RATED_CLIENTS_ONE_TO_ONE - 1 }, () =>
        solo(5),
      ),
      ...event("webinar:w1", 5, MIN_GROUP_RESPONSES_PER_EVENT),
    ]);
    expect(s.publishedRatingOneToOne).toBeNull();
    expect(s.publishedRatingGroup).toBeNull();
    // ...but the counts are honest, so the profile can say "not enough yet".
    expect(s.ratedClientsOneToOne).toBe(MIN_RATED_CLIENTS_ONE_TO_ONE - 1);
    expect(s.ratedEventsGroup).toBe(1);
  });

  it("publishes exactly at the threshold", async () => {
    const s = await score(
      Array.from({ length: MIN_RATED_CLIENTS_ONE_TO_ONE }, () => solo(5)),
    );
    expect(s.publishedRatingOneToOne).toBe(
      shrunk(Array(MIN_RATED_CLIENTS_ONE_TO_ONE).fill(5)),
    );
  });

  it("leaves a consultant with no reviews unpublished rather than at zero", async () => {
    // A 0.0 is a claim about someone nobody has rated. An absent score is the
    // truth, and it is what the profile copy is written against.
    const s = await score([]);
    expect(s.publishedRatingOneToOne).toBeNull();
    expect(s.publishedRatingGroup).toBeNull();
    expect(s.rawRatingOneToOne).toBeNull();
    expect(s.effectiveSampleOneToOne).toBeNull();
    expect(s.ratedClientsOneToOne).toBe(0);
  });
});

describe("shrinkage", () => {
  it("does not let a perfect small sample outrank a strong large one", async () => {
    // This is the whole reason a plain average is the wrong instrument, and the
    // reason every mature platform migrated off one.
    const fivePerfect = await score(
      Array.from({ length: MIN_RATED_CLIENTS_ONE_TO_ONE }, () => solo(5)),
    );
    const manyStrong = await score(
      Array.from({ length: 200 }, () => solo(4.8)),
    );
    expect(fivePerfect.rawRatingOneToOne).toBe(5);
    expect(manyStrong.rawRatingOneToOne).toBe(4.8);
    expect(manyStrong.publishedRatingOneToOne!).toBeGreaterThan(
      fivePerfect.publishedRatingOneToOne!,
    );
  });

  it("reports the effective sample so a moved score can be explained", async () => {
    // At the launch half-life the weight is 1 per row, so this is the count —
    // and it will stop being the count the day decay is switched on, which is
    // exactly when someone will need to know why their score drifted.
    const s = await score(Array.from({ length: 5 }, () => solo(5)));
    expect(s.effectiveSampleOneToOne).toBe(5);
  });
});

describe("rows written before the track existed", () => {
  it("contribute to neither published score", async () => {
    // Nothing on a legacy row says which product the session was: the 59 rows
    // that predate this carry a NULL appointmentId too. Presuming 1:1 would
    // silently admit webinar reviews into the 1:1 score.
    const s = await score(Array.from({ length: 10 }, () => legacy(1)));
    expect(s.publishedRatingOneToOne).toBeNull();
    expect(s.publishedRatingGroup).toBeNull();
    expect(s.ratedClientsOneToOne).toBe(0);
    expect(s.ratedEventsGroup).toBe(0);
  });

  it("still feed the legacy blended columns, so existing readers do not break", async () => {
    // The surfaces move over in their own change. Until then `publishedRating`
    // has to keep meaning what it meant.
    const s = await score(Array.from({ length: 5 }, () => legacy(4)));
    expect(s.rating).toBe(4);
    expect(s.ratingUnitCount).toBe(5);
    expect(s.publishedRating).toBe(4);
    expect(s.reviewCount).toBe(5);
  });

  it("keeps two decimals rather than a repeating fraction", async () => {
    const s = await score([legacy(5), legacy(4), legacy(4)]);
    expect(s.rating).toBe(4.33);
  });
});
