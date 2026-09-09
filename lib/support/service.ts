/**
 * #appt-support — the orchestrator that ties the channel-agnostic resolver core
 * to persistence. One entry point (`runSupportTurn`) drives a per-appointment
 * thread forward one turn: find-or-create the thread, build the shared context,
 * run the active channel's resolver, persist the exchange, advance the cursor,
 * and — on escalation — hand off to a HUMAN by linking the existing ops
 * SupportTicket queue (no parallel system).
 *
 * Money actions are only ever REQUESTED here (returned as `actions`); execution
 * is a separate, server-validated seam — a refund never fires from a flow graph.
 */

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import type {
  SupportChannel,
  SupportThreadCategory,
  SupportThreadStatus,
} from "@prisma/client";
import { buildSupportContext } from "./context";
import { flowForCategory } from "./flows";
import { FlowchartResolver } from "./resolvers/flowchart-resolver";
import { decideEscalation } from "./escalation";
import { issueTypeForReason, priorityForReason } from "./priority";
import {
  notifySupportStaff,
  notifyStaffOfTicketActivity,
} from "./create-ticket";
import { allocateMessageSeq } from "./message-seq";
import { recordFlowOutcome } from "./deflection";
import { allocateTicketReference } from "./reference";
import { slaDeadlinesFor, userRepliedPatch } from "./sla";
import type { SupportAction, SupportContext, SupportTurnResult } from "./types";

export interface RunTurnInput {
  /** Chosen intent — set on the first turn (or to switch intents). */
  category?: SupportThreadCategory;
  /** A selected flowchart option id (SELF_SERVE advance). */
  chosenOptionId?: string;
  /** Free text the user typed. */
  userMessage?: string;
  /**
   * #support-hub — caller reached this appointment only via the org-operator
   * party branch. Their conversation is their own, but restricted to the
   * org-party intents; the route enforces this with a 403, this clamps
   * defensively so the invariant holds even if a future caller forgets.
   */
  isOrgParty?: boolean;
}

/** The only intents an org party may raise on a member's session. Shared with
 *  the route layer, which 403s on it — one definition so the two gates can
 *  never drift. */
export const ORG_PARTY_CATEGORIES: ReadonlySet<SupportThreadCategory> = new Set(
  ["ORG_ADMIN_DISPUTE", "SPONSORSHIP_BILLING"],
);

export interface RunTurnResult {
  threadId: string;
  status: string;
  activeChannel: SupportChannel;
  currentNodeId: string | null;
  /** The bot/system messages produced this turn (already persisted). */
  messages: { sender: string; body: string; metadata?: unknown }[];
  /** Actions the resolver requested — the caller validates + executes them. */
  actions: SupportAction[];
  escalated: boolean;
  resolved: boolean;
  /**
   * False when a CAS refused the write — the thread settled underneath the
   * user. Without it a discarded message came back as a plain success and the
   * client marked it delivered.
   */
  accepted?: boolean;
  supportTicketId: string | null;
  /** Machine-readable escalation reason (terminal node / policy), if any. */
  reason?: string;
}

/** Advance a per-appointment support thread by one turn. The caller must have
 *  already verified the user participates in the appointment. Returns null if
 *  the appointment doesn't exist. */
