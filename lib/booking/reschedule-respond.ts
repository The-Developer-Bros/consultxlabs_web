/**
 * The counterparty's answer to a reschedule proposal — the half of the loop
 * #1064 never shipped (#1163). ACCEPTED and DECLINED existed only as enum
 * members: the sole DECLINED writer was the cancel route closing proposals as
 * a side-effect, ACCEPTED only ever arrived as a by-product of the consultant
 * allocating, and the consultee had no way to answer at all while the
 * consultant's toast claimed "the consultee has been asked to accept".
 *
 * Accept mirrors auto-confirm's design: the proposed times go straight to the
 * allocator (`manual` mode, wide lock), which performs the full availability /
 * caps / conflict validation under the correct locks — nothing is written
 * unless it commits. The one difference is consent: auto-confirm requires the
 * times to fall inside published availability because nobody is asked;
 * an explicit accept IS the asking, so the initiator-role gate does not apply.
 *
 * Decline deliberately leaves the released slots released (the withdraw
 * module's doc states the rule: the initiator still wants to move, so the
 * booking belongs in the consultant's allocate queue). It is a status
 * transition and nothing else.
 */

import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import type { EventType } from "@/utils/slotAllocation/types";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { transitionRescheduleRequest } from "@/lib/booking/transitions";
import { notifyAppointmentRescheduled } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

export type RespondOutcome =
  | { done: true }
  | { done: false; reason: string };

export async function acceptProposal(args: {
  rescheduleRequestId: string;
  eventType: EventType;
  eventId: string;
  resolvedById: string;
}): Promise<RespondOutcome> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: args.rescheduleRequestId },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      proposedSlots: {
        orderBy: { startsAt: "asc" },
        select: { startsAt: true },
      },
    },
  });
  if (!request) return { done: false, reason: "PROPOSAL_NOT_FOUND" };
  if (request.status !== "PENDING_REVIEW") {
    return { done: false, reason: "PROPOSAL_NOT_OPEN" };
  }
  // The status alone does not mean "still answerable": `expireRescheduleProposals`
  // runs hourly, so a lapsed proposal stays PENDING_REVIEW for up to an hour.
  // Honouring the deadline here matters beyond tidiness — expiry is
  // min(now + 72h, earliest released session − 24h), so accepting a lapsed
  // proposal is exactly how a booking lands inside the 24-hour window the
  // reschedule route refuses to move it into.
  //
  // The window between this read and the ACCEPTED write needs no lock of its
  // own: EXPIRED is not in `RESCHEDULE_ALLOWED_FROM.ACCEPTED`, so a cron that
  // wins that race makes the final CAS transition fail rather than accept.
  if (request.expiresAt.getTime() <= Date.now()) {
    return { done: false, reason: "PROPOSAL_EXPIRED" };
  }
  if (request.proposedSlots.length === 0) {
    // A preference-only request (#1065) proposes no concrete times — there is
    // nothing to accept as-is; the consultant answers it by allocating.
    return { done: false, reason: "NO_PROPOSED_TIMES" };
  }

  const result = await SlotAllocationService.allocate({
    eventType: args.eventType,
    eventId: args.eventId,
    mode: "manual",
    slots: request.proposedSlots.map((p) => p.startsAt.toISOString()),
    // Same reasoning as auto-confirm: these times were not day-picked by a
    // human on the grid, so the day-sharded key would let two concurrent
    // confirmations pass a per-week cap on stale counts.
    wideLock: true,
    // #1340 — same exclusion as auto-confirm: the allocator declines every open
    // proposal these released slots carry, and this one is being ACCEPTED, not
    // superseded. Without it the ACCEPTED CAS below lost against a row the
    // allocator had just declined, so the consultee saw a 409 (and no MOVED
    // notification) on a booking that had moved.
    excludeRescheduleRequestId: request.id,
  });
  if (!result.success) {
    // Nothing was written; the proposal stays open.
    return { done: false, reason: result.errorCode ?? "VALIDATION_FAILED" };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await transitionRescheduleRequest(tx, {
        where: { id: request.id },
        to: "ACCEPTED",
        data: { resolvedById: args.resolvedById },
      });
    });
  } catch (err) {
    const isLostRace = err instanceof IllegalTransitionError;
    // Same shape as auto-confirm's finalize: the booking moved, the paperwork
    // must not silently fail to catch up.
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-accept",
      expected: isLostRace,
      extra: { rescheduleRequestId: args.rescheduleRequestId },
    });
    throw err;
  }

  // PR 2c (audit G2) — the answer finally travels back to the initiator:
  // they proposed, the other party accepted, the booking HAS MOVED. Payload
  // uses the MOVED arm (old = earliest released slot's original time; new =
  // the first proposed time). Fire-and-forget; a Novu outage must not fail
  // the accept.
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: args.rescheduleRequestId },
      select: {
        initiatedById: true,
        appointment: {
          select: {
            organizationId: true,
            appointmentType: true,
            consultation: {
              select: {
                requestedBy: { select: { user: { select: { id: true, name: true } } } },
                consultationPlan: {
                  select: {
                    title: true,
                    consultantProfile: { select: { user: { select: { id: true, name: true } } } },
                  },
                },
              },
            },
            subscription: {
              select: {
                requestedBy: { select: { user: { select: { id: true, name: true } } } },
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: { select: { user: { select: { id: true, name: true } } } },
                  },
                },
              },
            },
          },
        },
        releasedSlotIds: true,
        proposedSlots: { orderBy: { startsAt: "asc" }, take: 1, select: { startsAt: true } },
      },
    });
    const appt = detail?.appointment;
    const side = appt?.consultation ?? appt?.subscription;
    const released = detail?.releasedSlotIds?.length
      ? await prisma.slotOfAppointment.findFirst({
          where: { id: { in: detail.releasedSlotIds } },
          orderBy: { startsAt: "asc" },
          select: { startsAt: true },
        })
      : null;
    if (detail && appt && side && released && detail.proposedSlots[0]) {
      // Normalize the consultation/subscription union once (TS narrows via
      // the plan-key discriminators).
      const isConsultation = "consultationPlan" in side;
      const planTitle = isConsultation
        ? side.consultationPlan.title
        : side.subscriptionPlan.title;
      const consultantUser = isConsultation
        ? side.consultationPlan.consultantProfile.user
        : side.subscriptionPlan.consultantProfile.user;
      const consulteeUser = side.requestedBy.user;
      const recipient = detail.initiatedById;
      const other =
        consulteeUser.id === detail.initiatedById
          ? consultantUser.id
          : consulteeUser.id;
      const userIds = [recipient, other].filter(
        (id): id is string => !!id && id !== recipient,
      );
      void notifyAppointmentRescheduled([recipient, ...userIds], {
        ...notificationScope(appt.organizationId),
        appointmentType: appt.appointmentType,
        consultantName: consultantUser.name || "Consultant",
        consulteeName: consulteeUser.name || "Consultee",
        planTitle,
        dashboardUrl: notificationHref(appt.organizationId, "appointments"),
        outcome: "MOVED",
        oldDateTime: released.startsAt.toISOString(),
        newDateTime: detail.proposedSlots[0].startsAt.toISOString(),
      });
    }
  } catch (notifyErr) {
    await import("@/lib/observability/report").then((m) =>
      m.reportSentryError(
        notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
        { subsystem: "bookings", op: "reschedule-accept-notify", expected: true },
      ),
    ).catch(() => {});
  }

  return { done: true };
}

