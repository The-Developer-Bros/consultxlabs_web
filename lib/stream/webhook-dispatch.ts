/**
 * Stream webhook event schemas and dispatch.
 *
 * #1134 P1-2 — lives here, not in the route, for one reason: the stuck-event
 * sweeper has to be able to re-drive a Stream event, and a Next route module
 * cannot export anything but its HTTP handlers. The route is now a thin
 * verify-and-acknowledge shell; this is where the work happens, and both the
 * route's `after()` and sweep-stuck-webhook-events call in here.
 */
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { streamLogger } from "@/lib/stream-logger";
import {
  handleRecordingStarted,
  handleRecordingStopped,
  handleRecordingReady,
  handleRecordingFailed,
  StreamRecordingReadyEvent,
  StreamRecordingFailedEvent,
} from "@/lib/stream/recording-handlers";
import {
  handleSessionEnded,
  handleCallEnded,
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
  StreamSessionEndedEvent,
  StreamCallEndedEvent,
  StreamSessionParticipantJoinedEvent,
  StreamSessionParticipantLeftEvent,
} from "@/lib/stream/session-handlers";
import {
  logWebhookEvent,
  markWebhookEventProcessed,
  isDbHealthy,
  permanentFailure,
} from "@/lib/webhooks/event-log";

// Imported AND re-exported: a bare `export … from` creates no local binding,
// so the type and the guard below could not see it. #1141 moved the list into
// its own module so ensure-webhook-subscription.ts can read it too.
import { HANDLED_EVENT_TYPES } from "@/lib/stream/webhook-events";
import { STREAM_CALL_TYPE, callTypeFromCid } from "@/lib/stream/call-cid";
export { HANDLED_EVENT_TYPES };

/**
 * The one list. `processStreamEvent`'s switch is checked against this at compile
 * time via the `never` assertion in its default branch, so adding an entry here
 * without adding a case — or vice versa — fails `tsc` instead of silently
 * dropping the event at runtime. They were two independent lists before.
 */
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(t: string): t is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(t);
}

// Base event schema for all Stream webhook events
// call_cid is optional because chat moderation events don't include it
export const streamBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string().optional(),
  created_at: z.string(),
});

// Base schema for call/video events (call_cid required)
const streamCallBaseEventSchema = z.object({
  type: z.string(),
  call_cid: z.string(),
  created_at: z.string(),
});

// Recording ready event schema
const streamRecordingReadySchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_ready"),
  call_recording: z.object({
    filename: z.string(),
    url: z.string(),
    start_time: z.string(),
    end_time: z.string(),
  }),
});

// Recording failed event schema
const streamRecordingFailedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_failed"),
  error: z
    .object({
      message: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});

// Recording started schema
const streamRecordingStartedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_started"),
  user: z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .optional(),
});

// Recording stopped schema
const streamRecordingStoppedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.recording_stopped"),
});

// Session ended schema
const streamSessionEndedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_ended"),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().optional(),
    })
    .optional(),
});

// Call ended schema
const streamCallEndedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.ended"),
  call: z
    .object({
      id: z.string(),
      type: z.string(),
      created_by_user_id: z.string().optional(),
    })
    .optional(),
  ended_by_user_id: z.string().optional(),
});

// STR-4 — participant joined/left. We only need the nested app user id
// (participant.user.id) + session_id; everything else is passed through loosely.
const streamParticipantSchema = z.object({
  user: z.object({ id: z.string() }),
  user_session_id: z.string().optional(),
  role: z.string().optional(),
});

const streamSessionParticipantJoinedSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_participant_joined"),
  session_id: z.string(),
  participant: streamParticipantSchema,
});

const streamSessionParticipantLeftSchema = streamCallBaseEventSchema.extend({
  type: z.literal("call.session_participant_left"),
  session_id: z.string(),
  duration_seconds: z.number().optional(),
  participant: streamParticipantSchema,
});

/**
 * Process one verified Stream event.
 *
 * Called from the route's `after()` once the delivery has been acknowledged, and
 * again from sweep-stuck-webhook-events for anything that failed. It owns its own
 * idempotency (`logWebhookEvent`) and completion bookkeeping
 * (`markWebhookEventProcessed`), so both callers can invoke it blindly.
 *
 * It never throws. The response is already sent by the time it runs, so there is
 * nobody to signal — a handler failure is stamped on the WebhookEvent row and
 * the sweeper re-drives it.
 */
