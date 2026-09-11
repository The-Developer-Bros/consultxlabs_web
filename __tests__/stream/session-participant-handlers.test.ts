/**
 * @jest-environment node
 */

/**
 * STR-4 — per-attendee presence handlers. Verifies the join/leave webhook
 * handlers resolve the MeetingSession by streamCallId and upsert a
 * MeetingAttendance row keyed on [meetingSessionId, userId]:
 *  - first join stamps firstJoinedAt (create branch)
 *  - rejoin only increments joinCount (update branch, firstJoinedAt untouched)
 *  - leave stamps lastLeftAt
 *  - missing session / missing user id are skipped, not thrown
 */
jest.mock("../../lib/prisma", () => {
  const client = {
    meetingSession: { findUnique: jest.fn() },
    meetingAttendance: { upsert: jest.fn().mockResolvedValue({}) },
  };
  return { __esModule: true, default: client };
});
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import {
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
} from "../../lib/stream/session-handlers";

const mockFindUnique = (
  prisma as unknown as { meetingSession: { findUnique: jest.Mock } }
).meetingSession.findUnique;
const mockUpsert = (
  prisma as unknown as { meetingAttendance: { upsert: jest.Mock } }
).meetingAttendance.upsert;

beforeEach(() => jest.clearAllMocks());

describe("handleSessionParticipantJoined (STR-4)", () => {
  it("creates attendance with firstJoinedAt on first join (create branch)", async () => {
    mockFindUnique.mockResolvedValue({ id: "ms_1" });

    await handleSessionParticipantJoined({
      call_cid: "default:call_abc",
      type: "call.session_participant_joined",
      created_at: "2026-06-16T10:00:00.000Z",
      session_id: "sess_1",
      participant: { user: { id: "user_1" }, user_session_id: "dev_1" },
    });

    // Resolved by the call id stripped from call_cid ("default:call_abc")
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { streamCallId: "call_abc" },
      select: { id: true },
    });

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      meetingSessionId_userId: { meetingSessionId: "ms_1", userId: "user_1" },
    });
    expect(arg.create).toMatchObject({
      meetingSessionId: "ms_1",
      userId: "user_1",
      firstJoinedAt: new Date("2026-06-16T10:00:00.000Z"),
    });
    // Rejoin path must only bump the counter, never reset firstJoinedAt.
    expect(arg.update).toEqual({ joinCount: { increment: 1 } });
  });

  it("skips when meeting session does not exist (no throw)", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      handleSessionParticipantJoined({
        call_cid: "default:missing",
        type: "call.session_participant_joined",
        created_at: "2026-06-16T10:00:00.000Z",
        session_id: "sess_1",
        participant: { user: { id: "user_1" } },
      }),
    ).resolves.toBeUndefined();

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("skips when participant user id is missing", async () => {
    await handleSessionParticipantJoined({
      call_cid: "default:call_abc",
      type: "call.session_participant_joined",
      created_at: "2026-06-16T10:00:00.000Z",
      session_id: "sess_1",
      // @ts-expect-error — exercising the defensive guard for a malformed payload
      participant: { user: {} },
    });

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("handleSessionParticipantLeft (STR-4)", () => {
  it("stamps lastLeftAt on leave (update branch)", async () => {
    mockFindUnique.mockResolvedValue({ id: "ms_1" });

    await handleSessionParticipantLeft({
      call_cid: "default:call_abc",
      type: "call.session_participant_left",
      created_at: "2026-06-16T10:30:00.000Z",
      session_id: "sess_1",
      duration_seconds: 1800,
      participant: { user: { id: "user_1" } },
    });

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      meetingSessionId_userId: { meetingSessionId: "ms_1", userId: "user_1" },
    });
    expect(arg.update).toEqual({
      lastLeftAt: new Date("2026-06-16T10:30:00.000Z"),
    });
    // A leave without a recorded join still creates the row defensively.
    expect(arg.create).toMatchObject({
      meetingSessionId: "ms_1",
      userId: "user_1",
      firstJoinedAt: new Date("2026-06-16T10:30:00.000Z"),
      lastLeftAt: new Date("2026-06-16T10:30:00.000Z"),
    });
  });

  it("skips when meeting session does not exist (no throw)", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      handleSessionParticipantLeft({
        call_cid: "default:missing",
        type: "call.session_participant_left",
        created_at: "2026-06-16T10:30:00.000Z",
        session_id: "sess_1",
        participant: { user: { id: "user_1" } },
      }),
    ).resolves.toBeUndefined();

    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
