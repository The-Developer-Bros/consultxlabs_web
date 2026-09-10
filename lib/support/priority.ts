/**
 * #support-hub — one reason→priority map for BOTH support scopes. Flow
 * terminals carry machine-readable `reason`s; this is the single place that
 * decides how hot the resulting ticket burns, so ops triage policy lives in
 * one reviewable line per reason.
 */

import type { SupportIssueType, SupportPriority } from "@prisma/client";

/** Reasons that page the queue at HIGH (money-integrity + no-show disputes). */
const HIGH_REASONS = new Set([
  "provider_no_show",
  "double_charge",
  "high_value_refund", // set by decideEscalation on large refund exposure
]);

/** Everything escalates at MEDIUM unless mapped otherwise here. */
export function priorityForReason(reason: string | null | undefined): SupportPriority {
  if (reason && HIGH_REASONS.has(reason)) return "HIGH";
  return "MEDIUM";
}

/**
 * Reason → `SupportIssueType` for the per-appointment escalation path.
 *
 * Without this the appointment path wrote tickets with `issueType: null`, so
 * every session escalation landed in the ops queue indistinguishable from a
 * billing question — the Issue type column rendered "-" and staff could not
 * filter for them. It also meant all twelve members of
 * SESSION_SCOPED_ISSUE_TYPES were unreachable in the entire product, and the
 * platform form's 422 guarding them was guarding a door to an empty room.
 *
 * The payment reasons deliberately map to the SAME types the platform intake
 * assigns (`platform-flows.ts` → `issueTypeByReason`), so "charged twice"
 * means one thing in the queue regardless of which surface it came from.
 */
const ISSUE_TYPE_BY_REASON: Readonly<Record<string, SupportIssueType>> = {
  // Attendance. Note there is deliberately NO entry for `attendee_no_show`:
  // that is the provider reporting an absent CONSULTEE, and the enum has no
  // member for it. Typing it CONSULTANT_NO_SHOW would invert the blame — a
  // consultant who turned up and reported the other side missing would appear
  // in the queue as the no-show. It resolves in-flow anyway ("the fee stays
  // with you"), so it reaches this map only via a policy escalation, where
  // unclassified is the honest answer.
  provider_no_show: "CONSULTANT_NO_SHOW",

  // Delivery quality
  quality_ended_early: "SESSION_ENDED_EARLY",
  quality_poor: "SESSION_QUALITY_POOR",
  quality_wrong_expert: "WRONG_CONSULTANT",
  quality_av: "COMMUNICATION_ISSUE",
  quality_other: "SESSION_QUALITY_POOR",

  // In-session technical trouble that the self-serve steps did not fix.
  technical_unresolved: "ACCESS_ISSUE",

  // Materials and recordings are both "I cannot get at the artefact".
  recording_missing: "DOCUMENT_ISSUE",
  recording_broken: "DOCUMENT_ISSUE",
  documents_missing: "DOCUMENT_ISSUE",
  documents_wrong: "DOCUMENT_ISSUE",

  // Scheduling
  timezone_mismatch: "TIMEZONE_CONFUSION",

  // Money — same mapping as the platform intake.
  payment_deducted_unconfirmed: "PAYMENT_FAILED",
  double_charge: "CHARGED_TWICE",
  refund_missing: "REFUND_REQUEST",
  high_value_refund: "REFUND_REQUEST",
  sponsorship_charge: "BILLING_QUESTION",

  // Org-party concerns are conduct/relationship, not a session defect.
  org_conduct_dispute: "GENERAL_INQUIRY",
  routed_org_disputes: "GENERAL_INQUIRY",
};

/**
 * Falls back to `null` rather than a catch-all: a reason nobody has classified
 * should read as unclassified in the queue, not be silently filed as OTHER.
 * `no_flow` (free-text straight to a human) lands here on purpose.
 */
export function issueTypeForReason(
  reason: string | null | undefined,
): SupportIssueType | null {
  if (!reason) return null;
  return ISSUE_TYPE_BY_REASON[reason] ?? null;
}
