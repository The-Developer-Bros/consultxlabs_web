/**
 * Shared "live slot on a group event" lookup for self-leave gates and
 * attendee-refund notice windows (#1005).
 *
 * Three call sites used the same `deletedAt` + `completionStatus notIn`
 * filter with different sort / `startsAt` bounds. Centralising keeps the
 * eligibility and refund % definitions from drifting.
 */

import type { Prisma, SlotCompletionStatus } from "@prisma/client";
import prisma from "@/lib/prisma";

/** Mutable list — Prisma's `notIn` rejects `readonly` tuples from `as const`. */
const DEAD_COMPLETION_STATUSES: SlotCompletionStatus[] = [
  "CANCELLED",
  "RESCHEDULED",
];

export type LiveEventAppointmentFilter =
  | { webinarId: string }
  | { classId: string };

export async function findLiveEventSlot(
  appointment: LiveEventAppointmentFilter,
  opts: {
    order: "asc" | "desc";
    /** When set, only slots at/after this instant (next-session notice window). */
    startsAtGte?: Date;
  },
): Promise<{ startsAt: Date } | null> {
  const where: Prisma.SlotOfAppointmentWhereInput = {
    appointment,
    deletedAt: null,
    completionStatus: { notIn: DEAD_COMPLETION_STATUSES },
    ...(opts.startsAtGte ? { startsAt: { gte: opts.startsAtGte } } : {}),
  };
  return prisma.slotOfAppointment.findFirst({
    where,
    orderBy: { startsAt: opts.order },
    select: { startsAt: true },
  });
}
