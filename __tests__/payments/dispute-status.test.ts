/**
 * @jest-environment node
 */

/**
 * Pins the dispute state machine after the CLOSED terminal landed (backlog
 * triage PR): Razorpay's `closed` is an ended-without-verdict terminal, so it
 * must be reachable from the live states, emit nothing, and never be re-driven
 * by a delayed or replayed webhook.
 */

import {
  isLegalDisputeTransition,
  mapDisputeStatus,
  TERMINAL_DISPUTE_STATUSES,
} from "@/lib/payments/dispute-status";

describe("isLegalDisputeTransition", () => {
  it("treats CLOSED as terminal alongside WON/LOST/CHARGE_REFUNDED", () => {
    expect(TERMINAL_DISPUTE_STATUSES).toEqual(
      expect.arrayContaining(["WON", "LOST", "CHARGE_REFUNDED", "CLOSED"]),
    );
    for (const next of [
      "NEEDS_RESPONSE",
      "UNDER_REVIEW",
      "WON",
      "LOST",
    ] as const) {
      expect(isLegalDisputeTransition("CLOSED", next)).toBe(false);
    }
  });

  it("allows both live states to close without a verdict", () => {
    expect(isLegalDisputeTransition("NEEDS_RESPONSE", "CLOSED")).toBe(true);
    expect(isLegalDisputeTransition("UNDER_REVIEW", "CLOSED")).toBe(true);
  });

  it("keeps warnings out of CLOSED — early warnings end via WARNING_CLOSED", () => {
    expect(isLegalDisputeTransition("WARNING_NEEDS_RESPONSE", "CLOSED")).toBe(
      false,
    );
    expect(isLegalDisputeTransition("WARNING_UNDER_REVIEW", "CLOSED")).toBe(
      false,
    );
  });

  it("rejects re-driving any terminal verdict (replayed webhook)", () => {
    for (const from of TERMINAL_DISPUTE_STATUSES) {
      expect(isLegalDisputeTransition(from, "NEEDS_RESPONSE")).toBe(false);
    }
  });

  it("stays idempotent on same-status redelivery", () => {
    expect(isLegalDisputeTransition("CLOSED", "CLOSED")).toBe(true);
    expect(isLegalDisputeTransition("UNDER_REVIEW", "UNDER_REVIEW")).toBe(true);
  });
});

describe("mapDisputeStatus", () => {
  it("maps Razorpay's terminal `closed` to CLOSED, not a live state", () => {
    expect(mapDisputeStatus("closed")).toBe("CLOSED");
  });

  it("maps Razorpay's opening `open` explicitly to NEEDS_RESPONSE", () => {
    expect(mapDisputeStatus("open")).toBe("NEEDS_RESPONSE");
  });

  it("returns null for unknown statuses instead of coercing to a live state", () => {
    expect(mapDisputeStatus("prevented")).toBeNull();
    expect(mapDisputeStatus("some_future_status")).toBeNull();
    expect(mapDisputeStatus("")).toBeNull();
  });

  it("is case-insensitive on gateway casing drift", () => {
    expect(mapDisputeStatus("CLOSED")).toBe("CLOSED");
    expect(mapDisputeStatus("Under_Review")).toBe("UNDER_REVIEW");
  });
});
