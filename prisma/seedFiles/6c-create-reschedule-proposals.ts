import { faker } from "@faker-js/faker";
import type {
  RescheduleInitiatorRole,
  RescheduleRequestStatus,
} from "@prisma/client";
import prisma from "../../lib/prisma";
import { computeProposalExpiry } from "../../lib/booking/reschedule-proposals";
import { config } from "./config";

/**
 * Reschedule proposals — the concrete times each side wants, not just which
 * slots to drop.
 *
 * A reschedule used to reach the consultant carrying LESS information than the
 * original booking, so the local database had no way to render the proposal
 * banner, the counter-offer round, or the "at most one live reschedule per
 * appointment" guard. These rows give every one of those surfaces something to
 * act on.
 *
 * Three invariants are load-bearing here and are enforced in this file rather
 * than left to chance:
 *   - `openForAppointmentId` is a nullable @unique. Only PENDING_REVIEW and
 *     COUNTERED rows set it; every terminal row must leave it NULL or the
 *     second request on an appointment collides at the database.
 *   - `expiresAt` is min(now + 72h, earliest released slot − 24h), computed by
 *     the same `computeProposalExpiry` the API uses so the seed cannot drift
 *     away from the policy.
 *   - a proposal replaces released slots one for one; a different count is a
 *     different booking, not a reschedule.
 */

const NUM_OPEN_CONSULTATION =
  config.volumes.rescheduleProposals.openConsultation;
const NUM_COUNTERED_SUBSCRIPTION =
  config.volumes.rescheduleProposals.counteredSubscription;
const NUM_RESOLVED = config.volumes.rescheduleProposals.resolved;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// A slot has to sit beyond the 24-hour resolve margin for a proposal about it
// to have any life at all — inside it, computeProposalExpiry returns null.
const EARLIEST_RESCHEDULABLE_MS = 26 * HOUR_MS;

const REASONS = [
  "A client escalation landed on the same afternoon.",
  "Travelling that week — anything after the 15th works better.",
  "Clashes with a standing team review I cannot move.",
  "Recovering from surgery, would prefer the following week.",
  "Interview scheduled at the same hour, apologies for the short notice.",
  "Family commitment I only just found out about.",
];

const COUNTER_REASONS = [
  "That week is fully booked — offering the two nearest openings instead.",
  "Happy to move, though mornings are the only slots I have free.",
  "Can do the same day one hour later if that still works for you.",
];

type Candidate = {
  appointmentId: string;
  organizationId: string | null;
  consulteeUserId: string;
  consultantUserId: string;
  slots: { id: string; startsAt: Date; endsAt: Date }[];
};

type ProposedTime = { startsAt: Date; endsAt: Date };

/**
 * A replacement for one released slot: the same duration, a few days out, at a
 * plausible working hour. Duration is preserved deliberately — changing it
 * would change what was paid for.
 */
function proposeReplacement(
  slot: { startsAt: Date; endsAt: Date },
  dayShift: number,
): ProposedTime {
  const durationMs = slot.endsAt.getTime() - slot.startsAt.getTime();
  const startsAt = new Date(slot.startsAt.getTime() + dayShift * DAY_MS);
  startsAt.setUTCHours(
    faker.helpers.arrayElement([9, 10, 11, 14, 15, 16]),
    0,
    0,
    0,
  );
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMs) };
}

function proposeReplacements(
  slots: { startsAt: Date; endsAt: Date }[],
  dayShift: number,
): ProposedTime[] {
  return slots.map((slot) => proposeReplacement(slot, dayShift));
}

const slotWindow = (cutoff: Date) => ({
  where: {
    deletedAt: null,
    completionStatus: "SCHEDULED" as const,
    startsAt: { gt: cutoff },
  },
  select: { id: true, startsAt: true, endsAt: true },
  orderBy: { startsAt: "asc" as const },
});

async function loadConsultationCandidates(
  cutoff: Date,
  limit: number,
): Promise<Candidate[]> {
  const appointments = await prisma.appointment.findMany({
    where: {
      appointmentType: "CONSULTATION",
      deletedAt: null,
      // Never stack a second proposal onto an appointment that already has one:
      // that is exactly the collision the nullable-unique exists to prevent.
      rescheduleRequests: { none: {} },
      consultation: { status: "APPROVED" },
      slotsOfAppointment: {
        some: {
          deletedAt: null,
          completionStatus: "SCHEDULED",
          startsAt: { gt: cutoff },
        },
      },
    },
    select: {
      id: true,
      organizationId: true,
      slotsOfAppointment: slotWindow(cutoff),
      consultation: {
        select: {
          requestedBy: { select: { userId: true } },
          consultationPlan: {
            select: { consultantProfile: { select: { userId: true } } },
          },
        },
      },
    },
    take: limit,
  });

  return appointments.flatMap((appointment) => {
    const consulteeUserId = appointment.consultation?.requestedBy.userId;
    const consultantUserId =
      appointment.consultation?.consultationPlan.consultantProfile.userId;
    if (!consulteeUserId || !consultantUserId) return [];
    if (appointment.slotsOfAppointment.length === 0) return [];

    return [
      {
        appointmentId: appointment.id,
        organizationId: appointment.organizationId,
        consulteeUserId,
        consultantUserId,
        // A consultation is one session, so the whole booking moves.
        slots: appointment.slotsOfAppointment.slice(0, 1),
      },
    ];
  });
}

