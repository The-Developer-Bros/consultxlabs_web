/**
 * @jest-environment node
 */

/**
 * #appt-support — the SELF_SERVE flowchart resolver + escalation policy. Pure
 * over the flow graph, so this needs no DB — exactly the property that makes the
 * deterministic channel cheap and safe on a money-adjacent surface.
 */

import { FlowchartResolver } from "@/lib/support/resolvers/flowchart-resolver";
import { flowForCategory, flowsForContext } from "@/lib/support/flows";
import { decideEscalation } from "@/lib/support/escalation";
import type { SupportContext } from "@/lib/support/types";

function ctx(overrides: Partial<SupportContext> = {}): SupportContext {
  return {
    threadId: "t1",
    appointmentId: "a1",
    userId: "u1",
    organizationId: null,
    appointmentType: "CONSULTATION" as SupportContext["appointmentType"],
    isOrgContext: false,
    isProvider: false,
    isOrgOperator: false,
    stage: "UPCOMING",
    startsAt: new Date("2026-08-01T10:00:00Z"),
    endsAt: new Date("2026-08-01T11:00:00Z"),
    refundPctIfCancelledNow: 100,
    paymentId: "pay1",
    paymentAmountPaise: 1000_00,
    hasRecording: false,
    ...overrides,
  };
}

describe("FlowchartResolver (SELF_SERVE)", () => {
  const cancelFlow = flowForCategory(ctx(), "CANCEL_REFUND")!;

  it("presents the entry prompt on the first turn", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), null, {});
    expect(turn.messages[0].sender).toBe("BOT");
    expect(turn.nextNodeId).toBe("start");
    expect(turn.messages[0].metadata?.options).toEqual([
      { id: "cancel", label: "Cancel and request a refund" },
      { id: "keep", label: "Never mind, keep it" },
    ]);
  });

  it("advances to a terminal that requests the cancel-refund action", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "start", { chosenOptionId: "cancel" });
    expect(turn.nextNodeId).toBeNull();
    // refundPct is injected from ctx.refundPctIfCancelledNow, not the placeholder.
    expect(turn.actions).toEqual([{ kind: "OFFER_CANCEL_REFUND", refundPct: 100 }]);
  });

  it("resolves cleanly when the user keeps the session", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "start", { chosenOptionId: "keep" });
    expect(turn.resolved).toBe(true);
    expect(turn.escalate).toBe(false);
  });

  it("re-presents (no crash) on an unrecognized choice", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "start", { chosenOptionId: "bogus" });
    expect(turn.nextNodeId).toBe("start");
  });

  it("fails safe to a human on an unknown cursor", async () => {
    const r = new FlowchartResolver(cancelFlow);
    const turn = await r.resolveTurn(ctx(), "nonexistent-node", {});
    expect(turn.escalate).toBe(true);
  });
});

