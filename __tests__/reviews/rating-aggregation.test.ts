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
 *   4. A published score is the PLAIN MEAN of its track's points (#1566): no
 *      prior, no decay; the count printed beside it is the disclosure.
 *   5. Legacy rows carry no track and contribute to NEITHER published score —
 *      unknown provenance fails closed, rather than being presumed 1:1.
 *
 * The individual review cards still render in every case; only the score is
 * suppressed.
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
} from "@/lib/reviews";
import type { ReviewTrack } from "@prisma/client";

type Row = {
  rating: number;
  track: ReviewTrack | null;
  ratingUnitId: string | null;
  excludedFromAggregateAt: Date | null;
};

const NOW = new Date("2026-09-10T00:00:00Z");

/** One 1:1 review — one client, one data point. */
const solo = (rating: number): Row => ({
  rating,
  track: "ONE_TO_ONE",
  ratingUnitId: null,
  excludedFromAggregateAt: null,
});

/** `n` attendees of one group event, all giving `rating`. */
const event = (id: string, rating: number, n: number): Row[] =>
  Array.from({ length: n }, () => ({
    rating,
    track: "GROUP" as ReviewTrack,
    ratingUnitId: id,
    excludedFromAggregateAt: null,
  }));

/** A row written before `track` existed. */
const legacy = (rating: number): Row => ({
  rating,
  track: null,
  ratingUnitId: null,
  excludedFromAggregateAt: null,
});

type Written = {
  publishedRatingOneToOne: number | null;
  publishedRatingGroup: number | null;
  ratedClientsOneToOne: number;
  ratedEventsGroup: number;
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
  };
  await recomputeConsultantRating(client as never, "cp1", NOW);
  return update.mock.calls[0][0].data as Written;
}

/** The plain mean, rounded the way the code rounds. */
const mean = (ratings: number[]) =>
  Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100;

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
    expect(s.publishedRatingGroup).toBe(5);
  });

  it("ignores an event nobody answered enough of", async () => {
    // Two replies out of two hundred is not evidence about the consultant, and
    // without this floor it would be a published score.
    const thin = await score(
      event("webinar:w1", 5, MIN_GROUP_RESPONSES_PER_EVENT - 1),
    );
    expect(thin.ratedEventsGroup).toBe(0);
    expect(thin.publishedRatingGroup).toBeNull();
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
    expect(s.publishedRatingOneToOne).toBe(5);
  });

  it("leaves a consultant with no reviews unpublished rather than at zero", async () => {
    // A 0.0 is a claim about someone nobody has rated. An absent score is the
    // truth, and it is what the profile copy is written against.
    const s = await score([]);
    expect(s.publishedRatingOneToOne).toBeNull();
    expect(s.publishedRatingGroup).toBeNull();
    expect(s.ratedClientsOneToOne).toBe(0);
  });
});

describe("the plain mean (#1566)", () => {
  it("publishes exactly what a client would get averaging the cards by hand", async () => {
    // No prior, no decay: a consultant with five straight fives reads 5.0, not
    // 4.65. The count shown beside the score is what keeps thin samples honest.
    const s = await score([5, 4, 5, 3, 4].map(solo));
    expect(s.publishedRatingOneToOne).toBe(mean([5, 4, 5, 3, 4]));
    expect(s.ratedClientsOneToOne).toBe(5);
  });

  it("averages the group track over event means, one vote per event", async () => {
    // A 200-seat webinar at 3 and a five-person class at 5 are two points, so the
    // track reads 4.0 — the room size buys no extra weight.
    const rows = [
      ...event("webinar:w1", 3, 200),
      ...Array.from({ length: MIN_RATED_EVENTS_GROUP - 1 }, (_, i) =>
        event(`class:c${i}`, 5, MIN_GROUP_RESPONSES_PER_EVENT),
      ).flat(),
    ];
    const s = await score(rows);
    expect(s.ratedEventsGroup).toBe(MIN_RATED_EVENTS_GROUP);
    expect(s.publishedRatingGroup).toBe(
      mean([3, ...Array(MIN_RATED_EVENTS_GROUP - 1).fill(5)]),
    );
  });
});

describe("ratings protection", () => {
  it("keeps an excluded review in the count and out of the score", async () => {
    // The row still renders on the profile, so "Reviews (N)" must count it; it
    // only leaves the arithmetic. Five clients plus one excluded 1-star: the
    // score is the five, the count is six.
    const five = [5, 5, 5, 5, 5].map(solo);
    const excluded = { ...solo(1), excludedFromAggregateAt: NOW };
    const written = await score([...five, excluded]);
    expect(written.reviewCount).toBe(6);
    expect(written.ratedClientsOneToOne).toBe(5);
    expect(written.publishedRatingOneToOne).toBe(5);
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
