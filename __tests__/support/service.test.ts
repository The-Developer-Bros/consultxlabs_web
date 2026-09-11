/**
 * @jest-environment node
 */

/**
 * #appt-support — the orchestrator (runSupportTurn). Mocks prisma + the context
 * builder so this exercises the thread lifecycle wiring: present → advance →
 * resolve, and the escalation hand-off that must create/link a SupportTicket and
 * flip the channel to HUMAN. The resolver/escalation decision logic itself is
 * covered by flowchart-resolver.test.ts.
 */

import type { SupportContext } from "@/lib/support/types";

// jest.mock is hoisted above imports AND local consts, so the factory must build
// the mocks inline (no outer refs → no TDZ). jest.mock resolves via jest's own
// resolver (moduleNameMapper is off) so these use relative paths, even though the
// imports below use the `@/` TS alias.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: jest.fn() },
    appointmentSupportThread: {
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    supportMessage: { create: jest.fn() },
    supportTicket: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    supportTicketCounter: { upsert: jest.fn() },
    user: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../lib/support/context", () => ({
  __esModule: true,
  buildSupportContext: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { buildSupportContext } from "@/lib/support/context";
import { runSupportTurn } from "@/lib/support/service";

const mockPrisma = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  appointmentSupportThread: {
    upsert: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  supportMessage: { create: jest.Mock };
  supportTicket: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  supportTicketCounter: { upsert: jest.Mock };
  user: { findMany: jest.Mock };
  $transaction: jest.Mock;
};
const mockBuildContext = buildSupportContext as unknown as jest.Mock;

function ctx(overrides: Partial<SupportContext> = {}): SupportContext {
  return {
    threadId: "thread1",
    appointmentId: "appt1",
    userId: "user1",
    organizationId: null,
    appointmentType: "CONSULTATION" as SupportContext["appointmentType"],
    isOrgContext: false,
    isProvider: false,
    isOrgOperator: false,
    stage: "UPCOMING",
    startsAt: new Date("2026-09-01T10:00:00Z"),
    endsAt: new Date("2026-09-01T11:00:00Z"),
    refundPctIfCancelledNow: 100,
    paymentId: "pay1",
    paymentAmountPaise: 200_00,
    hasRecording: false,
    planTitle: null,
    ...overrides,
  };
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread1",
    appointmentId: "appt1",
    userId: "user1",
    organizationId: null,
    category: "CANCEL_REFUND",
    status: "OPEN",
    activeChannel: "SELF_SERVE",
    currentNodeId: null,
    supportTicketId: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.appointment.findUnique.mockResolvedValue({ organizationId: null });
  mockBuildContext.mockResolvedValue(ctx());
  // Interactive transaction — run the callback against the same mock surface;
  // array form (persistHumanTurn) resolves each element.
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg as Promise<unknown>[])
      : (arg as (tx: unknown) => unknown)(mockPrisma),
  );
  mockPrisma.supportMessage.create.mockResolvedValue({});
  // #705 — the thread row is also the message-sequence allocator, so every
  // write path reads `messageSeq` back off this update.
  mockPrisma.appointmentSupportThread.update.mockResolvedValue({
    messageSeq: 0,
  });
  mockPrisma.appointmentSupportThread.updateMany.mockResolvedValue({
    count: 1,
  });
  mockPrisma.appointmentSupportThread.findUniqueOrThrow.mockResolvedValue({
    status: "ESCALATED",
    messageSeq: 0,
  });
  mockPrisma.supportTicketCounter.upsert.mockResolvedValue({ nextSeq: 2 });
  mockPrisma.supportTicket.findUnique.mockResolvedValue(null);
  mockPrisma.supportTicket.update.mockResolvedValue({});
  mockPrisma.user.findMany.mockResolvedValue([]);
});