async function loadSubscriptionCandidates(
  cutoff: Date,
  limit: number,
): Promise<Candidate[]> {
  const appointments = await prisma.appointment.findMany({
    where: {
      appointmentType: "SUBSCRIPTION",
      deletedAt: null,
      rescheduleRequests: { none: {} },
      subscription: { status: "APPROVED" },
      slotsOfAppointment: {
        some: {
          deletedAt: null,
          completionStatus: "SCHEDULED",
          startsAt: { gt: cutoff },
        },
      },
    },
    select: {
      id: true,
      organizationId: true,
      slotsOfAppointment: slotWindow(cutoff),
      subscription: {
        select: {
          requestedBy: { select: { userId: true } },
          subscriptionPlan: {
            select: { consultantProfile: { select: { userId: true } } },
          },
        },
      },
    },
    take: limit,
  });

  return appointments.flatMap((appointment) => {
    const consulteeUserId = appointment.subscription?.requestedBy.userId;
    const consultantUserId =
      appointment.subscription?.subscriptionPlan.consultantProfile.userId;
    if (!consulteeUserId || !consultantUserId) return [];
    if (appointment.slotsOfAppointment.length === 0) return [];

    return [
      {
        appointmentId: appointment.id,
        organizationId: appointment.organizationId,
        consulteeUserId,
        consultantUserId,
        // A subscription moves individual sessions, not the whole plan.
        slots: appointment.slotsOfAppointment.slice(
          0,
          faker.number.int({ min: 1, max: 2 }),
        ),
      },
    ];
  });
}

/**
 * Opens a live proposal: releases the slots and reserves the appointment.
 *
 * The released rows keep their original times and are flipped to
 * isTentative + RESCHEDULED, which is how the requests table tells slots
 * awaiting a reschedule apart from a fresh request's tentative ones.
 */
async function openProposal(
  candidate: Candidate,
  args: {
    status: Extract<RescheduleRequestStatus, "PENDING_REVIEW" | "COUNTERED">;
    initiatorRole: RescheduleInitiatorRole;
    round: number;
  },
): Promise<boolean> {
  const expiresAt = computeProposalExpiry(
    candidate.slots.map((slot) => slot.startsAt),
  );
  if (!expiresAt) return false;

  const initiatedById =
    args.initiatorRole === "CONSULTEE"
      ? candidate.consulteeUserId
      : candidate.consultantUserId;

  const openingRound = proposeReplacements(
    candidate.slots,
    faker.number.int({ min: 3, max: 9 }),
  );

  // Round 2 is the other side's counter, offered on top of round 1 rather than
  // replacing it — the negotiation history is the point of keeping `round`.
  const counterRound =
    args.round > 1
      ? proposeReplacements(
          candidate.slots,
          faker.number.int({ min: 10, max: 16 }),
        )
      : [];

  await prisma.$transaction(async (tx) => {
    await tx.slotOfAppointment.updateMany({
      where: { id: { in: candidate.slots.map((slot) => slot.id) } },
      data: { isTentative: true, completionStatus: "RESCHEDULED" },
    });

    await tx.rescheduleRequest.create({
      data: {
        appointmentId: candidate.appointmentId,
        initiatorRole: args.initiatorRole,
        initiatedById,
        status: args.status,
        round: args.round,
        reason:
          args.round > 1
            ? faker.helpers.arrayElement(COUNTER_REASONS)
            : faker.helpers.arrayElement(REASONS),
        releasedSlotIds: candidate.slots.map((slot) => slot.id),
        expiresAt,
        // Reserves the appointment for as long as the request is open.
        openForAppointmentId: candidate.appointmentId,
        organizationId: candidate.organizationId,
        proposedSlots: {
          create: [
            ...openingRound.map((time) => ({
              ...time,
              round: 1,
              proposedById: initiatedById,
            })),
            ...counterRound.map((time) => ({
              ...time,
              round: 2,
              proposedById:
                initiatedById === candidate.consulteeUserId
                  ? candidate.consultantUserId
                  : candidate.consulteeUserId,
            })),
          ],
        },
      },
    });
  });

  return true;
}

/**
 * A historical, already-answered proposal on an appointment that now carries a
 * live one. This is the pairing that proves the nullable-unique does what it
 * claims: two requests, one appointment, no collision, because only the open
 * row holds `openForAppointmentId`.
 *
 * AUTO_ACCEPTED describes a consultee proposal that landed inside published
 * availability, so its proposed times ARE the times the slots now hold — the
 * auto-confirm path writes them onto the released rows before allocating.
 */
