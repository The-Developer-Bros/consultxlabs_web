/**
 * Group-event capacity — the single source of truth for "how many seats does
 * this webinar/class have, and how many are taken".
 *
 * Capacity used to be computed in five places with four different answers.
 * Everything (checkout gates, explore pages, planner cards, participants
 * screen, staff rollups) now reads from here.
 *
 * Two rules worth stating, because they are easy to get wrong:
 *
 * 1. Capacity is per event *instance*. `Webinar.maxParticipants` /
 *    `Class.maxParticipants` override the plan's value; null inherits it. The
 *    plan number is the default for newly created instances.
 * 2. Every user connected to a slot occupies a seat, including one whose
 *    payment is still PENDING. Registration connects the buyer to the event's
 *    shared slots, so tentativeness is a property of the slot rather than of
 *    the individual registrant and cannot be filtered per user. A seat is
 *    released when the abandoned-checkout cleanup disconnects the buyer.
 *
 * Pure functions only — no Prisma import — so client components can call this
 * on data handed down from a server component.
 */

import {
  countUniqueParticipants,
  countWebinarParticipants,
} from "@/lib/payments/utils/participants";

export type CapacityInstance = { maxParticipants?: number | null };
export type CapacityPlan = { maxParticipants: number };

export type EventCapacity = {
  /** Effective seat count for this instance. */
  max: number;
  /** Seats currently taken. */
  registered: number;
  /** Never negative — an over-capacity event reads as 0 remaining. */
  remaining: number;
  isFull: boolean;
};

/**
 * Effective capacity for one instance: its own override, else the plan's.
 *
 * Both arguments are optional so callers holding partial data (an explore page
 * that only received the plan, say) don't have to branch.
 */
export function effectiveMaxParticipants(
  instance: CapacityInstance | null | undefined,
  plan: CapacityPlan | null | undefined,
): number {
  const override = instance?.maxParticipants;
  if (typeof override === "number") return override;
  return plan?.maxParticipants ?? 0;
}

function toCapacity(max: number, registered: number): EventCapacity {
  return {
    max,
    registered,
    remaining: Math.max(0, max - registered),
    isFull: registered >= max,
  };
}

/**
 * Webinar capacity. One shared appointment; every registrant is connected to
 * its slots.
 *
 * `excludeUserIds` should carry the consultant's own user id — hosts do not
 * consume a seat.
 *
 * Callers MUST have included `slotsOfAppointment.user` in their query.
 * `countWebinarParticipants` silently returns 0 when the relation is missing,
 * which is exactly how the old in-lock recheck ended up dead.
 */
export function getWebinarCapacity(params: {
  webinar: CapacityInstance & {
    appointment?: { slotsOfAppointment?: Array<Record<string, unknown>> } | null;
  };
  plan: CapacityPlan;
  excludeUserIds?: string[];
}): EventCapacity {
  const { webinar, plan, excludeUserIds = [] } = params;
  assertParticipantsIncluded(
    webinar.appointment?.slotsOfAppointment,
    "getWebinarCapacity",
  );
  return toCapacity(
    effectiveMaxParticipants(webinar, plan),
    countWebinarParticipants(webinar.appointment ?? null, excludeUserIds),
  );
}

/**
 * Class capacity. One appointment per session, and a student is connected to
 * every session's slots, so seats are unique users across all appointments.
 */
export function getClassCapacity(params: {
  classInstance: CapacityInstance & {
    appointments?: Array<{
      slotsOfAppointment: Array<Record<string, unknown>>;
    }>;
  };
  plan: CapacityPlan;
  excludeUserIds?: string[];
}): EventCapacity {
  const { classInstance, plan, excludeUserIds = [] } = params;
  for (const appointment of classInstance.appointments ?? []) {
    assertParticipantsIncluded(appointment.slotsOfAppointment, "getClassCapacity");
  }
  return toCapacity(
    effectiveMaxParticipants(classInstance, plan),
    countUniqueParticipants(classInstance.appointments ?? [], excludeUserIds),
  );
}

/**
 * A capacity call whose slots were loaded WITHOUT the `user` relation counts
 * zero registrants and reports a sold-out event as open — the exact way the
 * old in-lock recheck died. Loud failure beats a silently-wrong count on a
 * money gate, so this throws instead of returning 0 (#676 CN-4, #1169 PR 1).
 */
function assertParticipantsIncluded(
  slots: Array<Record<string, unknown>> | undefined | null,
  caller: string,
): void {
  for (const slot of slots ?? []) {
    if (!("user" in slot)) {
      throw new Error(
        `${caller}: slotsOfAppointment.user was not included in the query — the participant count would silently read 0. Include { slotsOfAppointment: { include: { user: true } } }.`,
      );
    }
  }
}

/**
 * Message shown when an organizer tries to shrink an event below the people
 * already in it. Kept here so the API and the planner form word it the same.
 */
export function capacityBelowRegisteredMessage(
  requested: number,
  registered: number,
): string {
  return `Cannot set capacity to ${requested} — ${registered} ${
    registered === 1 ? "person is" : "people are"
  } already registered. Remove participants first.`;
}

/**
 * Thrown from inside the update transaction so the guard rolls the whole edit
 * back; the route maps it to a 400 rather than a generic 500.
 */
export class CapacityBelowEnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityBelowEnrollmentError";
  }
}
