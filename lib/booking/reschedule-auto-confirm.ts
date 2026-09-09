/**
 * Auto-confirmation of a consultee's reschedule proposal.
 *
 * This is the piece that makes rescheduling feel immediate rather than
 * bureaucratic: when a consultee picks a time inside the consultant's published
 * availability and both calendars are free, there is nothing for the consultant
 * to decide, so nothing is asked of them. Publishing availability IS the
 * consent. A consultant-initiated proposal never takes this path — being free
 * at a time is not consent to be moved to it.
 *
 * Rather than re-deriving the consultant profile, plan config, weekly caps and
 * both parties' calendars, this writes the proposed times onto the released slot
 * rows and then runs the ordinary `requested` allocation, which already performs
 * the full validation under the correct locks. If that rejects the times, the
 * rows are restored and the proposal simply stays PENDING_REVIEW for the
 * consultant to answer — a proposal failing to auto-confirm is an ordinary
 * outcome, not an error.
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import type { EventType } from "@/utils/slotAllocation/types";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import { transitionRescheduleRequest } from "@/lib/booking/transitions";
import { mayAutoConfirm } from "@/lib/booking/reschedule-proposals";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
} from "@/utils/appointmentlock";

export type AutoConfirmOutcome =
  | { confirmed: true }
  | { confirmed: false; reason: string };

/**
 * @param rescheduleRequestId the proposal to try
 * @param eventType which allocation flow owns the appointment
 * @param eventId the consultation/subscription id, not the appointment id
 */
export async function tryAutoConfirmProposal(
  rescheduleRequestId: string,
  eventType: EventType,
  eventId: string,
): Promise<AutoConfirmOutcome> {
  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      appointmentId: true,
      initiatorRole: true,
      status: true,
      releasedSlotIds: true,
      proposedSlots: {
        orderBy: { startsAt: "asc" },
        select: { startsAt: true, endsAt: true },
      },
    },
  });

  if (!request) return { confirmed: false, reason: "PROPOSAL_NOT_FOUND" };
  if (request.status !== "PENDING_REVIEW") {
    return { confirmed: false, reason: "PROPOSAL_NOT_OPEN" };
  }
  if (!mayAutoConfirm(request.initiatorRole)) {
    return { confirmed: false, reason: "CONSULTANT_INITIATED" };
  }
  // Deliberately NOT comparing proposed count to released count. The allocator
  // is handed the times as a set and validates them as one; pairing them
  // one-to-one only ever made sense while we were writing each proposed time
  // onto a specific released row, which we no longer do.

  // #1340 — hold the appointment atom across the allocation AND the
  // AUTO_ACCEPTED write. Cancel and reschedule already serialise on it; the
  // allocator's own locks are keyed by consultant and consultee, so without
  // this an auto-confirm could interleave with a concurrent cancel of the same
  // booking. The route calls this helper after releasing its own grant, so
  // this is the only holder — no nesting, same lock order as accept.
  try {
    return await withAppointmentLock(request.appointmentId, async () => {
      const result = await SlotAllocationService.allocate({
        eventType,
        eventId,
        // The proposed times go STRAIGHT to the allocator. Nothing is written until
        // it commits.
        //
        // This used to stamp the times onto the released slot rows, run the
        // allocator in "requested" mode so it would read them back, and restore the
        // originals from an in-memory snapshot if validation rejected them. Two
        // ways that broke: the finalize step below ran in its own transaction, so
        // failing it left a confirmed booking whose proposal never closed —
        // openForAppointmentId still set, blocking every later reschedule of that
        // appointment. And a crash anywhere in between left the rows holding
        // proposed times with the originals only ever in RAM, unrecoverable.
        //
        // Manual mode already accepts explicit times, and on a reschedule
        // deleteExistingAppointments removes only TENTATIVE slots — which is
        // exactly the released ones — so confirmed sessions elsewhere in the
        // booking survive untouched.
        mode: "manual",
        slots: request.proposedSlots.map((p) => p.startsAt.toISOString()),
        // Consultant-wide lock: these times were not picked per-day by a human, so
        // the day-sharded manual key would let two concurrent confirmations each
        // pass the per-week cap on a stale count (#860 shards for throughput; GiST
        // backstops overlap, but a cap is a count, not an overlap).
        wideLock: true,
        // #1340 — the allocator closes every open proposal on these released slots
        // as DECLINED, because placing times supersedes them. THIS proposal is the
        // one being confirmed, not superseded: without the exclusion it was
        // DECLINED inside the allocator's transaction, the AUTO_ACCEPTED CAS below
        // matched zero rows, and the route reported `autoConfirmed: false` on a
        // booking that had already moved.
        excludeRescheduleRequestId: request.id,
      });

      if (!result.success) {
        // Nothing was written, so there is nothing to undo. The released slots are
        // untouched and still carry their original times; the request stays open
        // for the consultant to answer.
        return {
          confirmed: false,
          reason: result.errorCode ?? "VALIDATION_FAILED",
        };
      }

      try {
        await prisma.$transaction(async (tx) => {
          await transitionRescheduleRequest(tx, {
            where: { id: request.id },
            to: "AUTO_ACCEPTED",
            // AUTO_ACCEPTED has no allowed-from in the map: it is normally only ever
            // written at creation. This is that write, arriving one step late because
            // validation had to run outside the creating transaction.
            fromIn: ["PENDING_REVIEW"],
          });
        });
      } catch (err) {
        // A lost race (the proposal was answered or expired concurrently) is the
        // ordinary outcome this CAS guard models by throwing. Anything else means
        // the reallocation above already succeeded but the proposal's bookkeeping
        // never caught up — the booking is correct, its paperwork is not.
        const isLostRace = err instanceof IllegalTransitionError;
        reportSentryError(err, {
          subsystem: "bookings",
          op: "reschedule-auto-confirm",
          expected: isLostRace,
          extra: { phase: "finalize", rescheduleRequestId, eventType, eventId },
        });
        throw err;
      }

      return { confirmed: true };
    });
  } catch (err) {
    // Auto-confirm is best effort: a busy appointment or an unreachable lock
    // service leaves the proposal PENDING_REVIEW for the consultant, exactly
    // like a validation refusal, rather than failing the reschedule request.
    if (err instanceof AppointmentBusyError) {
      return { confirmed: false, reason: "APPOINTMENT_BUSY" };
    }
    if (err instanceof BookingLockUnavailableError) {
      return { confirmed: false, reason: "BOOKING_LOCK_UNAVAILABLE" };
    }
    throw err;
  }
}
