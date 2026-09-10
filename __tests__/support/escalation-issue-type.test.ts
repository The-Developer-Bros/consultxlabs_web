/**
 * @jest-environment node
 */

/**
 * An escalated appointment thread must produce a TYPED ticket.
 *
 * The per-appointment escalation path wrote its ticket directly, without an
 * `issueType` and without going through the shared factory. Two consequences:
 *
 *   1. Every session escalation reached the ops queue untyped — the Issue type
 *      column rendered "-", and staff could not filter for no-shows at all.
 *      All twelve members of SESSION_SCOPED_ISSUE_TYPES were therefore
 *      unreachable in the entire product, which made the platform form's 422
 *      guarding them a door to an empty room.
 *   2. Because it bypassed the factory it never called notifyStaff, so the
 *      user was told "our team will follow up here" and the team was never
 *      told.
 *
 * `issueTypeForReason` is the map that fixes (1); these pin it.
 */

import { issueTypeForReason, priorityForReason } from "@/lib/support/priority";
import { SESSION_SCOPED_ISSUE_TYPES } from "@/lib/support/create-ticket";

describe("issueTypeForReason", () => {
  it.each([
    ["provider_no_show", "CONSULTANT_NO_SHOW"],
    ["quality_ended_early", "SESSION_ENDED_EARLY"],
    ["quality_poor", "SESSION_QUALITY_POOR"],
    ["quality_wrong_expert", "WRONG_CONSULTANT"],
    ["quality_av", "COMMUNICATION_ISSUE"],
    ["technical_unresolved", "ACCESS_ISSUE"],
    ["timezone_mismatch", "TIMEZONE_CONFUSION"],
    ["documents_missing", "DOCUMENT_ISSUE"],
    ["documents_wrong", "DOCUMENT_ISSUE"],
    ["recording_missing", "DOCUMENT_ISSUE"],
  ])("maps %s to %s", (reason, expected) => {
    expect(issueTypeForReason(reason)).toBe(expected);
  });

  it("agrees with the platform intake on the money reasons", () => {
    // Same reason string, same queue meaning, whichever surface raised it —
    // otherwise "charged twice" means two different things to ops.
    expect(issueTypeForReason("payment_deducted_unconfirmed")).toBe("PAYMENT_FAILED");
    expect(issueTypeForReason("double_charge")).toBe("CHARGED_TWICE");
    expect(issueTypeForReason("refund_missing")).toBe("REFUND_REQUEST");
  });

  it("returns null for an unclassified reason rather than a catch-all", () => {
    // no_flow is free text straight to a human: genuinely unclassified, and it
    // should read that way in the queue rather than be filed as OTHER.
    expect(issueTypeForReason("no_flow")).toBeNull();
    // A provider reporting an absent consultee is NOT a consultant no-show —
    // the enum has no member for it, and typing it as one inverts the blame.
    expect(issueTypeForReason("attendee_no_show")).toBeNull();
    expect(issueTypeForReason(undefined)).toBeNull();
    expect(issueTypeForReason(null)).toBeNull();
    expect(issueTypeForReason("")).toBeNull();
  });

  it("never types a session escalation as a platform-only issue", () => {
    // The whole point: a reason raised from an appointment must resolve to a
    // type the platform form is forbidden to offer, or to a money type that
    // both surfaces legitimately share.
    const sessionReasons = [
      "provider_no_show",
      "quality_ended_early",
      "quality_poor",
      "quality_wrong_expert",
      "quality_av",
      "technical_unresolved",
      "timezone_mismatch",
      "documents_missing",
      "recording_missing",
    ];
    const sharedMoneyTypes = new Set(["PAYMENT_FAILED", "CHARGED_TWICE", "REFUND_REQUEST"]);
    for (const reason of sessionReasons) {
      const type = issueTypeForReason(reason);
      expect(type).not.toBeNull();
      expect(
        SESSION_SCOPED_ISSUE_TYPES.has(type!) || sharedMoneyTypes.has(type!),
      ).toBe(true);
    }
  });

  it("leaves the priority policy untouched", () => {
    // The two maps are independent: how hot it burns and what it is called.
    expect(priorityForReason("provider_no_show")).toBe("HIGH");
    expect(priorityForReason("double_charge")).toBe("HIGH");
    expect(priorityForReason("quality_poor")).toBe("MEDIUM");
  });
});
