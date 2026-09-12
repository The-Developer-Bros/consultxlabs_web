/**
 * @jest-environment node
 */

/**
 * The webinar GET returns `topics` as the `Topic` relation, and a plain
 * object in a `stringList` field crashed `StringListField`'s key derivation
 * (`item.slice`). The adapter must map the relation down to names.
 */

// Same boundary-mock as __tests__/plans/plan-archive-toggle.test.ts: adapters.ts
// pulls schemas/plans, which loads `bad-words` (ESM-only) through
// utils/contentValidation at import time, and lib/prisma via the plan
// services — neither matters to planOf's pure mapping.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../../utils/contentValidation", () => ({
  __esModule: true,
  hasDuplicates: () => false,
  containsGibberish: () => false,
  containsProfanity: () => false,
  isProfanityFree: () => true,
  isMeaningfulText: () => true,
  validateSensibleContent: () => true,
  cleanProfanity: (text: string) => text,
}));

import { OFFERING_ADAPTERS } from "@/components/offerings/editor/adapters";

describe("webinar adapter topic mapping", () => {
  it("maps mixed Topic-relation objects and plain strings to names", () => {
    const plan = OFFERING_ADAPTERS.webinar.planOf({
      webinarPlan: {
        price: 100000,
        topics: [{ id: "t1", name: "System Design" }, "Behavioural Interviews"],
      },
    });

    expect(plan?.topics).toEqual(["System Design", "Behavioural Interviews"]);
    expect(plan?.price).toBe(1000);
  });

  it("yields an empty array when topics is missing or empty", () => {
    expect(
      OFFERING_ADAPTERS.webinar.planOf({ webinarPlan: { price: 0 } })?.topics,
    ).toEqual([]);
    expect(
      OFFERING_ADAPTERS.webinar.planOf({
        webinarPlan: { price: 0, topics: [] },
      })?.topics,
    ).toEqual([]);
  });
});
