/**
 * #appt-support — build the immutable SupportContext for a thread. Resolved once
 * per turn and passed to whichever resolver (flowchart / AI / human), so none of
 * them re-query or diverge, and a hand-off never loses context.
 */

import prisma from "@/lib/prisma";
import { computeRefundPct } from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import type { SupportContext, SupportStage } from "./types";

/**
 * Assemble the context for (appointment, user). Returns null if the appointment
 * doesn't exist. Trusts its caller for authz (the user must participate).
 */
export async function buildSupportContext(
  threadId: string,
  appointmentId: string,
  userId: string,
): Promise<SupportContext | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      appointmentType: true,
      organizationId: true,
      cancellationPolicy: POLICY_TERMS_INCLUDE,
      slotsOfAppointment: {
        // Current-or-next active slot only — a past SCHEDULED row would
        // otherwise drive stage/startsAt/endsAt stale when a rebooked slot
        // exists.
        where: { completionStatus: "SCHEDULED", endsAt: { gt: new Date() } },
        orderBy: { startsAt: "asc" },
        take: 1,
        select: { startsAt: true, endsAt: true },
      },
      payment: {
        where: { paymentStatus: "SUCCEEDED", amount: { gt: 0 } },
        select: { id: true, amount: true },
        take: 1,
      },
      consultation: {
        select: { consultationPlan: { select: { consultantProfileId: true } } },
      },
      subscription: {
        select: { subscriptionPlan: { select: { consultantProfileId: true } } },
      },
      webinar: {
        select: { webinarPlan: { select: { consultantProfileId: true } } },
      },
      class: {
        select: { classPlan: { select: { consultantProfileId: true } } },
      },
    },
  });
  if (!appt) return null;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { consultantProfileId: true },
  });

  const planConsultantId =
    appt.consultation?.consultationPlan?.consultantProfileId ??
    appt.subscription?.subscriptionPlan?.consultantProfileId ??
    appt.webinar?.webinarPlan?.consultantProfileId ??
    appt.class?.classPlan?.consultantProfileId ??
    null;
  const isProvider =
    !!me?.consultantProfileId && me.consultantProfileId === planConsultantId;

  const startsAt = appt.slotsOfAppointment[0]?.startsAt ?? null;
  // For a COMPLETED session the active-slot read above returns nothing — but
  // the recording-window enforcement still needs a real clock. Fall back to
  // the most recently ENDED scheduled slot (the delivered session's end).
  let endsAt: Date | null = appt.slotsOfAppointment[0]?.endsAt ?? null;
  if (!endsAt) {
    const lastEnded = await prisma.slotOfAppointment.findFirst({
      where: {
        appointmentId,
        completionStatus: "SCHEDULED",
        endsAt: { lte: new Date() },
      },
      orderBy: { endsAt: "desc" },
      select: { endsAt: true },
    });
    endsAt = lastEnded?.endsAt ?? null;
  }

  // Session stage from the slot window. A past slot (or no scheduled slot at
  // all — e.g. cancelled/completed tombstones filtered out above) reads as
  // COMPLETED; a slot whose window contains now is LIVE.
  const now = Date.now();
  const stage: SupportStage = startsAt
    ? endsAt && now >= endsAt.getTime()
      ? "COMPLETED"
      : now >= startsAt.getTime()
        ? "LIVE"
        : "UPCOMING"
    : "COMPLETED";

  // Recordings hang off the slot's meeting session, not the appointment directly
  // (Recording → MeetingSession → SlotOfAppointment → Appointment).
  const recording = await prisma.recording.findFirst({
    where: { meetingSession: { slotOfAppointment: { appointmentId } } },
    select: { id: true },
  });

  // Policy refund % if cancelled now (consultee-initiated). Only meaningful when
  // there is a start time to measure notice against; the caller re-derives the real
  // amount at execution time (this is a preview for the flow). #1499 — the guard no
  // longer requires a stored policy: a booking with none is governed by the platform
  // ladder, so the percentage is knowable either way.
  let refundPctIfCancelledNow: number | null = null;
  if (startsAt) {
    const hoursUntilStart = (startsAt.getTime() - Date.now()) / 3_600_000;
    refundPctIfCancelledNow = computeRefundPct(
      termsFromPolicyRow(appt.cancellationPolicy),
      hoursUntilStart,
      false,
    );
  }

  // Org-operator party: an ACTIVE membership with operations.read on this
  // appointment's org. This is the ONLY org-side elevation in support — it
  // lets an operator open their own org-party thread (dispute intents); it
  // never grants access to anyone else's transcript (ADR 20).
  let isOrgOperator = false;
  if (appt.organizationId) {
    const membership = await prisma.membership.findFirst({
      where: {
        userId,
        organizationId: appt.organizationId,
        status: "ACTIVE",
      },
      select: { role: true },
    });
    isOrgOperator =
      !!membership && hasOrgPermission(membership.role, "operations.read");
  }

  return {
    threadId,
    appointmentId: appt.id,
    userId,
    organizationId: appt.organizationId,
    appointmentType: appt.appointmentType,
    isOrgContext: appt.organizationId !== null,
    isProvider,
    isOrgOperator,
    stage,
    startsAt,
    endsAt,
    refundPctIfCancelledNow,
    paymentId: appt.payment[0]?.id ?? null,
    // moneyResultExtensions has already converted the BigInt column → number paise.
    paymentAmountPaise: appt.payment[0]?.amount ?? null,
    hasRecording: !!recording,
  };
}
