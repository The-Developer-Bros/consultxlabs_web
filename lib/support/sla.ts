/**
 * #705 — support SLA clocks.
 *
 * India makes an escalation ladder a legal artifact rather than a nicety. Two
 * regimes can apply: the Consumer Protection (E-Commerce) Rules 2020 (grievance
 * officer, acknowledge <= 48h, redress <= 1 month) and the IT Rules 2021
 * (acknowledge <= 24h, dispose <= 15 days). We size to the TIGHTER one, because
 * meeting it satisfies both and we do not have to first settle whether the
 * platform is an intermediary.
 *
 * The per-priority targets below sit INSIDE those caps — they are an internal
 * service goal, never a relaxation of the statutory number.
 */

import type { SupportPriority, SupportTicketStatus } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

/** The statutory ceilings. Nothing here may exceed these. */
export const STATUTORY_ACK_HOURS = 24;
export const STATUTORY_RESOLUTION_DAYS = 15;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

interface SlaTarget {
  ackMs: number;
  resolutionMs: number;
}

const TARGETS: Record<SupportPriority, SlaTarget> = {
  URGENT: { ackMs: 2 * HOUR_MS, resolutionMs: 1 * DAY_MS },
  HIGH: { ackMs: 8 * HOUR_MS, resolutionMs: 3 * DAY_MS },
  MEDIUM: { ackMs: STATUTORY_ACK_HOURS * HOUR_MS, resolutionMs: 7 * DAY_MS },
  LOW: {
    ackMs: STATUTORY_ACK_HOURS * HOUR_MS,
    resolutionMs: STATUTORY_RESOLUTION_DAYS * DAY_MS,
  },
};

export interface SlaDeadlines {
  ackDueAt: Date;
  resolutionDueAt: Date;
}

/**
 * Deadlines for a ticket opened at `from`. Computed ONCE at intake and stored,
 * never re-derived on read: a later change to the table above must not
 * retroactively re-date an open ticket's breach.
 */
export function slaDeadlinesFor(
  priority: SupportPriority,
  from: Date = new Date(),
): SlaDeadlines {
  const target = TARGETS[priority] ?? TARGETS.MEDIUM;
  return {
    ackDueAt: new Date(from.getTime() + target.ackMs),
    resolutionDueAt: new Date(from.getTime() + target.resolutionMs),
  };
}

/** The subset of a ticket the clock reads. */
export interface SlaClock {
  status: SupportTicketStatus;
  ackDueAt: Date | null;
  acknowledgedAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
  awaitingUserSince: Date | null;
  pausedSeconds: number;
}

/**
 * How long this ticket has spent waiting on the user, including an open wait.
 * The resolution clock stops there — otherwise a customer who takes a week to
 * answer reads as the team breaching, and the number stops meaning anything.
 * The ACKNOWLEDGEMENT clock never pauses: nobody has replied yet, so there is
 * nothing to be waiting for.
 */
export function pausedSecondsAt(
  clock: Pick<SlaClock, "awaitingUserSince" | "pausedSeconds">,
  now: Date = new Date(),
): number {
  return clock.pausedSeconds + openWaitSeconds(clock, now);
}

/** The wait that is still running, if any. Zero when the ball is with us. */
export function openWaitSeconds(
  clock: Pick<SlaClock, "awaitingUserSince">,
  now: Date,
): number {
  if (!clock.awaitingUserSince) return 0;
  return Math.max(
    0,
    Math.floor((now.getTime() - clock.awaitingUserSince.getTime()) / 1000),
  );
}

/** Resolution deadline shifted by the time spent waiting on the user. */
export function effectiveResolutionDueAt(
  clock: SlaClock,
  now: Date = new Date(),
): Date | null {
  if (!clock.resolutionDueAt) return null;
  return new Date(
    clock.resolutionDueAt.getTime() + pausedSecondsAt(clock, now) * 1000,
  );
}

