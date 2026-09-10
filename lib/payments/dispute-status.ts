/**
 * Dispute state-machine guard (#776).
 *
 * The gateway dispute webhook used to write `Dispute.status` unconditionally, so
 * a delayed/out-of-order delivery (or a manual resend) could record an illegal
 * transition — most importantly re-driving a TERMINAL dispute (WON/LOST/
 * CHARGE_REFUNDED), which re-runs the lost-dispute side effects (earnings→REFUNDED,
 * `applyOrgChargeback`). Money is already protected by ledger idempotency, but the
 * state model + audit trail are not. This guard keeps the machine honest.
 *
 * Transitions mirror Stripe/Razorpay dispute lifecycles: early-fraud WARNING_*
 * states can escalate into a real dispute (NEEDS_RESPONSE), which moves to
 * UNDER_REVIEW and then a terminal verdict. Terminal states are final.
 */
import type { DisputeStatus } from "@prisma/client";

/** Verdicts that must never transition again. */
export const TERMINAL_DISPUTE_STATUSES: DisputeStatus[] = [
  "WON",
  "LOST",
  "CHARGE_REFUNDED",
  "CLOSED",
];

/**
 * #1019 — statuses that must NOT block an app refund or an appointment mutation.
 * The terminal verdicts plus WARNING_CLOSED: a closed early-fraud warning is
 * treated as resolved (handleDisputeUpdated already releases held earnings on
 * it). It can re-escalate to NEEDS_RESPONSE later, but the refundable
 * computation nets a subsequent LOST/CHARGE_REFUNDED at that point, so a
 * resolved warning must not strand a legitimate refund or freeze the
 * appointment. Active warnings (WARNING_NEEDS_RESPONSE / WARNING_UNDER_REVIEW)
 * are deliberately absent — those still block while under review.
 */
export const DISPUTE_INACTIVE_FOR_GATING: DisputeStatus[] = [
  ...TERMINAL_DISPUTE_STATUSES,
  "WARNING_CLOSED",
];

/** Allowed forward transitions. Same-status is handled separately (idempotent). */
const ALLOWED: Record<DisputeStatus, DisputeStatus[]> = {
  WARNING_NEEDS_RESPONSE: [
    "WARNING_UNDER_REVIEW",
    "WARNING_CLOSED",
    "NEEDS_RESPONSE",
  ],
  WARNING_UNDER_REVIEW: ["WARNING_CLOSED", "NEEDS_RESPONSE"],
  // A closed early-warning can still escalate into a formal dispute later.
  WARNING_CLOSED: ["NEEDS_RESPONSE"],
  NEEDS_RESPONSE: ["UNDER_REVIEW", "WON", "LOST", "CHARGE_REFUNDED", "CLOSED"],
  UNDER_REVIEW: ["WON", "LOST", "CHARGE_REFUNDED", "CLOSED"],
  // Terminal verdicts — no outgoing transitions. CLOSED is Razorpay's
  // ended-without-verdict terminal (refund issued / details provided).
  WON: [],
  LOST: [],
  CHARGE_REFUNDED: [],
  CLOSED: [],
};

/**
 * True when `from → to` is a legal dispute transition. Same-status returns true
 * (idempotent), but callers should short-circuit on equality to avoid re-running
 * resolution side effects on a webhook redelivery.
 */
/**
 * #677/PM-37 — evidence-submission deadline guard. Status-blind on purpose:
 * the route's terminal-status gate handles WON/LOST separately; this only
 * answers "is the evidence window still open". Null dueBy (deadline unknown)
 * never blocks — Stripe's own rejection remains the backstop.
 */
export interface EvidenceDeadlineInput {
  status: DisputeStatus;
  dueBy: Date | null;
  nowMs: number;
}

export function evidenceDeadlinePassed(
  input: EvidenceDeadlineInput,
): boolean {
  return !!input.dueBy && input.dueBy.getTime() < input.nowMs;
}

export function isLegalDisputeTransition(
  from: DisputeStatus,
  to: DisputeStatus,
): boolean {
  if (from === to) return true;
  if (TERMINAL_DISPUTE_STATUSES.includes(from)) return false;
  return ALLOWED[from]?.includes(to) ?? false;
}

/**
 * Collapse a raw gateway dispute status (Razorpay/Stripe vocabulary) onto
 * our DisputeStatus enum. Lives next to the transition guard so the mapping
 * and the machine evolve together (and stay unit-testable without the
 * webhook module graph).
 */
export function mapDisputeStatus(
  status: string,
): DisputeStatus | null {
  switch (status.toLowerCase()) {
    case "warning_needs_response":
      return "WARNING_NEEDS_RESPONSE";
    case "warning_under_review":
      return "WARNING_UNDER_REVIEW";
    case "warning_closed":
      return "WARNING_CLOSED";
    // Razorpay opens a dispute as `open`; it is the same live state as
    // Stripe's needs_response on our machine.
    case "open":
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "under_review":
      return "UNDER_REVIEW";
    case "charge_refunded":
      return "CHARGE_REFUNDED";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    // Razorpay `closed` is its own terminal: proceedings ended without a
    // win/loss verdict (refund issued or details provided). Without this
    // case it fell to `default` and a resolved dispute re-entered
    // NEEDS_RESPONSE — or was rejected as a backward transition and never
    // reached a terminal state.
    case "closed":
      return "CLOSED";
    // An unmapped status must not silently coerce into a live state — the
    // update path skips it (a coerced NEEDS_RESPONSE could mis-advance a
    // warning-cluster dispute); the create path falls back to the
    // protective NEEDS_RESPONSE hold explicitly at the call site.
    default:
      return null;
  }
}