async function resolvedProposal(
  candidate: Candidate,
  status: Extract<
    RescheduleRequestStatus,
    "AUTO_ACCEPTED" | "DECLINED" | "EXPIRED"
  >,
): Promise<void> {
  const createdAt = new Date(
    Date.now() - faker.number.int({ min: 9, max: 30 }) * DAY_MS,
  );
  const initiatorRole: RescheduleInitiatorRole =
    status === "DECLINED" ? "CONSULTANT" : "CONSULTEE";
  const initiatedById =
    initiatorRole === "CONSULTEE"
      ? candidate.consulteeUserId
      : candidate.consultantUserId;

  const proposed =
    status === "AUTO_ACCEPTED"
      ? candidate.slots.map((slot) => ({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
        }))
      : proposeReplacements(
          candidate.slots,
          faker.number.int({ min: 2, max: 6 }),
        );

  // An EXPIRED request was answered by the clock, not a person, so it has no
  // resolver; a DECLINED one was answered by the side that did not open it.
  const resolvedById = status === "DECLINED" ? candidate.consulteeUserId : null;
  const resolvedAt =
    status === "EXPIRED"
      ? new Date(createdAt.getTime() + 72 * HOUR_MS)
      : new Date(
          createdAt.getTime() + faker.number.int({ min: 5, max: 40 }) * 60_000,
        );

  await prisma.rescheduleRequest.create({
    data: {
      appointmentId: candidate.appointmentId,
      initiatorRole,
      initiatedById,
      status,
      round: 1,
      reason: faker.helpers.arrayElement(REASONS),
      releasedSlotIds: candidate.slots.map((slot) => slot.id),
      expiresAt: new Date(createdAt.getTime() + 72 * HOUR_MS),
      // Terminal rows MUST leave this NULL — a resolved request holds no claim
      // on its appointment, and a non-null value here would collide with the
      // live request seeded above.
      openForAppointmentId: null,
      resolvedAt,
      resolvedById,
      organizationId: candidate.organizationId,
      createdAt,
      proposedSlots: {
        create: proposed.map((time) => ({
          ...time,
          round: 1,
          proposedById: initiatedById,
        })),
      },
    },
  });
}

export async function createRescheduleProposals(): Promise<void> {
  console.log(
    `Creating ${NUM_OPEN_CONSULTATION} open, ${NUM_COUNTERED_SUBSCRIPTION} countered and ${NUM_RESOLVED} resolved reschedule proposals...`,
  );

  const cutoff = new Date(Date.now() + EARLIEST_RESCHEDULABLE_MS);

  // Over-fetch: a candidate can still fall out when its earliest released slot
  // sits inside the resolve margin by the time the expiry is computed.
  const consultationCandidates = await loadConsultationCandidates(
    cutoff,
    NUM_OPEN_CONSULTATION * 2,
  );
  const subscriptionCandidates = await loadSubscriptionCandidates(
    cutoff,
    NUM_COUNTERED_SUBSCRIPTION * 2,
  );

  if (
    consultationCandidates.length === 0 &&
    subscriptionCandidates.length === 0
  ) {
    console.warn(
      "No approved future-dated appointments found — skipping reschedule proposals.",
    );
    return;
  }

  const opened: Candidate[] = [];

  for (const candidate of consultationCandidates) {
    if (opened.length >= NUM_OPEN_CONSULTATION) break;
    // CONSULTEE-initiated and awaiting the consultant: the state the requests
    // queue and the proposal banner are built for.
    const created = await openProposal(candidate, {
      status: "PENDING_REVIEW",
      initiatorRole: "CONSULTEE",
      round: 1,
    });
    if (created) opened.push(candidate);
  }

  let countered = 0;
  for (const candidate of subscriptionCandidates) {
    if (countered >= NUM_COUNTERED_SUBSCRIPTION) break;
    const created = await openProposal(candidate, {
      status: "COUNTERED",
      initiatorRole: "CONSULTEE",
      round: 2,
    });
    if (created) {
      opened.push(candidate);
      countered += 1;
    }
  }

  // Resolved rows ride on appointments that already carry a live request, which
  // is what exercises the unique constraint rather than merely avoiding it.
  const RESOLVED_STATUSES = ["AUTO_ACCEPTED", "DECLINED", "EXPIRED"] as const;
  let resolved = 0;
  for (const candidate of opened) {
    if (resolved >= NUM_RESOLVED) break;
    await resolvedProposal(candidate, RESOLVED_STATUSES[resolved % 3]);
    resolved += 1;
  }

  console.log(
    `Created ${opened.length - countered} open, ${countered} countered and ${resolved} resolved reschedule proposals`,
  );
}
