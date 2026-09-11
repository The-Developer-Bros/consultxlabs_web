/**
 * Every plan detail page must call the visibility gate.
 *
 * The pure predicate already had tests, but nothing asserted that the pages
 * USE it — so the webinar page shipped importing `canViewPlanDetail` and never
 * calling it, leaving ORG_ONLY and archived webinar plans readable by id. These
 * tests drive each page with a hidden plan and require a not-found.
 */

const notFoundError = new Error("NEXT_NOT_FOUND");

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw notFoundError;
  }),
}));

const mockCanViewPlanDetail = jest.fn();
jest.mock("../../lib/data/plan-viewable", () => ({
  canViewPlanDetail: (...args: unknown[]) => mockCanViewPlanDetail(...args),
}));

const mockGetConsultationPlanDetail = jest.fn();
const mockGetSubscriptionPlanDetail = jest.fn();
const mockGetWebinarPlanDetail = jest.fn();
const mockGetClassPlanDetail = jest.fn();
jest.mock("../../lib/data/plan-details", () => ({
  getConsultationPlanDetail: (...a: unknown[]) =>
    mockGetConsultationPlanDetail(...a),
  getSubscriptionPlanDetail: (...a: unknown[]) =>
    mockGetSubscriptionPlanDetail(...a),
  getWebinarPlanDetail: (...a: unknown[]) => mockGetWebinarPlanDetail(...a),
  getClassPlanDetail: (...a: unknown[]) => mockGetClassPlanDetail(...a),
}));

// The page modules import their presentational components, which drag in the
// whole UI tree. Stub them — these tests are about the gate, not the markup.
jest.mock(
  "../../app/explore/programs/plans/consultations/[consultationPlanId]/components/ConsultationDetails",
  () => ({ ConsultationDetails: () => null }),
);
jest.mock(
  "../../app/explore/programs/plans/subscriptions/[subscriptionPlanId]/components/SubscriptionDetails",
  () => ({ SubscriptionDetails: () => null }),
);
jest.mock(
  "../../app/explore/programs/plans/webinars/[webinarPlanId]/components/WebinarDetails",
  () => ({ WebinarDetails: () => null }),
);
jest.mock(
  "../../app/explore/programs/plans/classes/[classPlanId]/components/ClassDetails",
  () => ({ ClassDetails: () => null }),
);

/** An ORG_ONLY, archived plan — hidden under every rule the gate applies. */
const hiddenPlan = {
  id: "plan-1",
  visibility: "ORG_ONLY" as const,
  organizationId: "org-1",
  archivedAt: new Date("2026-01-01T00:00:00Z"),
  imageUrl: null,
  webinars: [],
};

const PAGES = [
  {
    name: "consultation",
    load: () =>
      require("../../app/explore/programs/plans/consultations/[consultationPlanId]/page"),
    fetcher: mockGetConsultationPlanDetail,
    params: { consultationPlanId: "plan-1" },
  },
  {
    name: "subscription",
    load: () =>
      require("../../app/explore/programs/plans/subscriptions/[subscriptionPlanId]/page"),
    fetcher: mockGetSubscriptionPlanDetail,
    params: { subscriptionPlanId: "plan-1" },
  },
  {
    name: "webinar",
    load: () =>
      require("../../app/explore/programs/plans/webinars/[webinarPlanId]/page"),
    fetcher: mockGetWebinarPlanDetail,
    params: { webinarPlanId: "plan-1" },
  },
  {
    name: "class",
    load: () =>
      require("../../app/explore/programs/plans/classes/[classPlanId]/page"),
    fetcher: mockGetClassPlanDetail,
    params: { classPlanId: "plan-1" },
  },
];

describe("plan detail pages apply canViewPlanDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(PAGES)(
    "$name page 404s a plan the gate rejects",
    async ({ load, fetcher, params }) => {
      fetcher.mockResolvedValue(hiddenPlan);
      mockCanViewPlanDetail.mockResolvedValue(false);

      const Page = load().default;

      await expect(Page({ params: Promise.resolve(params) })).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(mockCanViewPlanDetail).toHaveBeenCalledWith(hiddenPlan);
    },
  );

  it.each(PAGES)(
    "$name page renders a plan the gate allows",
    async ({ load, fetcher, params }) => {
      fetcher.mockResolvedValue(hiddenPlan);
      mockCanViewPlanDetail.mockResolvedValue(true);

      const Page = load().default;

      await expect(
        Page({ params: Promise.resolve(params) }),
      ).resolves.toBeDefined();
    },
  );
});
