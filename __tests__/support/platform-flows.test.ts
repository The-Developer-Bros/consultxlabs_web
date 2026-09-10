/**
 * @jest-environment node
 */

/**
 * #support-hub — the platform flow registry + the shared reason→priority map.
 * Pure registry logic: availability gates (operator-only flows), the
 * reason→issueType taxonomy mapping, and priority policy. No DB.
 */

import {
  platformFlowsForContext,
  platformFlowForId,
  issueTypeForFlow,
  type PlatformSupportContext,
} from "@/lib/support/platform-flows";
import { priorityForReason } from "@/lib/support/priority";

function ctx(overrides: Partial<PlatformSupportContext> = {}): PlatformSupportContext {
  return {
    userId: "u1",
    isOperator: false,
    organizationIds: [],
    ...overrides,
  };
}

describe("platform flow availability", () => {
  it("hides the operator billing flow from non-operators", () => {
    const ids = platformFlowsForContext(ctx()).map((f) => f.id);
    expect(ids).not.toContain("ORG_OPERATOR_BILLING");
    expect(ids).toContain("PAYMENTS_BILLING");
    expect(ids).toContain("ACCOUNT_ACCESS");
    expect(ids).toContain("GENERAL");
  });

  it("offers the operator billing flow to operators", () => {
    const ids = platformFlowsForContext(ctx({ isOperator: true })).map(
      (f) => f.id,
    );
    expect(ids).toContain("ORG_OPERATOR_BILLING");
  });

  it("looks up a flow only when its gate passes", () => {
    expect(platformFlowForId(ctx(), "GENERAL")).toBeDefined();
    expect(platformFlowForId(ctx(), "ORG_OPERATOR_BILLING")).toBeUndefined();
    expect(
      platformFlowForId(ctx({ isOperator: true }), "ORG_OPERATOR_BILLING"),
    ).toBeDefined();
  });
});

describe("escalation taxonomy", () => {
  it("maps per-reason issue types over the flow default", () => {
    const payments = platformFlowForId(ctx(), "PAYMENTS_BILLING")!;
    expect(issueTypeForFlow(payments, "double_charge")).toBe("CHARGED_TWICE");
    expect(issueTypeForFlow(payments, "refund_missing")).toBe("REFUND_REQUEST");
    expect(issueTypeForFlow(payments, undefined)).toBe("BILLING_QUESTION");
    // An unknown reason falls back to the default, never throws.
    expect(issueTypeForFlow(payments, "something_new")).toBe(
      "BILLING_QUESTION",
    );
  });
});

describe("priorityForReason", () => {
  it("burns HIGH for money-integrity and no-show reasons", () => {
    expect(priorityForReason("provider_no_show")).toBe("HIGH");
    expect(priorityForReason("double_charge")).toBe("HIGH");
    expect(priorityForReason("high_value_refund")).toBe("HIGH");
  });

  it("defaults everything else to MEDIUM", () => {
    expect(priorityForReason("quality_poor")).toBe("MEDIUM");
    expect(priorityForReason("recording_missing")).toBe("MEDIUM");
    expect(priorityForReason(undefined)).toBe("MEDIUM");
  });
});
