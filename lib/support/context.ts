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
import { groupSlotsIntoRuns } from "@/lib/appointments/slots";
import type { SupportContext, SupportStage } from "./types";

/**
 * Intents whose subject is a call that ALREADY HAPPENED.
 *
 * The context used to describe the current-or-next session regardless of what
 * was being asked, which is only right for the forward-looking intents. On a
 * subscription holding up to 24 meetings, a no-show reported for last week was
 * answered with next week's session — its stage, its window, its recording
 * eligibility. Reporting a missed call and being told about a call that has not
 * happened yet is the same confusion #1061 caused elsewhere, one level up.
 *
 * Everything absent from this set is either forward-looking (RESCHEDULE,
 * CANCEL_REFUND) or booking-level (PAYMENT_STATUS, DOCUMENTS, the org rails),
 * and for those the current-or-next session is the correct subject.
 */
const RETROSPECTIVE_CATEGORIES = new Set([
  "NO_SHOW",
  "RECORDING_ACCESS",
  "TECHNICAL",
  "QUALITY_COMPLAINT",
]);

/**
 * Assemble the context for (appointment, user). Returns null if the appointment
 * doesn't exist. Trusts its caller for authz (the user must participate).
 */
export async function buildSupportContext(
  threadId: string,
  appointmentId: string,
  userId: string,
  /**
   * The thread's intent. Decides WHICH session the context is about; omitted
   * callers keep the current-or-next behaviour.
   */
  category?: string | null,
): Promise<SupportContext | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      appointmentType: true,
      organizationId: true,
      cancellationPolicy: POLICY_TERMS_INCLUDE,
      slotsOfAppointment: {
        // Every live row, not the next one. A session is the contiguous RUN of
        // 30-minute rows (#1061), so taking a single row gave a 90-minute
        // meeting a 30-minute window: `endsAt` fell an hour early and the
        // stage flipped to COMPLETED while the call was still running, which
        // is what gates the intents on offer. Grouping below restores the
        // real session bounds.
        where: { completionStatus: "SCHEDULED" },
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          isTentative: true,
          completionStatus: true,
        },
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

  const nowMs = Date.now();
  const runs = groupSlotsIntoRuns(
    appt.slotsOfAppointment.map((slot) => ({ ...slot, appointmentId })),
  );
  /** The session in progress or still to come — the forward-looking subject. */
  const activeRun = runs.find((run) => run.endsAt.getTime() > nowMs) ?? null;
  /** The most recent session that has finished. */
  const lastEndedRun =
    [...runs].reverse().find((run) => run.endsAt.getTime() <= nowMs) ?? null;

  // A retrospective intent is ABOUT the finished call, so that is the session
  // the whole context describes. Everything else keeps the current-or-next
  // session, falling back to the last finished one so a delivered booking
  // still has a real clock for the recording window.
  const subjectRun = RETROSPECTIVE_CATEGORIES.has(category ?? "")
    ? (lastEndedRun ?? activeRun)
    : (activeRun ?? lastEndedRun);

  const startsAt = subjectRun?.startsAt ?? null;
  const endsAt: Date | null = subjectRun?.endsAt ?? null;

  // Session stage from the slot window. A past slot (or no scheduled slot at
  // all — e.g. cancelled/completed tombstones filtered out above) reads as
  // COMPLETED; a slot whose window contains now is LIVE.
  const now = nowMs;
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
  //
  // Measured against the session you would actually be cancelling — the
  // current-or-next one — never the retrospective subject above. A no-show
  // thread must not price a refund off a session that already happened.
  const cancellableFrom = activeRun?.startsAt ?? null;
  let refundPctIfCancelledNow: number | null = null;
  if (cancellableFrom) {
    const hoursUntilStart =
      (cancellableFrom.getTime() - Date.now()) / 3_600_000;
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
