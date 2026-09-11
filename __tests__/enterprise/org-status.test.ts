/**
 * @jest-environment node
 */

/**
 * Issue #699 ENT-3: org-status helpers — single source of truth for
 * "is this org billable" / "is onboarding blocked" filters.
 */

import {
  ADDRESSABLE_ORG_STATUSES,
  BILLABLE_ORG_STATUSES,
  OPERATIONAL_ORG_STATUSES,
  isBillable,
  isOnboardingBlocked,
} from "@/lib/enterprise/org-status";

describe("org-status helpers", () => {
  it("BILLABLE only includes ACTIVE — pending/suspended/deactivated do NOT bill", () => {
    expect(BILLABLE_ORG_STATUSES).toEqual(["ACTIVE"]);
  });

  it("OPERATIONAL allows PENDING_VERIFICATION + ACTIVE — not SUSPENDED/DEACTIVATED", () => {
    expect(OPERATIONAL_ORG_STATUSES.sort()).toEqual(
      ["ACTIVE", "PENDING_VERIFICATION"].sort(),
    );
  });

  it("ADDRESSABLE includes SUSPENDED so OWNERs can resolve issues", () => {
    expect(ADDRESSABLE_ORG_STATUSES).toContain("SUSPENDED");
    expect(ADDRESSABLE_ORG_STATUSES).not.toContain("DEACTIVATED");
  });

  it("isOnboardingBlocked: SUSPENDED + DEACTIVATED block, others allow", () => {
    expect(isOnboardingBlocked("SUSPENDED")).toBe(true);
    expect(isOnboardingBlocked("DEACTIVATED")).toBe(true);
    expect(isOnboardingBlocked("ACTIVE")).toBe(false);
    expect(isOnboardingBlocked("PENDING_VERIFICATION")).toBe(false);
  });

  it("isBillable: only ACTIVE", () => {
    expect(isBillable("ACTIVE")).toBe(true);
    expect(isBillable("PENDING_VERIFICATION")).toBe(false);
    expect(isBillable("SUSPENDED")).toBe(false);
    expect(isBillable("DEACTIVATED")).toBe(false);
  });
});