/**
 * Is this event for a call type this app actually uses?
 *
 * Every handler resolves its row with `call_cid.split(":")[1]`, discarding the
 * type half. The app only ever uses `default`, but the Stream app also carries
 * the built-in `livestream`, `audio_room` and `development` types, and on all
 * three the plain `user` role holds `create-call` — `development` grants it
 * `start-recording`, `start-transcription` and `start-broadcasting` outright.
 * Tokens here are app-wide (`generateUserToken`, no `call_cids`), so any
 * signed-in user holds one that works on them.
 *
 * That let a user who knew one of their own anchor slot ids call `getOrCreate`
 * on `development:slot-<id>`, record whatever they liked, and have Stream
 * deliver a genuine, correctly-signed `call.recording_ready` whose id half
 * collided with a real MeetingSession — binding their recording to someone
 * else's appointment. Signature checking is no defence: the event is authentic.
 * The same collision reached the session handlers, where injected participant
 * events feed attendance, which feeds no-show detection, which issues refunds.
 *
 * Checked once, at the boundary, so a type added later cannot reintroduce it by
 * forgetting one of the eight call sites.
 */
function isOwnCallType(callCid: string | undefined): boolean {
  return !callCid || callTypeFromCid(callCid) === STREAM_CALL_TYPE;
}

/**
 * Write the delivery down, and nothing else.
 *
 * Split out of `processStreamEvent` so the route can call it BEFORE it
 * acknowledges. Everything the sweeper needs to re-drive an event later is this
 * row; the handler work is what does not fit in Stream's six-second budget, not
 * the insert. Deliberately does no DB-health probe and no handler dispatch —
 * this is the part that must be cheap enough to run on the request path.
 *
 * Throws on failure. The caller turns that into a non-2xx so Stream redelivers,
 * which is correct precisely because nothing was recorded.
 */
export async function recordStreamEventReceipt(
  eventId: string,
  eventType: string,
  event: unknown,
  signature: string | undefined,
): Promise<void> {
  await logWebhookEvent("stream", eventId, eventType, event, signature);
}

/**
 * One entry per handled event type: the schema that validates the payload, and
 * the handler that consumes it.
 *
 * `entry()` exists so the pairing is type-checked at the definition site — the
 * handler's parameter has to be assignable from `z.infer<typeof schema>`, or
 * this does not compile. Where a handler's declared type is narrower than what
 * the schema infers, the cast is written here and only here, which is where the
 * eight `case` blocks were each doing it before.
 *
 * `satisfies Record<HandledEventType, …>` is the exhaustiveness proof: adding a
 * type to HANDLED_EVENT_TYPES without adding a row here fails `tsc`, exactly as
 * the `never` in the old default branch did.
 */
function entry<S extends z.ZodTypeAny>(
  schema: S,
  handle: (event: z.infer<S>) => Promise<void>,
): { schema: z.ZodTypeAny; handle: (event: unknown) => Promise<void> } {
  return { schema, handle: (event) => handle(event as z.infer<S>) };
}

const EVENT_HANDLERS = {
  "call.recording_started": entry(
    streamRecordingStartedSchema,
    handleRecordingStarted,
  ),
  "call.recording_stopped": entry(
    streamRecordingStoppedSchema,
    handleRecordingStopped,
  ),
  "call.recording_ready": entry(streamRecordingReadySchema, (e) =>
    handleRecordingReady(e as StreamRecordingReadyEvent),
  ),
  "call.recording_failed": entry(streamRecordingFailedSchema, (e) =>
    handleRecordingFailed(e as StreamRecordingFailedEvent),
  ),
  "call.session_ended": entry(streamSessionEndedSchema, (e) =>
    handleSessionEnded(e as StreamSessionEndedEvent),
  ),
  "call.ended": entry(streamCallEndedSchema, (e) =>
    handleCallEnded(e as StreamCallEndedEvent),
  ),
  "call.session_participant_joined": entry(
    streamSessionParticipantJoinedSchema,
    (e) =>
      handleSessionParticipantJoined(e as StreamSessionParticipantJoinedEvent),
  ),
  "call.session_participant_left": entry(
    streamSessionParticipantLeftSchema,
    (e) => handleSessionParticipantLeft(e as StreamSessionParticipantLeftEvent),
  ),
} satisfies Record<
  HandledEventType,
  { schema: z.ZodTypeAny; handle: (event: unknown) => Promise<void> }
>;

