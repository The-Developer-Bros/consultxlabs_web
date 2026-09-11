/**
 * @jest-environment node
 */

/**
 * #705 — the published score.
 *
 * Two rules make this different from an average of the review rows:
 *
 *   1. A group session contributes the MEAN of its attendees as a SINGLE data
 *      point, so one 200-seat webinar cannot outweigh a consultant's entire 1:1
 *      practice — and one bad event cannot tank it either.
 *   2. Below MIN_RATED_UNITS_FOR_PUBLIC_SCORE distinct rated sessions there is
 *      no published number at all, so a single review cannot define a new
 *      consultant and there is nothing to gain by gaming the first one.
 *
 * The individual review cards still render in both cases; only the score is
 * weighted and suppressed.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import {
  recomputeConsultantRating,
  MIN_RATED_UNITS_FOR_PUBLIC_SCORE,
} from "@/lib/reviews";

type Unit = { ratingUnitId: string; avg: number; count: number };

function tx(units: Unit[], legacy: { avg: number | null; count: number }) {
  const update = jest.fn().mockResolvedValue({});
  return {
    update,
    client: {
      consultantReview: {
        groupBy: jest.fn().mockResolvedValue(
          units.map((u) => ({
            ratingUnitId: u.ratingUnitId,
            _avg: { rating: u.avg },
            _count: { _all: u.count },
          })),
        ),
        aggregate: jest.fn().mockResolvedValue({
          _avg: { rating: legacy.avg },
          _count: { _all: legacy.count },
        }),
      },
      consultantProfile: { update },
    },
  };
}

async function score(units: Unit[], legacy = { avg: null as number | null, count: 0 }) {
  const t = tx(units, legacy);
  await recomputeConsultantRating(t.client as never, "cp1");
  return t.update.mock.calls[0][0].data as {
    rating: number;
    publishedRating: number | null;
    ratingUnitCount: number;
    reviewCount: number;
  };
}

const unit = (id: string, avg: number, count = 1): Unit => ({
  ratingUnitId: id,
  avg,
  count,
});

describe("a group session is one data point", () => {
  it("does not let a 200-seat webinar outweigh five 1:1 sessions", async () => {
    // The webinar averaged 2.0 across 200 attendees; the 1:1 work is 5.0.
    // A plain row average would be ~2.07 — the 1:1 practice erased.
    const data = await score([
      unit("webinar:w1", 2, 200),
      unit("appointment:a1", 5),
      unit("appointment:a2", 5),
      unit("appointment:a3", 5),
      unit("appointment:a4", 5),
      unit("appointment:a5", 5),
    ]);
    expect(data.rating).toBe(4.5); // (2 + 5×5) / 6
    expect(data.ratingUnitCount).toBe(6);
    // …but the count still tells the truth about how many people wrote.
    expect(data.reviewCount).toBe(205);
  });

  it("counts each class RUN separately, not classes as a category", async () => {
    // A CLASS mints one Appointment per enrolment, so the unit key has to be
    // the class id — grouping by session TYPE would collapse every class the
    // consultant ever ran into a single point.
    const data = await score([
      unit("class:c1", 5, 30),
      unit("class:c2", 1, 30),
    ]);
    expect(data.rating).toBe(3);
    expect(data.ratingUnitCount).toBe(2);
  });
});

describe("rows written before the unit key existed", () => {
  it("each count as their own data point, not one shared bucket", async () => {
    // groupBy lumps every NULL key together. Folding them as avg×count is
    // arithmetically identical to enumerating them; without it a consultant's
    // whole pre-#705 history would collapse into a single point.
    const data = await score([], { avg: 4, count: 10 });
    expect(data.rating).toBe(4);
    expect(data.ratingUnitCount).toBe(10);
    expect(data.reviewCount).toBe(10);
    expect(data.publishedRating).toBe(4);
  });

  it("mixes cleanly with unit-keyed rows", async () => {
    const data = await score([unit("appointment:a1", 2)], {
      avg: 5,
      count: 3,
    });
    // (2) + (5 × 3) = 17 over 4 units
    expect(data.rating).toBe(4.25);
    expect(data.ratingUnitCount).toBe(4);
    expect(data.reviewCount).toBe(4);
  });
});

describe("minimum-N suppression", () => {
  it("publishes nothing below the threshold, however many people reviewed", async () => {
    // Four sold-out webinars, six hundred happy reviewers, four data points.
    const data = await score([
      unit("webinar:w1", 5, 150),
      unit("webinar:w2", 5, 150),
      unit("webinar:w3", 5, 150),
      unit("webinar:w4", 5, 150),
    ]);
    expect(data.ratingUnitCount).toBe(4);
    expect(data.publishedRating).toBeNull();
    // The raw mean is still kept — it is the internal/staff number.
    expect(data.rating).toBe(5);
    // And the count is always honest, even while the score is withheld.
    expect(data.reviewCount).toBe(600);
  });

  it("publishes exactly at the threshold", async () => {
    const data = await score(
      Array.from({ length: MIN_RATED_UNITS_FOR_PUBLIC_SCORE }, (_, i) =>
        unit(`appointment:a${i}`, 4),
      ),
    );
    expect(data.publishedRating).toBe(4);
  });

  it("suppresses again if reviews are moderated away below the threshold", async () => {
    const data = await score([unit("appointment:a1", 5)]);
    expect(data.publishedRating).toBeNull();
  });

  it("leaves a consultant with no reviews at zero and unpublished", async () => {
    const data = await score([]);
    expect(data.rating).toBe(0);
    expect(data.reviewCount).toBe(0);
    expect(data.publishedRating).toBeNull();
  });
});

describe("rounding", () => {
  it("keeps two decimals rather than a repeating fraction", async () => {
    const data = await score([
      unit("appointment:a1", 5),
      unit("appointment:a2", 4),
      unit("appointment:a3", 4),
    ]);
    expect(data.rating).toBe(4.33);
  });
});
