/**
 * @jest-environment node
 */

/**
 * #1270 — POST /api/meetings/[meetingId]/end.
 *
 * `end-call` is granted to `call_member` on the live `default` call type, and
 * the join route hands `call_member` to every participant. So `call.endCall()`
 * from a consultee's devtools ended the consultation for everyone; the only
 * barrier was `EndCallButton` not rendering for them, which is a React
 * conditional over call data.
 *
 * What matters here is the negative case. A route that ends the call for a
 * participant is the bug with extra steps, so the assertion is that Stream is
 * not touched at all unless the caller resolves as the hosting side.
 */

const mockGetSession = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockEnd = jest.fn();
const mockVideoCall = jest.fn();

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...a: unknown[]) => mockResolveMeetingAccess(...a),
}));

// Same shape as the join gate's: the error class has to be built inside the
// factory (jest.mock is hoisted above every const) and read back below, or the
// route's `instanceof` will not match what the test throws.
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  StreamUnavailableError: class StreamUnavailableError extends Error {
    constructor() {
      super("Stream is unavailable");
      this.name = "StreamUnavailableError";
    }
  },
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      // #1270 review — the arguments are the assertion. This used to discard
      // them, so the route could have ended `slot-abc` instead of the id the
      // MeetingSession actually points at and every test still passed.
      call: (...a: unknown[]) => {
        mockVideoCall(...a);
        return { end: (...b: unknown[]) => mockEnd(...b) };
      },
    },
  })),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { POST } from "../../app/api/meetings/[meetingId]/end/route";
import { StreamUnavailableError } from "../../lib/stream-client";

const params = Promise.resolve({ meetingId: "slot-abc" });
const req = {} as never;

/** What resolveMeetingAccess hands back for a caller who may be in the room. */
const granted = (role: "host" | "participant") => ({
  hasAccess: true,
  role,
  message: `Access granted as ${role}`,
  reason: "granted",
  streamCallId: "slot-abc",
  meetingSessionId: "ms-1",
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: false } });
  mockResolveMeetingAccess.mockResolvedValue(granted("host"));
  mockEnd.mockResolvedValue({});
});

describe("POST /api/meetings/[meetingId]/end", () => {
  it("ends the call for a host", async () => {
    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  it("refuses a participant, and ends nothing", async () => {
    // The whole point of the route. Being allowed IN is not being allowed to
    // close the room on everyone else.
    mockResolveMeetingAccess.mockResolvedValue(granted("participant"));

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_host" });
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("refuses someone who is not on the appointment at all", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("404s a meeting that does not exist", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(404);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("refuses a suspended host before resolving anything", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: true } });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(mockResolveMeetingAccess).not.toHaveBeenCalled();
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(mockEnd).not.toHaveBeenCalled();
  });

  it("ends the call Stream knows about, not the id in the URL", async () => {
    // The route param is the id the browser had; `streamCallId` is what the
    // MeetingSession row actually points at, and legacy rows carry opaque ids
    // that are not `slot-<anchorSlotId>` at all.
    mockResolveMeetingAccess.mockResolvedValue({
      ...granted("host"),
      streamCallId: "legacy-uuid",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    // The whole point of the test: the id came from the session row, not the
    // route param. `params` resolves to `slot-abc`.
    expect(mockVideoCall).toHaveBeenCalledWith("default", "legacy-uuid");
  });

  it("reports a Stream outage as 503, not 500", async () => {
    mockEnd.mockRejectedValue(new StreamUnavailableError());

    const res = await POST(req, { params });

    expect(res.status).toBe(503);
  });

  it("still reports a genuine fault as 500", async () => {
    mockEnd.mockRejectedValue(new Error("boom"));

    const res = await POST(req, { params });

    expect(res.status).toBe(500);
  });
});
