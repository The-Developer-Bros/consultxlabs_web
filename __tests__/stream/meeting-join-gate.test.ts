/**
 * @jest-environment node
 */

/**
 * #1134 P0-1/P0-2 — the join gate, and the regression that closing P0-2 opened.
 *
 * P0-2 removed the client-side `getOrCreate()` that used to run on a cache miss,
 * because it raced the access check: any signed-in visitor to `/meetings/<x>`
 * minted a billable Stream call and became its `created_by` before being shown
 * "Access Denied". Removing it was right. What it also removed was the only
 * thing repairing a `MeetingSession` row whose Stream call does not exist — and
 * rows like that are not hypothetical:
 *
 *   - the seeds write them with `faker.string.uuid()` ids and no Stream object
 *     at all (75–800 rows depending on size, no production guard)
 *   - `createDbMeetingSession` is a `"use server"` action whose id validator is
 *     `z.string().min(1)`, so any entitled caller can persist any string
 *   - maintenance drain ends the Stream call and keeps the row
 *
 * `lib/meeting.ts` skips its own `getOrCreate` whenever a row already exists, so
 * nothing else heals them. `resolveMeetingAccess` reads the row and says yes,
 * `updateCallMembers` throws on the missing call, and the user is told they have
 * access and then handed a 500.
 *
 * The fix is to create AFTER authorization instead of before it, which is the
 * ordering P0-2 was ever about. These tests pin that ordering, because a future
 * "tidy-up" that drops the `getOrCreate` reintroduces a silent 500 and a
 * "tidy-up" that moves it above `resolveMeetingAccess` reintroduces P0-2.
 */

const mockGetSession = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockGetOrCreate = jest.fn();
const mockUpdateCallMembers = jest.fn();
const mockUpsertUsersToStream = jest.fn();

/** Ordered log of what the route did, so we can assert sequence, not just calls. */
let sequence: string[] = [];

jest.mock("../../lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => mockGetSession(...a) } },
}));

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: (...a: unknown[]) => mockUpsertUsersToStream(...a),
}));

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...a: unknown[]) => {
    sequence.push("resolveMeetingAccess");
    return mockResolveMeetingAccess(...a);
  },
}));

// jest.mock is hoisted above every const in this file, so the class has to be
// built INSIDE the factory and read back off the mocked module below.
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
      call: () => ({
        getOrCreate: (...a: unknown[]) => {
          sequence.push("getOrCreate");
          return mockGetOrCreate(...a);
        },
        updateCallMembers: (...a: unknown[]) => {
          sequence.push("updateCallMembers");
          return mockUpdateCallMembers(...a);
        },
      }),
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

// Only the second half of this file uses it: the route never touches prisma,
// but the REAL resolveMeetingAccess — exercised below through requireActual —
// is nothing but database reads.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meetingSession: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    slotOfAppointment: { findMany: jest.fn(), findFirst: jest.fn() },
    collaborator: { findFirst: jest.fn() },
  },
}));

import { POST } from "../../app/api/meetings/[meetingId]/join/route";
// The mocked class — `instanceof` in the route must match what we throw here.
import { StreamUnavailableError } from "../../lib/stream-client";

const params = Promise.resolve({ meetingId: "slot-abc" });
const req = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
  sequence = [];
  mockGetSession.mockResolvedValue({
    user: { id: "user_1", banned: false },
  });
  mockResolveMeetingAccess.mockResolvedValue({
    hasAccess: true,
    role: "participant",
    message: "Access granted as participant",
    reason: "granted",
    streamCallId: "slot-abc",
  });
  mockGetOrCreate.mockResolvedValue({});
  mockUpdateCallMembers.mockResolvedValue({});
  mockUpsertUsersToStream.mockResolvedValue({ users: {} });
});