export async function processStreamEvent(
  event: unknown,
  eventType: string,
  eventId: string,
  signature: string | undefined,
  baseEvent: { call_cid?: string },
  opts: {
    /**
     * The caller already wrote the receipt and therefore owns the claim.
     *
     * The route does: it persists before acknowledging, then dispatches in
     * `after()`. Without this, that second call re-enters `logWebhookEvent` for
     * an id whose row it just created — a row in the IN-PROGRESS state, aged
     * milliseconds — and the staleness escape correctly refuses it as another
     * worker's in-flight work. `isNew` comes back false and dispatch returns
     * having done nothing. The sweeper still rescues it, so nothing is lost, but
     * every event waits a full sweep cycle instead of running inline.
     *
     * The sweeper passes nothing and claims normally, which is what makes the
     * concurrency guard meaningful for the caller that actually competes.
     */
    claimAlreadyHeld?: boolean;
  } = {},
): Promise<void> {
  try {
    // The health probe moved here from the request path: it is a real signal
    // worth acting on, but not worth spending the acknowledgement budget on.
    //
    // Returning here is now safe ONLY because the route persists the receipt
    // before acknowledging. It was not before: this branch returned without
    // writing anything, so a DB blip on a first delivery left no row, and
    // "deferring to the sweeper" deferred to a sweeper that had nothing to find.
    // The sweeper genuinely owns it now.
    if (!(await isDbHealthy())) {
      streamLogger.warn(
        `DB unhealthy — deferring Stream event ${eventId} to the sweeper`,
      );
      return;
    }

    if (!opts.claimAlreadyHeld) {
      const { isNew } = await logWebhookEvent(
        "stream",
        eventId,
        eventType,
        event,
        signature,
      );

      if (!isNew) {
        streamLogger.debug(`Duplicate Stream webhook event: ${eventId}`);
        return;
      }
    }

    streamLogger.info(`Processing Stream webhook: ${eventType}`, {
      call_cid: baseEvent.call_cid || "chat",
    });

    let processingError: string | undefined;

    // Narrow here so the `never` in the default branch is a real exhaustiveness
    // proof rather than a cast. Both callers hand us a string off the wire, and
    // asserting `as never` in the default would have compiled unconditionally —
    // a check that reads as protection and verifies nothing.
    if (!isHandledEventType(eventType)) {
      streamLogger.debug(`Unhandled Stream event type: ${eventType}`);
      await markWebhookEventProcessed(eventId, undefined);
      return;
    }

    if (!isOwnCallType(baseEvent.call_cid)) {
      streamLogger.warn("Refused Stream webhook for a foreign call type", {
        eventId,
        eventType,
        call_cid: baseEvent.call_cid,
        expected: STREAM_CALL_TYPE,
      });
      await markWebhookEventProcessed(eventId);
      return;
    }

    // #1280 — one `safeParse` at a choke point, not eight `.parse()` calls.
    //
    // Each case used to `.parse()` its own payload. A ZodError landed in the
    // handler catch below, was stamped on the row as an ordinary failure, and
    // the sweeper then re-drove it every ten minutes for its 168-hour give-up
    // window — roughly a thousand attempts at a payload that cannot become
    // valid. Schema mismatch is not a transient failure; treating it as one
    // burns the sweeper's budget on a row no retry can help while hiding a real
    // contract break behind noise that ages out on its own.
    //
    // Parsing in one place also means adding an event type cannot reintroduce a
    // bare `.parse()`: the schema comes from the table below, which the
    // exhaustiveness proof in `dispatch` keeps honest.
    const { schema, handle } = EVENT_HANDLERS[eventType];
    const parsed = schema.safeParse(event);

    if (!parsed.success) {
      // Terminal. `markWebhookEventProcessed` in the `finally` stamps this, and
      // the prefix keeps the sweeper away from it for good.
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      processingError = permanentFailure(
        `${eventType} payload does not match its schema — ${detail}`,
      );
      streamLogger.error(
        `Stream webhook ${eventId} is permanently unprocessable`,
        { eventType, detail },
      );
      // Paged, because a schema that stops matching means Stream changed a
      // contract we depend on. That is the opposite of the churn this replaces:
      // one alert with the field names in it, rather than a thousand silent
      // retries.
      Sentry.captureException(
        new Error(`Stream ${eventType} payload failed schema validation`),
        {
          tags: { subsystem: "stream", reason: "stream.schema_mismatch" },
          extra: { eventId, detail },
          level: "error",
        },
      );
      await markWebhookEventProcessed(eventId, processingError);
      return;
    }

    try {
      await handle(parsed.data);
    } catch (handlerError) {
      processingError =
        handlerError instanceof Error
          ? handlerError.message
          : String(handlerError);
      streamLogger.error(`Error processing ${eventType}`, handlerError);
      Sentry.captureException(
        handlerError instanceof Error
          ? handlerError
          : new Error(String(handlerError)),
        { tags: { subsystem: "stream" } },
      );
      // Deliberately NOT rethrown. The response has already been sent, so there
      // is nothing to signal to Stream; the error is stamped on the row below
      // and the sweeper owns the retry.
    } finally {
      await markWebhookEventProcessed(eventId, processingError);
    }
  } catch (error) {
    // Reaching here means the bookkeeping itself failed. That used to be the one
    // shape that could still lose an event, because the row was written on this
    // side of the acknowledgement — if this threw, nothing existed for the
    // sweeper to find. The route now writes the receipt BEFORE acknowledging, so
    // the row is already there and the sweeper will re-drive it. Still paged on:
    // it means the completion bookkeeping is broken, which is worth knowing even
    // though the event itself is no longer at risk.
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" }, level: "error" },
    );
    streamLogger.error(
      `Stream webhook bookkeeping failed for ${eventId} — event may be lost`,
      error,
    );
  }
}
