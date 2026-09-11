import {
  humanizeOrgError,
  ORG_ERROR_COPY,
} from "@/lib/labels/org-errors";

describe("humanizeOrgError", () => {
  it("maps known codes to human copy", () => {
    expect(humanizeOrgError("ORG_NOT_VERIFIED")).toBe(
      ORG_ERROR_COPY.ORG_NOT_VERIFIED,
    );
    expect(humanizeOrgError("ROLE_TRANSITION_BLOCKED")).toBe(
      ORG_ERROR_COPY.ROLE_TRANSITION_BLOCKED,
    );
  });

  it("passes unknown strings through unchanged", () => {
    expect(humanizeOrgError("Something went wrong on the server")).toBe(
      "Something went wrong on the server",
    );
  });

  it("never returns undefined for a present input", () => {
    expect(humanizeOrgError("")).toBe("");
  });
});
