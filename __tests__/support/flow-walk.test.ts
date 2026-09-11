/**
 * @jest-environment node
 */

/**
 * #support-hub — the pure flow-graph walk shared by the persisted appointment
 * threads and the stateless platform intake. No DB, no mocks: the whole point
 * of extracting this from FlowchartResolver is that both scopes execute the
 * exact same transitions, so a regression here breaks everywhere at once and
 * gets caught here first.
 */

import { walkFlow, type WalkableFlow } from "@/lib/support/flow-walk";

const flow: WalkableFlow = {
  entryNodeId: "start",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What happened?",
      options: [
        { id: "a", label: "Option A", next: "end-escalate" },
        { id: "b", label: "Option B", next: "end-resolved" },
      ],
    },
    "end-escalate": {
      id: "end-escalate",
      kind: "TERMINAL",
      body: "Escalating.",
      escalate: true,
      reason: "test_reason",
    },
    "end-resolved": {
      id: "end-resolved",
      kind: "TERMINAL",
      body: "Resolved.",
      resolved: true,
    },
  },
};

const ctx = { refundPctIfCancelledNow: null };

describe("walkFlow", () => {
  it("presents the entry prompt on a null cursor", () => {
    const r = walkFlow(flow, null, {}, ctx);
    expect(r.nextNodeId).toBe("start");
    expect(r.messages[0].metadata?.options).toHaveLength(2);
    expect(r.escalate).toBe(false);
  });

  it("advances to an escalating terminal and carries its machine-readable reason", () => {
    const r = walkFlow(flow, "start", { chosenOptionId: "a" }, ctx);
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe("test_reason");
    expect(r.nextNodeId).toBeNull();
  });

  it("resolves on the resolved terminal", () => {
    const r = walkFlow(flow, "start", { chosenOptionId: "b" }, ctx);
    expect(r.resolved).toBe(true);
    expect(r.escalate).toBe(false);
  });

  it("re-presents the same prompt on an unrecognized choice (idempotent)", () => {
    const r = walkFlow(flow, "start", { chosenOptionId: "bogus" }, ctx);
    expect(r.nextNodeId).toBe("start");
    expect(r.escalate).toBe(false);
  });

  it("fails safe to escalation on an unknown cursor", () => {
    const r = walkFlow(flow, "ghost-node", {}, ctx);
    expect(r.escalate).toBe(true);
    expect(r.nextNodeId).toBeNull();
  });

  it("resolves silently when the chosen option has no successor", () => {
    // `next: null` is how a flow says "that answer needs no reply" — it must
    // end the conversation without emitting a bubble, not fall through to the
    // unknown-node escalation.
    const endFlow: WalkableFlow = {
      entryNodeId: "start",
      nodes: {
        start: {
          id: "start",
          kind: "PROMPT",
          body: "Anything else?",
          options: [{ id: "no", label: "No", next: null }],
        },
      },
    };
    const r = walkFlow(endFlow, "start", { chosenOptionId: "no" }, ctx);
    expect(r.resolved).toBe(true);
    expect(r.escalate).toBe(false);
    expect(r.messages).toHaveLength(0);
  });

  it("escalates when an option points at a node that does not exist", () => {
    // A typo'd `next` is a flow-authoring bug. It must fail toward a human
    // rather than stranding the user on a cursor nothing can advance.
    const brokenFlow: WalkableFlow = {
      entryNodeId: "start",
      nodes: {
        start: {
          id: "start",
          kind: "PROMPT",
          body: "What happened?",
          options: [{ id: "a", label: "A", next: "gone" }],
        },
      },
    };
    const r = walkFlow(brokenFlow, "start", { chosenOptionId: "a" }, ctx);
    expect(r.escalate).toBe(true);
    expect(r.nextNodeId).toBeNull();
  });

  it("injects the context refund % into OFFER_CANCEL_REFUND terminals", () => {
    const refundFlow: WalkableFlow = {
      entryNodeId: "t",
      nodes: {
        t: {
          id: "t",
          kind: "TERMINAL",
          body: "Confirm.",
          action: { kind: "OFFER_CANCEL_REFUND", refundPct: 0 },
        },
      },
    };
    const r = walkFlow(refundFlow, null, {}, { refundPctIfCancelledNow: 75 });
    expect(r.actions).toEqual([{ kind: "OFFER_CANCEL_REFUND", refundPct: 75 }]);
  });
});

/**
 * The user's own side of the conversation.
 *
 * A chip press is an answer. If the walk does not report which option was
 * pressed, nothing downstream can record it — and the transcript becomes a run
 * of bot questions with no trace of the replies that produced them. That is
 * visible to the user in the sheet, and it is what a staff member reads in the
 * back-office inbox on an escalated thread, where knowing the outcome (the
 * terminal `reason`) is not the same as knowing the path taken to reach it.
 */
describe("walkFlow reports the chosen option label", () => {
  it("returns the label when advancing to another node", () => {
    const r = walkFlow(flow, "start", { chosenOptionId: "a" }, ctx);
    expect(r.chosenLabel).toBe("Option A");
  });

  it("returns the label on a terminal choice", () => {
    const r = walkFlow(flow, "start", { chosenOptionId: "b" }, ctx);
    expect(r.resolved).toBe(true);
    expect(r.chosenLabel).toBe("Option B");
  });

  it("returns no label for a free-text turn", () => {
    // Free text is recorded verbatim by the caller; there is no chip to name.
    const r = walkFlow(flow, "start", { userMessage: "it broke" }, ctx);
    expect(r.chosenLabel).toBeUndefined();
  });

  it("returns no label when the choice was not recognised", () => {
    // A re-presented prompt means nothing was accepted, so nothing was said.
    const r = walkFlow(flow, "start", { chosenOptionId: "bogus" }, ctx);
    expect(r.nextNodeId).toBe("start");
    expect(r.chosenLabel).toBeUndefined();
  });

  it("still reports the label when the option points at a missing node", () => {
    // The walk escalates, but the user did press something and it must show.
    const brokenFlow: WalkableFlow = {
      entryNodeId: "start",
      nodes: {
        start: {
          id: "start",
          kind: "PROMPT",
          body: "What happened?",
          options: [{ id: "a", label: "Broken link", next: "gone" }],
        },
      },
    };
    const r = walkFlow(brokenFlow, "start", { chosenOptionId: "a" }, ctx);
    expect(r.escalate).toBe(true);
    expect(r.chosenLabel).toBe("Broken link");
  });
});