describe("POST /api/meetings/[meetingId]/join", () => {
  it("authorizes BEFORE it creates anything on Stream", async () => {
    await POST(req, { params });

    // This ordering is the whole of P0-2. Creation must never precede the check.
    expect(sequence).toEqual([
      "resolveMeetingAccess",
      "getOrCreate",
      "updateCallMembers",
    ]);
  });

  // #1270 — the regression this suite missed for 17 days. It asserted the
  // ORDER of the Stream calls but never their arguments, so a bare
  // `getOrCreate()` looked identical to a correct one. Server-side auth carries
  // no user context, so Stream rejects an authorless create on every request —
  // a total video outage that every existing assertion here still passed.
  it("names an author on getOrCreate, which server-side auth requires", async () => {
    await POST(req, { params });

    expect(mockGetOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ created_by_id: expect.any(String) }),
      }),
    );
  });

  it("syncs the caller to Stream before naming them as a member", async () => {
    await POST(req, { params });

    // Stream refuses an operation naming a user it does not hold, and a token
    // alone never creates one.
    expect(mockUpsertUsersToStream).toHaveBeenCalled();
    expect(mockUpsertUsersToStream.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateCallMembers.mock.invocationCallOrder[0],
    );
  });

  it("creates the call before granting membership on it", async () => {
    await POST(req, { params });

    expect(sequence.indexOf("getOrCreate")).toBeLessThan(
      sequence.indexOf("updateCallMembers"),
    );
  });

  it("creates nothing at all when access is refused", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "You are not authorized to join this meeting",
      reason: "unauthorized",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
    expect(mockUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("404s a meeting that does not exist, without creating it", async () => {
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "Meeting not found",
      reason: "not_found",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(404);
    expect(mockGetOrCreate).not.toHaveBeenCalled();
  });

  it("picks the status from `reason`, not from the message text", async () => {
    // Both routes used to compare `message` to the literal "Meeting not found",
    // so rewording a user-facing string silently turned a 404 into a 403 in two
    // places at once. A reworded message with the same reason must still 404.
    mockResolveMeetingAccess.mockResolvedValue({
      hasAccess: false,
      role: null,
      message: "We couldn't find that meeting.",
      reason: "not_found",
    });

    const res = await POST(req, { params });

    expect(res.status).toBe(404);
  });

  it("grants call_member — never `host`, which is not a role on this app", async () => {
    await POST(req, { params });

    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      update_members: [{ user_id: "user_1", role: "call_member" }],
    });
  });

  it("refuses a suspended account before touching Stream", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "user_1", banned: true } });

    const res = await POST(req, { params });

    expect(res.status).toBe(403);
    expect(sequence).toEqual([]);
  });

  it("reports a Stream outage as 503, not 500", async () => {
    // A provider outage is not our fault and not the caller's. 500 puts it in
    // the "we broke something" bucket and, worse, the client used to render any
    // non-ok response as "You are not authorized to join this meeting" — telling
    // a legitimate participant they had been refused when Stream was simply down.
    mockGetOrCreate.mockRejectedValue(new StreamUnavailableError());

    const res = await POST(req, { params });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
    // No `reason` — that field marks an authorization verdict, and this is not one.
    expect(body.reason).toBeUndefined();
  });

  it("still reports a genuine fault as 500", async () => {
    mockGetOrCreate.mockRejectedValue(new Error("boom"));

    const res = await POST(req, { params });

    expect(res.status).toBe(500);
  });

  it("refuses an unauthenticated caller", async () => {
    mockGetSession.mockResolvedValue(null);

    const res = await POST(req, { params });

    expect(res.status).toBe(401);
    expect(sequence).toEqual([]);
  });
});

/**
 * #1270 — the SERVER-side status gate, exercised for real.
 *
 * `resolveMeetingAccess` refused three booking states — CANCELLED, REJECTED,
 * EXPIRED — while every dashboard's Join affordance is an allowlist of
 * {APPROVED, SCHEDULED, IN_PROGRESS}. Everything in neither set was hidden by
 * the UI and admitted by the server: PENDING, a DRAFT webinar, and above all
 * `APPROVED_PENDING_PAYMENT` and its trial twin `AWAITING_PAYMENT`. Typing
 * /meetings/<id> walked into a booking nobody had paid for. #1272 closed that in
 * the UI only.
 *
 * The route above mocks this module, so the real one is required directly here.
 */
const { resolveMeetingAccess } = jest.requireActual<
  typeof import("../../lib/meetings/access")
>("../../lib/meetings/access");

import prismaClient from "../../lib/prisma";

const db = prismaClient as unknown as {
  meetingSession: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  slotOfAppointment: { findMany: jest.Mock; findFirst: jest.Mock };
  collaborator: { findFirst: jest.Mock };
};

const MINUTE = 60 * 1000;

