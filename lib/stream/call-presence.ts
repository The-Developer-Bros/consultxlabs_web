/**
 * Ask Stream who was actually in a call.
 *
 * #1280 — the consultant no-show detector decides on the ABSENCE of a
 * `MeetingAttendance` row. Those rows are written by
 * `call.session_participant_joined` webhooks, and each party's row arrives in
 * its own delivery, potentially to a different Netlify instance. Lose only the
 * consultant's and the predicate "consultee has a row, consultant does not" is
 * satisfied exactly — the booking is CAS-cancelled and refunded in full against
 * a consultant who attended. It is idempotent, so it will not double-refund, but
 * reversing it means manually re-charging a customer.
 *
 * That this has not happened yet is luck: the webhook endpoint rejected every
 * delivery for months, so there are no attendance rows at all and the detector
 * has never had a candidate. It becomes live the moment attendance starts
 * working.
 *
 * Stream holds the same fact independently, and does not depend on our webhook
 * pipeline having worked. `report.participants.unique` is the count of distinct
 * participants in the session — so two, in a 1:1 consultation, means both
 * parties were there whatever our rows say.
 */
import {
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { streamLogger } from "@/lib/stream-logger";

export interface CallPresenceEvidence {
  /** Distinct participants Stream saw in the session. */
  unique: number;
  /** Most participants present at the same moment, when Stream reports it. */
  maxConcurrent: number | null;
}

/**
 * What Stream says about attendance for a call, or `null` when it cannot say.
 *
 * `null` is NOT "nobody attended". It means Stream has no report — the call
 * never had a session, or the report has aged out (they expire at roughly six
 * months, while call *stats* are retained far longer). Callers deciding money
 * must treat `null` as "no evidence" and refuse to act, never as absence.
 */
export async function getCallPresenceEvidence(
  streamCallId: string,
): Promise<CallPresenceEvidence | null> {
  try {
    const client = getStreamVideoClient();
    const call = client.video.call(STREAM_CALL_TYPE, toCallId(streamCallId));
    const response = await withStreamCircuitBreaker(() => call.getCallReport());
    const participants = response.report?.participants;
    if (!participants) return null;
    return {
      unique: participants.unique,
      maxConcurrent: participants.max_concurrent ?? null,
    };
  } catch (error) {
    // A missing report and a Stream outage are indistinguishable here, and both
    // mean the same thing to a caller about to move money: we do not know.
    streamLogger.warn("No Stream presence evidence for call", {
      streamCallId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