export async function runSupportTurn(
  appointmentId: string,
  userId: string,
  input: RunTurnInput,
): Promise<RunTurnResult | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { organizationId: true },
  });
  if (!appt) return null;

  // Find-or-create — the @@unique([appointmentId, userId]) makes this the single
  // conversation for this order, and guards against a double-open race.
  const thread = await prisma.appointmentSupportThread.upsert({
    where: { appointmentId_userId: { appointmentId, userId } },
    create: {
      appointmentId,
      userId,
      organizationId: appt.organizationId,
      category: input.category ?? "OTHER",
    },
    update: {},
  });

  const ctx = await buildSupportContext(thread.id, appointmentId, userId);
  if (!ctx) return null;

  // Switching intent restarts the flow at its entry node.
  let category = thread.category;
  let currentNodeId = thread.currentNodeId;
  // Clicking an intent chip always (re)starts that intent's flow — a same-
  // category re-click must not resume a stale cursor, or the turn looks
  // ignored (the pre-#support-hub flows left threads whose option ids no
  // longer exist in the registry).
  if (input.category) {
    category = input.category;
    currentNodeId = null;
  }
  // Defensive clamp (route already 403s): an org party stays on org-party
  // intents no matter what reaches the service.
  if (input.isOrgParty && !ORG_PARTY_CATEGORIES.has(category)) {
    category = "ORG_ADMIN_DISPUTE";
    currentNodeId = null;
  }

  // Already with a human — persist the user's message and leave it in the queue.
  if (thread.activeChannel === "HUMAN") {
    return persistHumanTurn(thread, input.userMessage);
  }

  const flow = flowForCategory(ctx, category);
  // No self-serve flow for this intent (OTHER, not-yet-built categories) → human.
  if (!flow) {
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      category,
      {
        messages: [
          { sender: "SYSTEM", body: "Connecting you with our support team." },
        ],
        nextNodeId: null,
        actions: [],
        resolved: false,
        escalate: true,
      },
      input.userMessage,
      "no_flow",
    );
  }

  // Flow-version drift: a persisted cursor from an older registry revision
  // (renamed/removed node) would make every choice mismatch and re-present
  // forever. Restart at the entry instead — the walker then presents the
  // CURRENT flow's first prompt and the thread is self-healing.
  if (currentNodeId && !flow.nodes[currentNodeId]) {
    currentNodeId = null;
  }

  const resolver = new FlowchartResolver(flow);
  const walked = await resolver.resolveTurn(ctx, currentNodeId, {
    chosenOptionId: input.chosenOptionId,
    userMessage: input.userMessage,
  });
  // Pressing an intent chip IS the user's first answer, but the walk can only
  // name an option it matched and the entry present() matched nothing — so the
  // transcript opened with a bot prompt and no record of what was asked for,
  // both on screen and in the back-office inbox.
  const turn: SupportTurnResult =
    input.category && !walked.chosenLabel
      ? { ...walked, chosenLabel: flow.title }
      : walked;

  // Server truth for the recording processing window: the flow's within/beyond
  // 48h branch is client-claimed, so verify it against the slot's actual end.
  // Claiming "within" after the window has really expired is re-anchored onto
  // the flow's escalation terminal; the reverse (claiming "beyond" early) is
  // left alone — wanting a human is never wrong.
  //
  // Gated on the RESOLVED NODE, not the category. `within` is the only
  // resolved terminal that makes an elapsed-time claim. The playback branch's
  // `fixed` terminal ("Yes, it plays now") is also resolved, and recordings
  // only exist after processing — so most playback turns happen more than 48h
  // after the session ended. Gating on the category alone discarded the user's
  // confirmation that the problem was GONE, told them "our team will chase the
  // processing", and filed a false recording_missing ticket.
  const resolvedNodeId = (
    turn.messages[0]?.metadata as { nodeId?: string } | undefined
  )?.nodeId;
  if (
    category === "RECORDING_ACCESS" &&
    turn.resolved &&
    resolvedNodeId === "within" &&
    ctx.endsAt &&
    Date.now() - ctx.endsAt.getTime() > 48 * 3_600_000
  ) {
    // Target `beyond` by name rather than "the first escalating terminal in
    // object order" — that happened to pick `beyond` only because it is
    // declared before `broken`, so reordering the nodes would silently start
    // filing recording_broken for a missing recording.
    const beyond = flow.nodes["beyond"];
    const terminal =
      beyond?.kind === "TERMINAL" && beyond.escalate ? beyond : undefined;
    if (terminal) {
      return escalate(
        ctx,
        thread.id,
        thread.supportTicketId,
        category,
        {
          messages: [
            {
              sender: "BOT",
              body: terminal.body,
              metadata: { nodeId: terminal.id },
            },
          ],
          nextNodeId: null,
          actions: [],
          escalate: true,
          resolved: false,
          // The user pressed "Less than 48 hours"; the server overrode the
          // outcome, but the transcript must still show what they said.
          chosenLabel: turn.chosenLabel,
        },
        input.userMessage,
        terminal.reason ?? "recording_missing",
      );
    }
  }

  const decision = decideEscalation(ctx, turn, input.userMessage);
  if (decision.escalate) {
    // Drop the walk's "I didn't catch that" nudge when the turn escalates
    // anyway. Typing "agent" hits no option, so the walk emits the nudge — and
    // the nudge is the copy telling the user to type "agent". Persisting it
    // left the transcript scolding them for doing exactly what it asked, one
    // line above the hand-off. The escalation message is the real answer.
    const escalating = turn.unrecognized
      ? { ...turn, messages: [], unrecognized: false }
      : turn;
    return escalate(
      ctx,
      thread.id,
      thread.supportTicketId,
      category,
      escalating,
      input.userMessage,
      decision.reason ?? "escalated",
    );
  }

  // Ordinary self-serve turn — persist + advance the cursor.
  //
  // Every emitted message is persisted, including the turn that recognized
  // nothing: `walkFlow` answers that case with a distinct nudge rather than a
  // verbatim repeat of the prompt, so there is no duplicate bubble to suppress
  // and no turn that leaves the user's message hanging without a reply.
  const status = turn.resolved ? "RESOLVED" : "IN_PROGRESS";
  const wroteMessages = !!input.userMessage || turn.messages.length > 0;
  await prisma.$transaction(async (tx) => {
    // The user's side of the conversation FIRST, then the bot's. A chip press
    // is an answer just as much as typed text is — without it the stored
    // transcript is a run of bot questions with no record of what produced
    // them, which is what the back-office inbox shows a staff member.
    const userSaid = input.userMessage ?? turn.chosenLabel;
    const outgoing = [
      ...(userSaid
        ? [{ sender: "USER" as const, body: userSaid, metadata: undefined }]
        : []),
      ...turn.messages.map((m) => ({
        sender: m.sender,
        body: m.body,
        metadata: (m.metadata as object) ?? undefined,
      })),
    ];
    // Both rows share a transaction and therefore a timestamp; `seq` is what
    // makes the question sort above the answer.
    let seq = await allocateMessageSeq(tx, thread.id, outgoing.length);
    for (const m of outgoing) {
      await tx.supportMessage.create({
        data: { threadId: thread.id, seq: ++seq, ...m },
      });
    }
    await tx.appointmentSupportThread.update({
      where: { id: thread.id },
      data: {
        category,
        currentNodeId: turn.nextNodeId,
        status,
        resolvedAt: turn.resolved ? new Date() : null,
        // Keep the hub's "latest activity first" clock honest — updatedAt
        // alone won't move on message inserts.
        ...(wroteMessages ? { lastMessageAt: new Date() } : {}),
      },
    });
  });

  // #705 — a terminal turn is the unit the deflection rate counts. Recorded
  // AFTER the transaction and never allowed to throw: a counter must not be
  // able to roll back the conversation it is counting.
  if (turn.resolved) {
    await recordFlowOutcome({
      scope: "APPOINTMENT",
      flowKey: category,
      terminalNodeId: resolvedNodeId ?? null,
      reason: turn.reason ?? null,
      outcome: "RESOLVED",
      userId: ctx.userId,
      organizationId: ctx.organizationId,
    });
  }

  return {
    threadId: thread.id,
    status,
    activeChannel: "SELF_SERVE",
    currentNodeId: turn.nextNodeId,
    messages: turn.messages,
    actions: turn.actions,
    escalated: false,
    resolved: turn.resolved,
    supportTicketId: thread.supportTicketId,
    reason: turn.reason,
  };
}

