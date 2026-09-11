/**
 * #appt-support — escalation triggers: when a thread must move to a HUMAN
 * regardless of the resolver's own decision. Research (Zendesk/Fini) shows an
 * explicit, context-carrying hand-off is the make-or-break of bot support.
 *
 * Kept separate from the resolvers so all three channels share one policy, and
 * so a money threshold or keyword can be tuned without touching flow graphs.
 */

import type { SupportContext, SupportTurnResult } from "./types";

/** User phrases that always warrant a human, independent of the flow. */
const HUMAN_KEYWORDS = [
  "human",
  "agent",
  "representative",
  "speak to someone",
  "complaint",
  "legal",
  "chargeback",
  "fraud",
];

/**
 * Does this message ask for a person? Exported so BOTH scopes can honour it —
 * the appointment thread reads it through `decideEscalation`, and the platform
 * intake calls it directly. Without that the unrecognized-input nudge, which
 * tells the user to type "agent", was a promise the platform drawer could not
 * keep: there is no thread there, so nothing was checking.
 */
export function mentionsHumanKeyword(text: string | undefined): boolean {
  const t = (text ?? "").toLowerCase();
  return !!t && HUMAN_KEYWORDS.some((k) => t.includes(k));
}

export interface EscalationDecision {
  escalate: boolean;
  reason?: string;
}

/**
 * Decide whether this turn should be escalated to a human. Combines:
 *   - the resolver's own `escalate` flag (a terminal escalate node),
 *   - explicit user keywords ("talk to a human", "complaint", …),
 *   - a high-value money trigger (large refund exposure warrants human review).
 */
export function decideEscalation(
  ctx: SupportContext,
  turn: SupportTurnResult,
  userMessage: string | undefined,
  opts: { highValueRefundPaise?: number } = {},
): EscalationDecision {
  if (turn.escalate) {
    return { escalate: true, reason: "flow_terminal" };
  }

  if (mentionsHumanKeyword(userMessage)) {
    return { escalate: true, reason: "keyword" };
  }

  // A refund action above the review threshold goes to a human even if the flow
  // would auto-resolve — money over the line gets a person. Size the exposure
  // from the captured amount × the eligible %, not the % alone.
  const threshold = opts.highValueRefundPaise ?? 500_00; // ₹500 default
  const refundAction = turn.actions.find(
    (a) => a.kind === "OFFER_CANCEL_REFUND" && a.refundPct > 0,
  );
  if (refundAction?.kind === "OFFER_CANCEL_REFUND" && ctx.paymentAmountPaise) {
    const refundExposurePaise =
      (ctx.paymentAmountPaise * refundAction.refundPct) / 100;
    if (refundExposurePaise >= threshold) {
      return { escalate: true, reason: "high_value_refund" };
    }
  }

  return { escalate: false };
}