describe("runSupportTurn", () => {
  it("returns 404-null when the appointment is gone", async () => {
    mockPrisma.appointment.findUnique.mockResolvedValueOnce(null);
    const r = await runSupportTurn("missing", "user1", {
      category: "CANCEL_REFUND",
    });
    expect(r).toBeNull();
  });

  it("presents the entry prompt on the first turn (IN_PROGRESS, no action)", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ currentNodeId: null }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      category: "CANCEL_REFUND",
    });
    expect(r?.status).toBe("IN_PROGRESS");
    expect(r?.currentNodeId).toBe("start");
    expect(r?.escalated).toBe(false);
    expect(r?.messages[0]?.sender).toBe("BOT");
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
  });

  it("advances to the cancel terminal and requests OFFER_CANCEL_REFUND with the ctx refund %", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ currentNodeId: "start" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });
    expect(r?.actions).toEqual([
      { kind: "OFFER_CANCEL_REFUND", refundPct: 100 },
    ]);
  });

  it("escalates on a human keyword: creates a SupportTicket and flips to HUMAN", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ currentNodeId: "start" }),
    );
    mockPrisma.supportTicket.create.mockResolvedValue({ id: "ticket1" });

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "keep",
      userMessage: "actually I want to talk to a human",
    });

    expect(r?.escalated).toBe(true);
    expect(r?.activeChannel).toBe("HUMAN");
    expect(r?.supportTicketId).toBe("ticket1");
    expect(mockPrisma.supportTicket.create).toHaveBeenCalledTimes(1);
    // updateMany, not update: the flip is compare-and-set so a thread staff
    // have CLOSED cannot be reopened into a second ticket.
    expect(mockPrisma.appointmentSupportThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "CLOSED" } }),
        data: expect.objectContaining({
          status: "ESCALATED",
          activeChannel: "HUMAN",
        }),
      }),
    );
  });

  it("does not create a second ticket when one is already linked", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ activeChannel: "HUMAN", supportTicketId: "ticket-existing" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "any update?",
    });
    expect(r?.activeChannel).toBe("HUMAN");
    expect(r?.supportTicketId).toBe("ticket-existing");
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
  });

  it("refuses the write when the CAS matches no row, and says so", async () => {
    // The concurrent case: staff close the thread between the read and the
    // write, so `persistHumanTurn`'s guarded updateMany matches nothing. The
    // contract is `accepted: false` plus the thread's REAL status, and no
    // message row — SupportThreadSheet keys its "your message wasn't sent"
    // recovery on exactly `accepted === false`, so this branch silently
    // regressing is what puts a delivered-looking bubble on a closed thread.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ activeChannel: "HUMAN", supportTicketId: "ticket-existing" }),
    );
    mockPrisma.appointmentSupportThread.updateMany.mockResolvedValue({
      count: 0,
    });
    mockPrisma.appointmentSupportThread.findUniqueOrThrow.mockResolvedValue({
      status: "CLOSED",
      messageSeq: 7,
    });

    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "are you still there?",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.status).toBe("CLOSED");
    expect(mockPrisma.supportMessage.create).not.toHaveBeenCalled();
  });

  it("routes an OTHER intent (no self-serve flow) straight to a human", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "OTHER" }),
    );
    mockPrisma.supportTicket.create.mockResolvedValue({ id: "ticket2" });
    const r = await runSupportTurn("appt1", "user1", { category: "OTHER" });
    expect(r?.escalated).toBe(true);
    expect(mockPrisma.supportTicket.create).toHaveBeenCalledTimes(1);
  });

  it("restarts at the entry when the persisted cursor no longer exists (flow-version drift)", async () => {
    // Pre-hub threads carry cursors from older registry revisions; a ghost
    // cursor used to make every choice mismatch and re-present forever.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", currentNodeId: "ghost-node" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });
    expect(r?.currentNodeId).toBe("start"); // presented the CURRENT entry…
    expect(r?.escalated).toBe(false); // …not failed safe to a human
    expect(mockPrisma.supportMessage.create).toHaveBeenCalledTimes(1);
  });

  it("answers instead of going silent when nothing matched, keeping the chips live", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", currentNodeId: "start" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "bogus",
    });
    expect(r?.currentNodeId).toBe("start"); // cursor did not move
    // Exactly one bubble, and it is NOT a verbatim repeat of the prompt: this
    // used to persist nothing at all, so a user who typed at a prompt watched
    // their message land and the bot say nothing back.
    const bodies = mockPrisma.supportMessage.create.mock.calls.map(
      (c) => c[0].data,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].sender).toBe("BOT");
    expect(bodies[0].body).toMatch(/didn't catch that/i);
    // The options ride along, or the prompt becomes a dead end — no buttons,
    // and free text cannot advance it.
    expect(bodies[0].metadata.options.length).toBeGreaterThan(0);
    expect(bodies[0].metadata.nodeId).toBe("start");
  });

  it("records the intent chip as the user's first message", async () => {
    // The walk can only name an option it matched, and the entry present()
    // matches nothing — so the transcript opened with a bot prompt and no
    // record of what the user had actually asked for.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", currentNodeId: null }),
    );
    await runSupportTurn("appt1", "user1", { category: "CANCEL_REFUND" });
    const written = mockPrisma.supportMessage.create.mock.calls.map(
      (c) => c[0].data,
    );
    expect(written[0].sender).toBe("USER");
    expect(written[0].body).toBeTruthy();
    expect(written[1].sender).toBe("BOT");
  });

  it("does not scold the user for typing the word the nudge told them to type", async () => {
    // "agent" matches no option, so the walk emits "I didn't catch that…" —
    // which is the very copy telling them to type "agent". Escalating while
    // persisting that message left the transcript contradicting itself one line
    // above the hand-off.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", currentNodeId: "start" }),
    );
    mockPrisma.supportTicket.create.mockResolvedValue({
      id: "t-kw",
      title: "T",
      organizationId: null,
      referenceNumber: "FAM-2026-000001",
    });
    const r = await runSupportTurn("appt1", "user1", { userMessage: "agent" });
    expect(r?.escalated).toBe(true);

    const bodies = mockPrisma.supportMessage.create.mock.calls.map(
      (c) => c[0].data,
    );
    // The user's own words are still recorded…
    expect(bodies.some((b) => b.sender === "USER" && b.body === "agent")).toBe(
      true,
    );
    // …but nothing tells them it wasn't understood.
    expect(bodies.some((b) => /didn't catch that/i.test(b.body))).toBe(false);
  });

  it("clicking the active intent chip restarts the flow at its entry", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", currentNodeId: "confirm" }),
    );
    const r = await runSupportTurn("appt1", "user1", {
      category: "CANCEL_REFUND",
    });
    expect(r?.currentNodeId).toBe("start");
    expect(r?.status).toBe("IN_PROGRESS");
  });

  it("clamps an org party to the org-party intents (defensive, route 403s first)", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "OTHER", currentNodeId: null }),
    );
    mockBuildContext.mockResolvedValue(
      ctx({ isOrgContext: true, isOrgOperator: true, organizationId: "org1" }),
    );

    // A participant-only intent reaching the service from an org party is
    // clamped to ORG_ADMIN_DISPUTE — which has a self-serve flow, so the turn
    // proceeds on THAT flow instead of the smuggled one.
    const r = await runSupportTurn("appt1", "user1", {
      category: "CANCEL_REFUND",
      isOrgParty: true,
    });
    expect(r?.escalated).toBe(false);
    // The clamped flow self-serves — no ticket may be filed for the smuggled
    // intent.
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
    // The self-serve status write is a GUARDED updateMany, not a bare update.
    expect(mockPrisma.appointmentSupportThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "ORG_ADMIN_DISPUTE" }),
      }),
    );
  });

  it("refuses a self-serve turn on a CLOSED thread instead of reopening it", async () => {
    // The asymmetry that made this reachable: `persistHumanTurn` has always
    // CAS'd, so an escalated message could not land on a settled thread, while
    // the self-serve path wrote `status` unconditionally and quietly reopened
    // what staff had closed. Same door, two rules.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", status: "CLOSED" }),
    );
    mockPrisma.appointmentSupportThread.updateMany.mockResolvedValue({
      count: 0,
    });
    mockPrisma.appointmentSupportThread.findUniqueOrThrow.mockResolvedValue({
      status: "CLOSED",
      messageSeq: 3,
    });

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.status).toBe("CLOSED");
    // Nothing is echoed back: a bot reply rendered for a turn that rolled back
    // is how a refused message ends up looking delivered.
    expect(r?.messages).toEqual([]);
    expect(r?.resolved).toBe(false);
    // The whole point of CAS-ing first: the refusal wrote NOTHING. The
    // assertions above pass just as well when the messages were inserted and
    // then survived a `return false`, which is the regression this test exists
    // for.
    expect(mockPrisma.supportMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
  });

  it("still lets a RESOLVED thread be picked up again", async () => {
    // Deliberately NOT refused. RESOLVED means the bot answered the question;
    // with one thread per booking, refusing it would leave someone who
    // resolved one question unable to ask a second.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", status: "RESOLVED" }),
    );

    const r = await runSupportTurn("appt1", "user1", {
      chosenOptionId: "cancel",
    });

    expect(r?.accepted).not.toBe(false);
    expect(mockPrisma.appointmentSupportThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "CLOSED" } }),
      }),
    );
  });

  it("refuses an ESCALATING turn on a CLOSED thread, and mints no second ticket", async () => {
    // The third door. The self-serve path and `persistHumanTurn` both CAS'd;
    // `escalate()` did not, so any intent chip reopened a thread staff had
    // closed — and worse than on the other two paths, because closing clears
    // `supportTicketId`, so the reopen ALSO minted a second ticket with its own
    // reference and its own SLA clock while the first sat resolved in the queue.
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "CANCEL_REFUND", status: "CLOSED" }),
    );
    mockPrisma.appointmentSupportThread.updateMany.mockResolvedValue({
      count: 0,
    });
    mockPrisma.appointmentSupportThread.findUniqueOrThrow.mockResolvedValue({
      status: "CLOSED",
      activeChannel: "SELF_SERVE",
      currentNodeId: null,
      supportTicketId: null,
      messageSeq: 3,
    });

    const r = await runSupportTurn("appt1", "user1", {
      userMessage: "I want to speak to a human",
    });

    expect(r?.accepted).toBe(false);
    expect(r?.escalated).toBe(false);
    expect(r?.status).toBe("CLOSED");
    // The thread keeps whatever ticket it had — no new link, nothing echoed.
    expect(r?.supportTicketId).toBeNull();
    expect(r?.messages).toEqual([]);
    // And nothing landed: no transcript row, no second ticket minted.
    expect(mockPrisma.supportMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.supportTicket.create).not.toHaveBeenCalled();
    // And the guard was actually expressed in the WHERE, not checked in JS.
    expect(mockPrisma.appointmentSupportThread.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "CLOSED" } }),
      }),
    );
  });

  it("attributes the escalated ticket to the thread's organization", async () => {
    mockPrisma.appointmentSupportThread.upsert.mockResolvedValue(
      threadRow({ category: "NO_SHOW", currentNodeId: "start" }),
    );
    mockBuildContext.mockResolvedValue(
      ctx({
        isOrgContext: true,
        isOrgOperator: false,
        organizationId: "org9",
        stage: "COMPLETED",
        paymentId: "pay9",
      }),
    );
    mockPrisma.supportTicket.create.mockResolvedValue({ id: "ticket4" });

    await runSupportTurn("appt1", "user1", { chosenOptionId: "expert" });
    expect(mockPrisma.supportTicket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org9",
          priority: "HIGH", // provider_no_show maps HIGH in the shared policy
        }),
      }),
    );
  });
});