export async function declineProposal(args: {
  rescheduleRequestId: string;
  resolvedById: string;
}): Promise<RespondOutcome> {
  try {
    await prisma.$transaction(async (tx) => {
      await transitionRescheduleRequest(tx, {
        where: { id: args.rescheduleRequestId },
        to: "DECLINED",
        data: { resolvedById: args.resolvedById },
      });
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return { done: false, reason: "PROPOSAL_NOT_OPEN" };
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-decline",
      extra: { rescheduleRequestId: args.rescheduleRequestId },
    });
    throw err;
  }

  // PR 2e — the initiator learns their proposal was declined. The booking
  // stays at its original times; slots released by the proposal remain in
  // the consultant's allocate queue.
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: args.rescheduleRequestId },
      select: {
        initiatedById: true,
        appointment: {
          select: {
            organizationId: true,
            appointmentType: true,
            consultation: {
              select: {
                requestedBy: { select: { user: { select: { id: true, name: true } } } },
                consultationPlan: {
                  select: {
                    title: true,
                    consultantProfile: { select: { user: { select: { id: true, name: true } } } },
                  },
                },
              },
            },
            subscription: {
              select: {
                requestedBy: { select: { user: { select: { id: true, name: true } } } },
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: { select: { user: { select: { id: true, name: true } } } },
                  },
                },
              },
            },
          },
        },
        releasedSlotIds: true,
      },
    });
    const appt = detail?.appointment;
    const side = appt?.consultation ?? appt?.subscription;
    if (detail && side && appt) {
      const isConsultation = "consultationPlan" in side;
      const planTitle = isConsultation
        ? side.consultationPlan.title
        : side.subscriptionPlan.title;
      const consultantUser = isConsultation
        ? side.consultationPlan.consultantProfile.user
        : side.subscriptionPlan.consultantProfile.user;
      void notifyAppointmentRescheduled(
        [detail.initiatedById, consultantUser.id, side.requestedBy.user.id].filter(
          (id, i, arr) => arr.indexOf(id) === i,
        ),
        {
          ...notificationScope(appt.organizationId),
          appointmentType: appt.appointmentType,
          consultantName: consultantUser.name || "Consultant",
          consulteeName: side.requestedBy.user.name || "Consultee",
          planTitle,
          dashboardUrl: notificationHref(appt.organizationId, "appointments"),
          outcome: "DECLINED",
        },
      );
    }
  } catch (notifyErr) {
    reportSentryError(notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)), {
      subsystem: "bookings",
      op: "reschedule-decline-notify",
      expected: true,
    });
  }

  return { done: true };
}