/** Persist a message on a thread already handed to a human. */
async function persistHumanTurn(
  thread: {
    id: string;
    status: SupportThreadStatus;
    supportTicketId: string | null;
    organizationId: string | null;
  },
  userMessage: string | undefined,
): Promise<RunTurnResult> {
  // Report the thread's ACTUAL status. This used to return a hardcoded
  // "ESCALATED", so once ops resolved the thread the user's own message came
  // back claiming it was still with the team.
  let status = thread.status;
  let messageId: string | null = null;
  let accepted = true;

  if (userMessage) {
    // Deliberately SHORT. On Netlify PG_POOL_MAX=1 serialises every query onto
    // one connection, and a cold instance can stretch 400ms of idle await into
    // twenty-plus seconds — so an interactive transaction holding that
    // connection across six sequential round trips blew Prisma's 5s default and
    // surfaced to the user as "something went wrong". Two writes here; the SLA
    // clock and the notification both happen after the commit, because neither
    // is an invariant of the message being stored.
    const written = await prisma.$transaction(
      async (tx) => {
        // The CAS and the sequence allocation are the SAME statement: a CLOSED
        // or RESOLVED thread is one the PATCH route refuses to reopen, so a
        // message must not land on it or bump its activity clock.
        const moved = await tx.appointmentSupportThread.updateMany({
          where: { id: thread.id, status: { notIn: ["CLOSED", "RESOLVED"] } },
          data: { messageSeq: { increment: 1 }, lastMessageAt: new Date() },
        });
        if (moved.count === 0) return null;

        const row = await tx.appointmentSupportThread.findUniqueOrThrow({
          where: { id: thread.id },
          select: { messageSeq: true },
        });
        return tx.supportMessage.create({
          data: {
            threadId: thread.id,
            sender: "USER",
            body: userMessage,
            seq: row.messageSeq,
          },
          select: { id: true },
        });
      },
      { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
    );

    if (!written) {
      // The thread settled underneath us and the CAS refused the write. Report
      // where it actually landed AND that the message was not accepted —
      // returning a plain success made the client mark it delivered, so a
      // message that was never stored looked sent.
      const current = await prisma.appointmentSupportThread.findUniqueOrThrow({
        where: { id: thread.id },
        select: { status: true },
      });
      status = current.status;
      accepted = false;
    } else {
      messageId = written.id;

      // Post-commit, and best-effort. A clock that resumes a moment late is a
      // rounding error on a 15-day deadline; a message that failed to store
      // because the clock update timed out is a lost customer message.
      if (thread.supportTicketId) {
        await resumeTicketClock(thread.supportTicketId).catch((error) => {
          console.error("support: SLA resume failed", {
            ticketId: thread.supportTicketId,
            error,
          });
        });
        await notifyStaffOfTicketActivity(
          thread.supportTicketId,
          thread.organizationId,
          messageId ?? undefined,
        ).catch((error) => {
          console.error("support: user-reply notification failed", {
            threadId: thread.id,
            error,
          });
        });
      }
    }
  }

  return {
    threadId: thread.id,
    status,
    activeChannel: "HUMAN",
    currentNodeId: null,
    messages: [],
    actions: [],
    escalated: true,
    resolved: false,
    accepted,
    supportTicketId: thread.supportTicketId,
  };
}

/** The ball is back with us, so the resolution clock restarts. */
async function resumeTicketClock(ticketId: string): Promise<void> {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { awaitingUserSince: true, pausedSeconds: true },
  });
  if (!ticket) return;
  // CAS on the two fields the patch is computed FROM. `userRepliedPatch` banks
  // an absolute `pausedSeconds` derived from the read above, so an
  // unconditional update let two concurrent user replies — or a staff reply
  // landing in between — overwrite each other's increment and leave the SLA
  // clock reporting a pause that never happened. Losing the race is not a
  // failure: the other writer has already banked the same interval, so we keep
  // the activity stamp and leave the clock exactly as they set it.
  const claimed = await prisma.supportTicket.updateMany({
    where: {
      id: ticketId,
      awaitingUserSince: ticket.awaitingUserSince,
      pausedSeconds: ticket.pausedSeconds,
    },
    data: { lastMessageAt: new Date(), ...userRepliedPatch(ticket) },
  });
  if (claimed.count === 0) {
    await prisma.supportTicket.update({
      where: { id: ticketId },
      data: { lastMessageAt: new Date() },
    });
  }
}

