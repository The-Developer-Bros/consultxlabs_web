/**
 * #support-hub — the pure, synchronous flow-graph walk shared by BOTH support
 * scopes: the persisted per-appointment threads (FlowchartResolver wraps this)
 * and the stateless platform intake (calls it directly, cursor held by the
 * client for the length of one sitting).
 *
 * No I/O, no persistence, money-adjacent-safe: it never performs an action,
 * only REQUESTS one (SupportAction) for the caller to validate and execute.
 * Unknown cursors / unrecognized choices fail safe (re-present, or escalate)
 * rather than dead-ending the user.
 */

import type { FlowNode, SupportTurnInput, SupportTurnResult } from "./types";

/** The structural shape both scopes share — appointment `FlowDefinition`s and
 *  platform `PlatformFlowDefinition`s are both WalkableFlows. */
export interface WalkableFlow {
  entryNodeId: string;
  nodes: Record<string, FlowNode>;
}

/** The only context facts the walk itself reads. Both SupportContext and the
 *  platform intake context satisfy this structurally. */
export type WalkContext = {
  /** Real refund % injected into OFFER_CANCEL_REFUND terminals. */
  refundPctIfCancelledNow: number | null;
};

/** Reply when the input matches no option at the current prompt. Names the
 *  escape hatch explicitly: "agent" is a HUMAN_KEYWORD (see escalation.ts), so
 *  a user the tree cannot serve is never cornered by it. */
const UNRECOGNIZED_BODY =
  'I didn\'t catch that. Pick one of the options below — or type "agent" to reach a person.';

/** Fail-safe escalation result for a broken/unknown cursor. */
function escalateFallback(body: string): SupportTurnResult {
  return {
    messages: [{ sender: "SYSTEM", body }],
    nextNodeId: null,
    actions: [],
    escalate: true,
    resolved: false,
  };
}

/** Emit one node: a PROMPT re-renders as tappable options; a TERMINAL emits
 *  its body + action/escalation/reason. */
function present(
  flow: WalkableFlow,
  nodeId: string,
  ctx: WalkContext,
): SupportTurnResult {
  const node = flow.nodes[nodeId];
  if (!node)
    return escalateFallback("Let me connect you with our support team.");

  if (node.kind === "PROMPT") {
    return {
      messages: [
        {
          sender: "BOT",
          body: node.body,
          metadata: {
            nodeId: node.id,
            options: node.options.map((o) => ({ id: o.id, label: o.label })),
          },
        },
      ],
      nextNodeId: node.id,
      actions: [],
      escalate: false,
      resolved: false,
    };
  }

  // TERMINAL. A cancel-refund action carries only a placeholder refundPct in
  // the static flow graph — inject the context's actual eligible % so the
  // caller (and the escalation policy) sees the real refund exposure.
  const action =
    node.action?.kind === "OFFER_CANCEL_REFUND"
      ? { ...node.action, refundPct: ctx.refundPctIfCancelledNow ?? 0 }
      : node.action;
  return {
    messages: [
      { sender: "BOT", body: node.body, metadata: { nodeId: node.id } },
    ],
    nextNodeId: null,
    actions: action ? [action] : [],
    escalate: node.escalate ?? false,
    resolved: node.resolved ?? false,
    reason: node.reason,
  };
}

/**
 * Advance one turn through `flow`. `currentNodeId` null = first turn (present
 * the entry prompt). On a PROMPT, resolves `chosenOptionId`; an unrecognized
 * choice idempotently re-presents the same prompt.
 */
export function walkFlow(
  flow: WalkableFlow,
  currentNodeId: string | null,
  input: SupportTurnInput,
  ctx: WalkContext,
): SupportTurnResult {
  const nodeId = currentNodeId ?? flow.entryNodeId;
  const node = flow.nodes[nodeId];
  if (!node) {
    return escalateFallback("Let me connect you with our support team.");
  }

  // First turn — just present the entry prompt.
  if (currentNodeId === null) {
    return present(flow, node.id, ctx);
  }

  if (node.kind === "PROMPT") {
    const chosen = node.options.find((o) => o.id === input.chosenOptionId);
    if (!chosen) {
      // Nothing matched. Re-emitting the identical prompt reads as the turn
      // being ignored — and once the caller suppresses it as a duplicate, the
      // user's message gets no reply at all. Answer instead, carrying the SAME
      // options so the chips stay live and the cursor stays put.
      return {
        messages: [
          {
            sender: "BOT",
            body: UNRECOGNIZED_BODY,
            metadata: {
              nodeId: node.id,
              options: node.options.map((o) => ({ id: o.id, label: o.label })),
            },
          },
        ],
        nextNodeId: node.id,
        actions: [],
        escalate: false,
        resolved: false,
        unrecognized: true,
      };
    }
    if (chosen.next === null) {
      // Choice ends the flow with no successor — treat as resolved.
      return {
        messages: [],
        nextNodeId: null,
        actions: [],
        escalate: false,
        resolved: true,
        chosenLabel: chosen.label,
      };
    }
    const nextNode = flow.nodes[chosen.next];
    if (!nextNode) {
      return {
        ...escalateFallback("Connecting you with support."),
        chosenLabel: chosen.label,
      };
    }
    return { ...present(flow, nextNode.id, ctx), chosenLabel: chosen.label };
  }

  // Already at a terminal — nothing further to advance.
  return present(flow, node.id, ctx);
}
