import { RecordingConsentDecision } from "@prisma/client";

import prisma from "@/lib/prisma";
import {
  isRecordingEnabledForAppointment,
  type AppointmentWithOwnership,
} from "@/lib/stream/recording-utils";

/**
 * #1134 P1-7 — recording consent.
 *
 * The consultee used to discover a session was being recorded from a passive
 * `REC hh:mm` pill that appeared once recording was already running. No pre-join
 * notice, no way to refuse, no record that anyone had been told.
 *
 * Two regimes, because one rule cannot be honest for both:
 *
 *   1:1   (consultation / subscription / trial) — a genuine opt-out. Declining
 *         does not cost you the session you paid for; it blocks recording. If a
 *         refusal has no effect it is not consent, and a 1:1 here is a career or
 *         health conversation.
 *
 *   GROUP (webinar / class) — notice and acknowledgement. The recording IS the
 *         product: attendees buy the replay, and it was disclosed at purchase.
 *         One attendee cannot veto what 199 others paid for, so declining means
 *         not attending, with a route to a refund.
 */

/** Bump when the notice wording changes materially. Stamped on every decision. */
export const RECORDING_NOTICE_VERSION = 1;

export type ConsentRegime = "OPT_OUT" | "ACKNOWLEDGE";

export interface RecordingNotice {
  /** False when the plan has recording off — no notice, no prompt, no gate. */
  required: boolean;
  regime: ConsentRegime;
  noticeVersion: number;
  /** The caller's standing decision, if they have already made one. */
  decision: RecordingConsentDecision | null;
}

/**
 * A group session is one where the recording is part of what was bought.
 * Anything else is a 1:1 and gets the real opt-out.
 */
export function consentRegimeFor(
  appointment: AppointmentWithOwnership | null | undefined,
): ConsentRegime {
  const isGroup = Boolean(appointment?.webinar || appointment?.class);
  return isGroup ? "ACKNOWLEDGE" : "OPT_OUT";
}

/**
 * What the lobby needs to render, and what Join should gate on.
 *
 * `required: false` when the plan has recording disabled — then there is nothing
 * to disclose and nothing to block, which keeps the prompt off the overwhelming
 * majority of sessions.
 */
export async function getRecordingNotice(
  meetingSessionId: string,
  userId: string,
  appointment: AppointmentWithOwnership | null | undefined,
): Promise<RecordingNotice> {
  const regime = consentRegimeFor(appointment);

  if (!isRecordingEnabledForAppointment(appointment)) {
    return {
      required: false,
      regime,
      noticeVersion: RECORDING_NOTICE_VERSION,
      decision: null,
    };
  }

  const existing = await prisma.meetingRecordingConsent.findUnique({
    where: { meetingSessionId_userId: { meetingSessionId, userId } },
    select: { decision: true },
  });

  return {
    required: true,
    regime,
    noticeVersion: RECORDING_NOTICE_VERSION,
    decision: existing?.decision ?? null,
  };
}

/**
 * Record a decision. Idempotent on (session, user) — changing your mind updates
 * the row rather than stacking a second one, and `decidedAt` moves with it so
 * the record always reflects the standing answer.
 */
export async function recordRecordingConsent(
  meetingSessionId: string,
  userId: string,
  decision: RecordingConsentDecision,
): Promise<void> {
  const now = new Date();
  await prisma.meetingRecordingConsent.upsert({
    where: { meetingSessionId_userId: { meetingSessionId, userId } },
    create: {
      meetingSessionId,
      userId,
      decision,
      decidedAt: now,
      noticeVersion: RECORDING_NOTICE_VERSION,
    },
    update: {
      decision,
      decidedAt: now,
      noticeVersion: RECORDING_NOTICE_VERSION,
    },
  });
}

export interface RecordingBlock {
  blocked: boolean;
  /** Host-facing explanation. Never names who declined. */
  reason?: string;
}

/**
 * The gate `POST /api/stream/recordings/start` consults.
 *
 * Only 1:1 sessions can be blocked — a group session's recording is the product
 * and its attendees acknowledged rather than consented, so there is nothing to
 * veto.
 *
 * The reason string is deliberately anonymous. Telling a consultant WHICH
 * participant refused would make refusing socially costly, which is the same as
 * not offering the choice.
 */
/**
 * SCOPE — enforcement is START-TIME ONLY, deliberately, and the contract should
 * not be read as stronger than that.
 *
 * This is the pre-claim half of what ought to be two-part enforcement. It is
 * consulted by `POST /api/stream/recordings/start` before the recording claim,
 * so a session with any DECLINED decision can never BEGIN recording. It does
 * nothing about a decision that changes after a recording is already live.
 *
 * That gap is reachable rather than theoretical. `recordRecordingConsent`
 * upserts, so a participant who granted in the lobby can switch to DECLINED at
 * any point, and a participant who joins late can decline while a recording the
 * host started earlier keeps running. In the OPT_OUT regime that means a refusal
 * has no effect for the remainder of the session, which is not what "opt out"
 * promises.
 *
 * Closing it means the decline path reading `MeetingSession.isRecording` and, if
 * a recording is live, stopping it through the same route the stop endpoint uses
 * and clearing `isRecording` / `recordingStartedAt` / `recordingStartedBy`. That
 * is a product decision, not a refactor: it hands any participant the ability to
 * terminate a host's in-progress recording mid-call, and the failure mode of
 * getting it wrong is a consultant losing a session they believed was recorded.
 * It is tracked rather than guessed at.
 *
 * SECOND, LOUDER SCOPE LIMIT — this gate guards an HTTP ROUTE, not Stream.
 *
 * `POST /api/stream/recordings/start` is the only caller, and a participant who
 * can reach the Stream SDK directly does not go through it. On the LIVE call
 * type, `call_member` — the role every participant is granted at join — still
 * holds `start-recording` and `stop-recording`, so `call.startRecording()` from
 * devtools walks straight past this 409.
 *
 * #1136 ships `scripts/stream/ensure-call-type-grants.ts`, which strips both
 * permissions from `user`, `guest` AND `call_member`. That script is an OPERATOR
 * ACTION and merging #1136 does not run it. Until someone runs it with `--apply`
 * against the shared Stream app, this consent feature is advisory. Verify with
 * the dry run before believing otherwise; it prints the live grants.
 */
export async function getRecordingBlock(
  meetingSessionId: string,
  appointment: AppointmentWithOwnership | null | undefined,
): Promise<RecordingBlock> {
  if (consentRegimeFor(appointment) !== "OPT_OUT") return { blocked: false };

  const declined = await prisma.meetingRecordingConsent.count({
    where: { meetingSessionId, decision: RecordingConsentDecision.DECLINED },
  });

  if (declined > 0) {
    return {
      blocked: true,
      reason:
        "Recording is unavailable for this session because a participant declined to be recorded.",
    };
  }
  return { blocked: false };
}

/** Re-exported so callers need one import for the whole consent surface. */
export { resolveAppointmentPlan } from "@/lib/stream/recording-utils";