/** Hand the thread to a human: persist the exchange, create/link a SupportTicket
 *  in the existing ops queue, and flip the channel to HUMAN. */
async function escalate(
  ctx: SupportContext,
  threadId: string,
  existingTicketId: string | null,
  category: SupportThreadCategory,
  turn: {
    messages: {
      sender: string;
      body: string;
      metadata?: Record<string, unknown>;
    }[];
    nextNodeId: string | null;
    actions: SupportAction[];
    resolved: boolean;
    escalate: boolean;
    reason?: string;
    /** Label of the chip that produced this turn, recorded as the USER message. */
    chosenLabel?: string;
  },
  userMessage: string | undefined,
  reason: string,
): Promise<RunTurnResult> {
  // Terminal-node reasons win (they're the specific why); policy reasons
  // (high_value_refund, no_flow) fill in. Priority comes from the shared map.
  const effectiveReason = turn.reason ?? reason;
  const priority = priorityForReason(effectiveReason);
  const issueType = issueTypeForReason(effectiveReason);

  // Staff notification must fire only for a ticket that actually committed, so
  // the transaction reports back whether it minted one and the notify happens
  // after. (This is also why the create below cannot just call
  // `createSupportTicket` — that helper is not transaction-aware.)
  let createdTicket: {
    id: string;
    title: string;
    organizationId: string | null;
    referenceNumber: string | null;
  } | null = null;

  const ticketId = await prisma.$transaction(
    async (tx) => {
      // Same rule as the self-serve turn: record the chip the user pressed, so
      // the escalated transcript staff read contains both halves.
      const userSaid = userMessage ?? turn.chosenLabel;
      const outgoing = [
        ...(userSaid
          ? [{ sender: "USER" as const, body: userSaid, metadata: undefined }]
          : []),
        ...turn.messages.map((m) => ({
          sender: m.sender as "BOT" | "SYSTEM" | "USER" | "AGENT",
          body: m.body,
          metadata: (m.metadata as object) ?? undefined,
        })),
      ];
      let seq = await allocateMessageSeq(tx, threadId, outgoing.length);
      for (const m of outgoing) {
        await tx.supportMessage.create({
          data: { threadId, seq: ++seq, ...m },
        });
      }

      let linkedTicketId = existingTicketId;
      if (!linkedTicketId) {
        // Both inside the ticket's own transaction: a rolled-back escalation must
        // not leave a live reference behind, and must not start an SLA clock for
        // a ticket that does not exist.
        const openedAt = new Date();
        const referenceNumber = await allocateTicketReference(tx, openedAt);
        const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(
          priority,
          openedAt,
        );
        const ticket = await tx.supportTicket.create({
          data: {
            userId: ctx.userId,
            title: `Support for appointment ${ctx.appointmentId}`,
            description: `Escalated from per-appointment support (${category}, reason: ${effectiveReason}).`,
            priority,
            referenceNumber,
            ackDueAt,
            resolutionDueAt,
            category,
            // The machine-readable half of the terminal reason. Without it every
            // session escalation reached ops as an untyped row and none of the
            // session-scoped issue types was reachable anywhere in the product.
            issueType: issueType ?? undefined,
            paymentId: ctx.paymentId,
            // Org attribution for the ops queue's org filter (null = B2C).
            organizationId: ctx.organizationId,
          },
          select: {
            id: true,
            title: true,
            organizationId: true,
            referenceNumber: true,
          },
        });
        linkedTicketId = ticket.id;
        createdTicket = ticket;
      }

      await tx.appointmentSupportThread.update({
        where: { id: threadId },
        data: {
          category,
          currentNodeId: null,
          status: "ESCALATED",
          activeChannel: "HUMAN",
          supportTicketId: linkedTicketId,
          lastMessageAt: new Date(),
        },
      });
      return linkedTicketId;
    },
    // Allocation budget: this transaction also queues on the reference counter.
    { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
  );

  await recordFlowOutcome({
    scope: "APPOINTMENT",
    flowKey: category,
    terminalNodeId: null,
    reason: effectiveReason,
    outcome: "ESCALATED",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });

  // Committed — now it is safe to page the queue. Fire-and-forget for the same
  // reason the factory does it: a notification failure must not turn a
  // successful escalation into a 500 and have the user retry into a duplicate.
  if (createdTicket) {
    await notifySupportStaff(createdTicket).catch((error) => {
      console.error("support: staff notification failed for escalation", {
        ticketId: (createdTicket as { id: string }).id,
        error,
      });
    });
  }

  return {
    threadId,
    status: "ESCALATED",
    activeChannel: "HUMAN",
    currentNodeId: null,
    messages: turn.messages,
    actions: turn.actions,
    escalated: true,
    resolved: false,
    supportTicketId: ticketId,
    reason: effectiveReason,
  };
}
