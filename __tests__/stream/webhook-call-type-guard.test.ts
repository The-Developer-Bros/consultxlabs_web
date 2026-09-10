/**
 * @jest-environment node
 */

/**
 * #1280 — the webhook boundary must refuse call types this app does not use.
 *
 * Every handler resolves its row with `call_cid.split(":")[1]`, discarding the
 * type half. The app only ever uses `default`, but the Stream app also carries
 * the built-in `livestream`, `audio_room` and `development` types, and the plain
 * `user` role holds `create-call` on all three — on `development` it also holds
 * `start-recording`, `start-transcription` and `start-broadcasting` outright.
 * Video tokens here are app-wide (`generateUserToken`, no `call_cids` claim), so
 * every signed-in user already holds one that works on all of them.
 *
 * So a user who knew one of their own anchor slot ids could `getOrCreate`
 * `development:slot-<id>`, record anything, and have Stream deliver a genuine,
 * correctly-signed `call.recording_ready` whose id half collided with a real
 * MeetingSession — binding their recording to someone else's appointment.
 * Signature verification cannot help: the event really is from Stream.
 *
 * These tests fail without the guard.
 */

const mockLogWebhookEvent = jest.fn();
const mockMarkProcessed = jest.fn();
const mockHandleRecordingReady = jest.fn();
const mockHandleSessionParticipantJoined = jest.fn();

jest.mock("../../lib/webhooks/event-log", () => ({
  logWebhookEvent: (...a: unknown[]) => mockLogWebhookEvent(...a),
  markWebhookEventProcessed: (...a: unknown[]) => mockMarkProcessed(...a),
  isDbHealthy: () => true,
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/stream/recording-handlers", () => ({
  handleRecordingStarted: jest.fn(),
  handleRecordingStopped: jest.fn(),
  handleRecordingReady: (...a: unknown[]) => mockHandleRecordingReady(...a),
  handleRecordingFailed: jest.fn(),
}));

jest.mock("../../lib/stream/session-handlers", () => ({
  handleSessionEnded: jest.fn(),
  handleCallEnded: jest.fn(),
  handleSessionParticipantJoined: (...a: unknown[]) =>
    mockHandleSessionParticipantJoined(...a),
  handleSessionParticipantLeft: jest.fn(),
}));

import { processStreamEvent } from "../../lib/stream/webhook-dispatch";

/**
 * The real signature is (event, eventType, eventId, signature, baseEvent, opts).
 * `baseEvent.call_cid` is passed SEPARATELY from the event body, and it is what
 * the guard reads — so a test that omits it proves nothing. An earlier draft of
 * this file called the function with three arguments; the refusal assertions
 * still went green, because dispatch bailed long before the guard ran.
 */
function dispatch(event: { type: string; call_cid: string }, eventId: string) {
  return processStreamEvent(event, event.type, eventId, "sig", {
    call_cid: event.call_cid,
  });
}

const RECORDING_READY = (callCid: string) => ({
  type: "call.recording_ready",
  call_cid: callCid,
  created_at: "2026-08-30T12:00:00.000Z",
  call_recording: {
    filename: "rec.mp4",
    url: "https://attacker.example/rec.mp4",
    start_time: "2026-08-30T11:00:00.000Z",
    end_time: "2026-08-30T11:30:00.000Z",
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLogWebhookEvent.mockResolvedValue({ isNew: true });
  mockMarkProcessed.mockResolvedValue(undefined);
});

describe("webhook call-type guard", () => {
  it("processes a recording_ready on the app's own call type", async () => {
    await dispatch(RECORDING_READY("default:slot-abc"), "evt-default");
    expect(mockHandleRecordingReady).toHaveBeenCalledTimes(1);
  });

  it.each(["development", "livestream", "audio_room"])(
    "refuses a recording_ready minted on the %s call type",
    async (foreignType) => {
      await dispatch(
        RECORDING_READY(`${foreignType}:slot-abc`),
        `evt-${foreignType}`,
      );
      // The id half collides with a real MeetingSession; the type half is the
      // only thing that distinguishes this from a genuine event.
      expect(mockHandleRecordingReady).not.toHaveBeenCalled();
    },
  );

  it("refuses foreign-type session events, which feed attendance and refunds", async () => {
    await dispatch(
      {
        type: "call.session_participant_joined",
        call_cid: "development:slot-abc",
        created_at: "2026-08-30T12:00:00.000Z",
        session_id: "s1",
        participant: { user: { id: "u1" }, user_session_id: "us1" },
      } as never,
      "evt-joined-foreign",
    );
    expect(mockHandleSessionParticipantJoined).not.toHaveBeenCalled();
  });

  it("still marks a refused event processed, so the sweeper does not re-drive it forever", async () => {
    await dispatch(RECORDING_READY("development:slot-abc"), "evt-marked");
    expect(mockMarkProcessed).toHaveBeenCalledWith("evt-marked");
  });

  it("treats a bare id with no type prefix as the app's own type", async () => {
    await dispatch(RECORDING_READY("slot-abc"), "evt-bare");
    expect(mockHandleRecordingReady).toHaveBeenCalledTimes(1);
  });
});
