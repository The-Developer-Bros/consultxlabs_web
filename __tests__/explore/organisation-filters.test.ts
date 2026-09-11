import {
  orgFiltersFromSearchParams,
  orgFiltersToSearchParams,
} from "@/lib/explore/organisation-filters";
import { shouldSkipUrlHydrate } from "@/lib/explore/url-hydrate-skip";

describe("orgFiltersFromSearchParams", () => {
  it("hydrates Expert networks nav links (?type=EXPERT_NETWORK)", () => {
    const params = new URLSearchParams("type=EXPERT_NETWORK");
    const filters = orgFiltersFromSearchParams(params);
    expect(filters.types).toEqual(["EXPERT_NETWORK"]);
    expect(orgFiltersToSearchParams(filters)).toBe("type=EXPERT_NETWORK");
  });

  it("round-trips repeated type params as repeated query keys", () => {
    const params = new URLSearchParams();
    params.append("type", "EXPERT_NETWORK");
    params.append("type", "LEARNING_INSTITUTION");
    const filters = orgFiltersFromSearchParams(params);
    expect(filters.types).toEqual([
      "EXPERT_NETWORK",
      "LEARNING_INSTITUTION",
    ]);
    const qs = orgFiltersToSearchParams(filters);
    expect(qs).toBe("type=EXPERT_NETWORK&type=LEARNING_INSTITUTION");
    expect(new URLSearchParams(qs).getAll("type")).toEqual([
      "EXPERT_NETWORK",
      "LEARNING_INSTITUTION",
    ]);
  });

  it("ignores unknown type values", () => {
    const params = new URLSearchParams("type=NOT_A_REAL_TYPE");
    expect(orgFiltersFromSearchParams(params).types).toEqual([]);
  });
});

describe("shouldSkipUrlHydrate", () => {
  it("does not skip when nothing was self-written", () => {
    expect(shouldSkipUrlHydrate(null, "type=EXPERT_NETWORK")).toEqual({
      skip: false,
      nextPending: null,
    });
  });

  it("skips only when the inbound query matches the pending self-write", () => {
    expect(
      shouldSkipUrlHydrate("type=EXPERT_NETWORK", "type=EXPERT_NETWORK"),
    ).toEqual({ skip: true, nextPending: null });
  });

  it("hydrates and clears pending when an external URL arrives first", () => {
    // Boolean-flag race: self-write pending, then soft-nav changes the URL.
    // Matching the written QS (not a boolean) must NOT consume the skip.
    expect(
      shouldSkipUrlHydrate(
        "type=EXPERT_NETWORK",
        "type=LEARNING_INSTITUTION",
      ),
    ).toEqual({ skip: false, nextPending: null });
  });
});