describe("flow availability by context", () => {
  it("offers the B2B sponsorship flow only in an org context", () => {
    expect(
      flowsForContext(ctx({ isOrgContext: false })).map((f) => f.category),
    ).not.toContain("SPONSORSHIP_BILLING");
    expect(
      flowsForContext(ctx({ isOrgContext: true })).map((f) => f.category),
    ).toContain("SPONSORSHIP_BILLING");
  });

  it("stage-gates intents like an order state (Swiggy pattern)", () => {
    // Upcoming: cancel + reschedule + technical, no post-session intents.
    const upcoming = flowsForContext(ctx({ stage: "UPCOMING" })).map(
      (f) => f.category,
    );
    expect(upcoming).toContain("CANCEL_REFUND");
    expect(upcoming).toContain("RESCHEDULE");
    expect(upcoming).toContain("TECHNICAL");
    expect(upcoming).not.toContain("NO_SHOW");
    expect(upcoming).not.toContain("RECORDING_ACCESS");

    // Completed: post-session intents, no cancel/reschedule.
    const completed = flowsForContext(ctx({ stage: "COMPLETED" })).map(
      (f) => f.category,
    );
    expect(completed).not.toContain("CANCEL_REFUND");
    expect(completed).not.toContain("RESCHEDULE");
    expect(completed).toContain("NO_SHOW");
    expect(completed).toContain("RECORDING_ACCESS");
    expect(completed).toContain("QUALITY_COMPLAINT");

    // Payment status is offered at every stage.
    expect(upcoming).toContain("PAYMENT_STATUS");
    expect(completed).toContain("PAYMENT_STATUS");
  });

  it("picks the provider no-show variant for the delivering side", () => {
    const attendee = flowsForContext(ctx({ stage: "COMPLETED", isProvider: false }));
    const provider = flowsForContext(ctx({ stage: "COMPLETED", isProvider: true }));
    expect(attendee.find((f) => f.category === "NO_SHOW")?.title).toContain(
      "expert",
    );
    expect(provider.find((f) => f.category === "NO_SHOW")?.title).toContain(
      "participant",
    );
  });

  it("offers ORG_ADMIN_DISPUTE only to org operators", () => {
    const member = flowsForContext(
      ctx({ isOrgContext: true, isOrgOperator: false }),
    ).map((f) => f.category);
    const operator = flowsForContext(
      ctx({ isOrgContext: true, isOrgOperator: true }),
    ).map((f) => f.category);
    expect(member).not.toContain("ORG_ADMIN_DISPUTE");
    expect(operator).toContain("ORG_ADMIN_DISPUTE");
  });

  it("routes the org dispute flow: billing → self-serve, conduct → escalate", () => {
    const flow = flowForCategory(
      ctx({ isOrgContext: true, isOrgOperator: true }),
      "ORG_ADMIN_DISPUTE",
    )!;
    const billing = flow.nodes["billing"];
    const conduct = flow.nodes["conduct"];
    expect(billing?.kind).toBe("TERMINAL");
    expect(conduct?.kind).toBe("TERMINAL");
    if (billing?.kind !== "TERMINAL" || conduct?.kind !== "TERMINAL") return;
    expect(billing.resolved).toBe(true);
    expect(conduct.escalate).toBe(true);
    expect(conduct.reason).toBe("org_conduct_dispute");
  });

  it("carries machine-readable reasons on escalating terminals", () => {
    const flow = flowForCategory(
      ctx({ stage: "COMPLETED", isProvider: false }),
      "NO_SHOW",
    )!;
    const expert = flow.nodes["expert"];
    expect(expert.kind === "TERMINAL" && expert.reason).toBe("provider_no_show");
  });
});

describe("escalation policy", () => {
  const base = {
    messages: [],
    nextNodeId: null,
    actions: [],
    resolved: false,
    escalate: false,
  };

  it("escalates on a human keyword regardless of the flow", () => {
    const d = decideEscalation(ctx(), { ...base, escalate: false }, "I want to talk to a human");
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("keyword");
  });

  it("escalates when the flow terminal says so", () => {
    const d = decideEscalation(ctx(), { ...base, escalate: true }, "yes");
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("flow_terminal");
  });

  it("does not escalate an ordinary resolved turn", () => {
    const d = decideEscalation(ctx(), { ...base, escalate: false, resolved: true }, "ok thanks");
    expect(d.escalate).toBe(false);
  });

  it("escalates a refund whose exposure clears the threshold", () => {
    const turn = {
      ...base,
      actions: [{ kind: "OFFER_CANCEL_REFUND" as const, refundPct: 100 }],
    };
    const d = decideEscalation(
      ctx({ paymentAmountPaise: 1000_00 }),
      turn,
      "yes",
      { highValueRefundPaise: 500_00 },
    );
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("high_value_refund");
  });

  it("does not escalate a refund below the threshold", () => {
    const turn = {
      ...base,
      actions: [{ kind: "OFFER_CANCEL_REFUND" as const, refundPct: 50 }],
    };
    const d = decideEscalation(
      ctx({ paymentAmountPaise: 400_00 }),
      turn,
      "yes",
      { highValueRefundPaise: 500_00 },
    );
    expect(d.escalate).toBe(false);
  });
});