export interface SlaState {
  ackBreached: boolean;
  resolutionBreached: boolean;
  /** Null once acknowledged, or when the ticket predates the SLA columns. */
  msToAckDue: number | null;
  /** Null once resolved, or when the ticket predates the SLA columns. */
  msToResolutionDue: number | null;
}

/**
 * Derived, never stored. A stored breach flag needs a cron to stay honest and
 * is wrong between runs; these five timestamps plus now() are complete.
 */
export function slaStateOf(clock: SlaClock, now: Date = new Date()): SlaState {
  const settled =
    clock.status === "RESOLVED" ||
    clock.status === "CLOSED" ||
    !!clock.resolvedAt;

  const ackOutstanding = !clock.acknowledgedAt && !settled;
  const resolutionOutstanding = !settled;
  const resolutionDue = effectiveResolutionDueAt(clock, now);

  return {
    ackBreached:
      ackOutstanding &&
      !!clock.ackDueAt &&
      now.getTime() > clock.ackDueAt.getTime(),
    resolutionBreached:
      resolutionOutstanding &&
      !!resolutionDue &&
      now.getTime() > resolutionDue.getTime(),
    msToAckDue:
      ackOutstanding && clock.ackDueAt
        ? clock.ackDueAt.getTime() - now.getTime()
        : null,
    msToResolutionDue:
      resolutionOutstanding && resolutionDue
        ? resolutionDue.getTime() - now.getTime()
        : null,
  };
}

/**
 * The writes a STAFF reply makes: the ball moves to the user, so the resolution
 * clock stops. `firstAgentReplyAt` is set once and never moved — it is the
 * number that predicts CSAT, and an auto-acknowledgement must not claim it.
 */
export async function applyStaffReply(
  tx: Tx,
  ticketId: string,
  now: Date = new Date(),
): Promise<void> {
  // First-write-wins, expressed in the WHERE clause so the DATABASE decides it
  // rather than a value we read a moment ago. Reading the row first and then
  // writing unconditionally is not enough even inside a transaction: at READ
  // COMMITTED two staff replying at the same instant both see null, and the
  // later write moves a timestamp that is supposed to be the first one.
  await tx.supportTicket.updateMany({
    where: { id: ticketId, acknowledgedAt: null },
    data: { acknowledgedAt: now },
  });
  await tx.supportTicket.updateMany({
    where: { id: ticketId, firstAgentReplyAt: null },
    data: { firstAgentReplyAt: now },
  });

  // Bank the wait that was already running, then restart the clock. The CAS on
  // `awaitingUserSince` is what stops two simultaneous replies banking the same
  // interval twice — only the one whose read is still current matches.
  const current = await tx.supportTicket.findUnique({
    where: { id: ticketId },
    select: { awaitingUserSince: true },
  });
  const open = openWaitSeconds(
    { awaitingUserSince: current?.awaitingUserSince ?? null },
    now,
  );
  if (current?.awaitingUserSince && open > 0) {
    const banked = await tx.supportTicket.updateMany({
      where: { id: ticketId, awaitingUserSince: current.awaitingUserSince },
      data: { pausedSeconds: { increment: open }, awaitingUserSince: now },
    });
    if (banked.count > 0) return;
  }
  await tx.supportTicket.updateMany({
    where: { id: ticketId },
    data: { awaitingUserSince: now },
  });
}

/**
 * The write a USER reply makes: fold the wait that just ended into `pausedMs`
 * and restart the clock. A no-op when we were not waiting, so a user sending
 * three messages in a row cannot bank three pauses.
 */
export function userRepliedPatch(
  clock: Pick<SlaClock, "awaitingUserSince" | "pausedSeconds">,
  now: Date = new Date(),
) {
  if (!clock.awaitingUserSince) return {};
  return {
    pausedSeconds: clock.pausedSeconds + openWaitSeconds(clock, now),
    awaitingUserSince: null,
  };
}
