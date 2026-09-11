/**
 * The Stream webhook events this app handles.
 *
 * Deliberately in its OWN dependency-free module. It is imported both by
 * `lib/stream/webhook-dispatch.ts` (which transitively pulls in Prisma, Supabase
 * and `server-only`) and by `scripts/stream/ensure-webhook-subscription.ts`,
 * which runs as a bare tsx process and cannot load any of that.
 *
 * One list, two consumers — so the code that HANDLES an event and the script
 * that SUBSCRIBES to it can never drift. #1134 found them four apart: the live
 * hook carried six event types while the dispatcher handled ten, so
 * MeetingAttendance and every chat moderation flag were dead code.
 */
export const HANDLED_EVENT_TYPES = [
  // Recording events
  "call.recording_started",
  "call.recording_stopped",
  "call.recording_ready",
  "call.recording_failed",
  // Session events
  "call.session_ended",
  "call.ended",
  // STR-4 — per-attendee presence (unblocks #471 no-show / #472 overrun)
  "call.session_participant_joined",
  "call.session_participant_left",
  // #1270 — `user.flagged` / `message.flagged` were removed deliberately, and
  // NOT replaced with a chat hook. Three reasons: the in-app report button
  // already writes the ModerationReport itself via POST /api/report, so the
  // webhook was a second path to the same row that double-counted it; automod
  // is disabled on both channel types, so there are no automated flags to
  // receive; and Stream considers `message.flagged` obsolete under v2
  // moderation, which uses `review_queue_item.*` instead. Subscribing to a
  // deprecated event to feed a path that already works was the wrong trade.
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];
