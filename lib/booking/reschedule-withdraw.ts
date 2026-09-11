import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionConsultationRequest,
  transitionRescheduleRequest,
  transitionSlotCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { notifyAppointmentRescheduled } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";

/**
 * The initiator takes their own reschedule back, and the booking returns to
 * exactly what it was.
 *
 * ONLY withdrawal restores. Decline and expiry deliberately leave the slots
 * released: in both of those the consultee still wants to move and the
 * consultant simply has not agreed a time, so the booking belongs in their
 * allocate queue. A withdrawal is the opposite — the person who asked no
 * longer wants it, so nothing should have moved.
 *
 * This is cheap for one reason worth stating: a reschedule never rewrites
 * `startsAt`. The released rows still carry their original times, so restoring
 * is flipping two flags, not replaying data from a snapshot. (Auto-confirm is
 * the only path that ever wrote proposed times onto rows, and it no longer
 * does — it hands them to the allocator instead.)
 */
export async function withdrawRescheduleRequest(args: {
  rescheduleRequestId: string;
  /** Must be the initiator. The caller is responsible for proving that. */
  withdrawnById: string;
}): Promise<{ withdrawn: boolean; reason?: string }> {
  const { rescheduleRequestId, withdrawnById } = args;

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      status: true,
      initiatedById: true,
      releasedSlotIds: true,
      appointmentId: true,
      appointment: {
        select: {
          consultationId: true,
          subscriptionId: true,
        },
      },
    },
  });

  if (!request) return { withdrawn: false, reason: "PROPOSAL_NOT_FOUND" };

  // Withdrawal is the initiator's alone. The other side already has Decline,
  // which ends the same request with a different meaning and a different
  // outcome for the slots — giving them this too would just be a second
  // Decline wearing a friendlier word.
  if (request.initiatedById !== withdrawnById) {
    return { withdrawn: false, reason: "NOT_INITIATOR" };
  }
  if (!RESCHEDULE_OPEN_STATUSES.includes(request.status)) {
    return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
  }

  let restored = 0;
  try {
    await prisma.$transaction(async (tx) => {
      // The CAS is the guard: if the other party answered while we were
      // deciding, this matches zero rows and throws rather than un-releasing
      // slots that a concurrent accept has already re-confirmed.
      await transitionRescheduleRequest(tx, {
        actorUserId: withdrawnById,
        appointmentId: request.appointmentId,
        where: { id: request.id },
        to: "WITHDRAWN",
        data: { resolvedById: withdrawnById },
      });

      // Reverses exactly what the reschedule did to these rows. The from-set
      // rides in `fromIn` rather than the WHERE (the helper overwrites
      // `completionStatus` there), and `allowZero` keeps the outcome below
      // intact: restoring nothing means the released rows are gone, which is
      // what an allocation replacing them does, not a lost CAS.
      // No appointmentId: a whole-subscription reschedule releases slots across
      // sibling appointments, so each row's history belongs to the appointment
      // it actually sits on, not to the one the proposal was opened against.
      restored = await transitionSlotCompletion(tx, {
        actorUserId: withdrawnById,
        where: { id: { in: request.releasedSlotIds } },
        to: "SCHEDULED",
        data: { isTentative: false },
        fromIn: ["RESCHEDULED"],
        allowZero: true,
      });

      // A consultation reschedule sends the booking back to PENDING so it
      // re-enters the consultant's queue; withdrawing has to undo that or the
      // consultee is left with a confirmed-looking booking still sitting in
      // someone's inbox.
      //
      // fromIn narrows to PENDING rather than the map's default: this edge is
      // only ever undoing the reschedule's own flip, so an APPROVED booking
      // reaching here means the state moved under us and should throw, not be
      // re-stamped.
      if (request.appointment?.consultationId) {
        await transitionConsultationRequest(tx, {
          actorUserId: withdrawnById,
          appointmentId: request.appointmentId,
          where: { id: request.appointment.consultationId },
          to: "APPROVED",
          fromIn: ["PENDING"],
        });
      }

      // E2E-audit P1 fix — subscriptions need the same undo. #448 kept
      // PARTIAL subscription reschedules from flipping the parent, but the
      // whole-booking reschedule (no slotIds) DOES flip it to PENDING via the
      // reschedule route. Leaving a withdrawn, paid plan in PENDING strands
      // it in the consultant's request queue, where expirePendingSubscriptions
      // can EXPIRE + refund a plan that still owes (or already delivered)
      // sessions. Restore only when the parent actually sits in PENDING —
      // i.e., this proposal was a whole-booking flip; partial proposals left
      // the parent APPROVED and must not be touched (#448). The CAS keeps the
      // concurrent-answer race modelled.
      if (request.appointment?.subscriptionId) {
        const sub = await tx.subscription.findUnique({
          where: { id: request.appointment.subscriptionId },
          select: { status: true },
        });
        if (sub?.status === "PENDING") {
          await transitionSubscriptionRequest(tx, {
            actorUserId: withdrawnById,
            appointmentId: request.appointmentId,
            where: { id: request.appointment.subscriptionId },
            to: "APPROVED",
            fromIn: ["PENDING"],
          });
        }
      }
    });
  } catch (err) {
    // A lost CAS is a MODELLED outcome, not a fault: the other party accepted
    // or declined while this withdrawal was in flight. Reporting it as an error
    // would page on ordinary two-party contention, and the route would answer
    // 500 instead of the 409 this actually is.
    if (err instanceof IllegalTransitionError) {
      return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-withdraw",
      extra: { rescheduleRequestId, releasedSlotIds: request.releasedSlotIds },
    });
    throw err;
  }

  // The CAS moves RESCHEDULED rows only, so a row whose status drifted stays
  // released while the request is already WITHDRAWN — a half-restored booking
  // that otherwise reports success and shows nothing anywhere. The withdrawal
  // itself is committed and correct, so this reports rather than throws.
  //
  // Restoring NOTHING is a different animal and must not page: it means the
  // released rows are simply gone, which is what an allocation replacing them
  // does. Withdrawing after that is a no-op the user cannot have intended, not
  // a fault in this code. A PARTIAL restore is the genuine anomaly the check
  // was written for, because it leaves one booking in two states at once.
  if (restored !== request.releasedSlotIds.length) {
    reportSentryError(
      new Error(
        `Withdrawal restored ${restored} of ${request.releasedSlotIds.length} released slots.`,
      ),
      {
        subsystem: "bookings",
        op: "reschedule-withdraw-partial",
        expected: restored === 0,
        extra: {
          rescheduleRequestId,
          releasedSlotIds: request.releasedSlotIds,
          restored,
        },
      },
    );
  }

  // PR 2e — the initiator withdrew their own proposal; both parties learn
  // the booking stays at its original times. Fire-and-forget.
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: rescheduleRequestId },
      select: {
        initiatedById: true,
        appointment: {
          select: {
            organizationId: true,
            appointmentType: true,
            consultation: {
              select: {
                requestedBy: {
                  select: { user: { select: { id: true, name: true } } },
                },
                consultationPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { user: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
            subscription: {
              select: {
                requestedBy: {
                  select: { user: { select: { id: true, name: true } } },
                },
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { user: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
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
      const consulteeUser = side.requestedBy.user;
      void notifyAppointmentRescheduled(
        [detail.initiatedById, consultantUser.id, consulteeUser.id].filter(
          (id, i, arr) => arr.indexOf(id) === i,
        ),
        {
          ...notificationScope(appt.organizationId),
          appointmentType: appt.appointmentType,
          consultantName: consultantUser.name || "Consultant",
          consulteeName: consulteeUser.name || "Consultee",
          planTitle,
          dashboardUrl: notificationHref(appt.organizationId, "appointments"),
          outcome: "WITHDRAWN",
        },
      );
    }
  } catch (notifyErr) {
    reportSentryError(
      notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
      {
        subsystem: "bookings",
        op: "reschedule-withdraw-notify",
        expected: true,
      },
    );
  }

  return { withdrawn: true };
}