/** A booking whose session is running right now, so only status can refuse it. */
function seedAccess(
  appointment: Record<string, unknown>,
  opts: { slotEndsInMs?: number; joinerIsParticipant?: boolean } = {},
) {
  const startsAt = new Date(Date.now() - 5 * MINUTE);
  const endsAt = new Date(Date.now() + (opts.slotEndsInMs ?? 25 * MINUTE));

  db.meetingSession.findUnique.mockResolvedValue({
    id: "ms-1",
    streamCallId: "slot-abc",
    slotOfAppointment: {
      user: opts.joinerIsParticipant === false ? [] : [{ id: "user_1" }],
      appointment: { id: "appt-1", deletedAt: null, ...appointment },
    },
  });
  db.slotOfAppointment.findMany.mockResolvedValue([
    {
      id: "slot-1",
      startsAt,
      endsAt,
      isTentative: false,
      completionStatus: "SCHEDULED",
      appointmentId: "appt-1",
      meetingSession: { id: "ms-1", endedAt: null },
    },
  ]);
  db.slotOfAppointment.findFirst.mockResolvedValue(null);
  db.collaborator.findFirst.mockResolvedValue(null);
  db.user.findUnique.mockResolvedValue({ consultantProfileId: null });
}

const consultation = (status: string) => ({
  consultation: {
    status,
    consultationPlan: { consultantProfileId: "cp-1", recordingEnabled: false },
  },
  subscription: null,
  webinar: null,
  class: null,
  trialSession: null,
});

const trial = (status: string) => ({
  consultation: null,
  subscription: null,
  webinar: null,
  class: null,
  trialSession: { consultantProfileId: "cp-1", status },
});

const webinar = (status: string) => ({
  consultation: null,
  subscription: null,
  webinar: {
    status,
    webinarPlan: {
      id: "wp-1",
      consultantProfileId: "cp-1",
      recordingEnabled: false,
    },
  },
  class: null,
  trialSession: null,
});

describe("resolveMeetingAccess refuses a booking that is not joinable", () => {
  it("refuses a consultation whose payment has not landed", async () => {
    seedAccess(consultation("APPROVED_PENDING_PAYMENT"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This session is not confirmed yet.");
  });

  it("refuses a trial awaiting payment — the same hole, other enum", async () => {
    // AWAITING_PAYMENT used to collapse to null on the way into the check,
    // because only CANCELLED and REJECTED were mapped at all.
    seedAccess(trial("AWAITING_PAYMENT"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
  });

  it("refuses a request the consultant has not accepted yet", async () => {
    seedAccess(consultation("PENDING"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      false,
    );
  });

  it("refuses an unpublished webinar", async () => {
    seedAccess(webinar("DRAFT"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      false,
    );
  });

  it("still says a cancelled booking is over rather than unconfirmed", async () => {
    seedAccess(consultation("CANCELLED"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This booking is no longer active.");
  });
});

describe("resolveMeetingAccess still admits a live session", () => {
  it("admits a paid consultation that is under way", async () => {
    seedAccess(consultation("APPROVED"));

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("participant");
  });

  it("admits a scheduled trial", async () => {
    seedAccess(trial("SCHEDULED"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("admits a webinar that is in progress", async () => {
    seedAccess(webinar("IN_PROGRESS"));

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("admits an attendee joined to a different slot of the same webinar", async () => {
    // Group events hang the meeting off the consultant's allocation row while
    // the attendee sits on their own enrollment row, so the direct membership
    // check misses them and the enrollment probe has to answer.
    seedAccess(webinar("SCHEDULED"), { joinerIsParticipant: false });
    db.slotOfAppointment.findFirst.mockResolvedValue({ id: "enrolment-1" });

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("admits an accepted collaborator as a host", async () => {
    seedAccess(webinar("SCHEDULED"), { joinerIsParticipant: false });
    db.user.findUnique.mockResolvedValue({ consultantProfileId: "cp-collab" });
    db.collaborator.findFirst.mockResolvedValue({ id: "collab-1" });

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(true);
    expect(access.role).toBe("host");
  });

  it("lets a disconnected participant back into a session that just completed", async () => {
    // The completion sweeps run on a timer, and the trial one has no buffer at
    // all — so a booking can read COMPLETED while its room is still occupied.
    // That is why completed-like statuses are handed to the time gate (which
    // allows a 30-minute reconnect grace) instead of being refused outright.
    seedAccess(consultation("COMPLETED"), { slotEndsInMs: -2 * MINUTE });

    expect((await resolveMeetingAccess("slot-abc", "user_1")).hasAccess).toBe(
      true,
    );
  });

  it("closes the room once the grace after a completed session is spent", async () => {
    seedAccess(consultation("COMPLETED"), { slotEndsInMs: -45 * MINUTE });

    const access = await resolveMeetingAccess("slot-abc", "user_1");

    expect(access.hasAccess).toBe(false);
    expect(access.message).toBe("This session has ended.");
  });
});
