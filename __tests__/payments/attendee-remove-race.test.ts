/**
 * @jest-environment node
 */

/**
 * Defect 8 — two concurrent removals must refund one seat, not two.
 *
 * The participant DELETE endpoints read the attendee's slot links, checked
 * "did I find any", and only then disconnected them. Between the read and the
 * write anything could happen, and under a double click, a stale tab, or an
 * organiser removing someone who is leaving at the same moment, both requests
 * read a non-empty roster and both went on to call
 * `refundRemovedAttendeeSeat` — which resolves the payment by user + event and
 * so happily refunds the same seat twice.
 *
 * The read now lives inside a Serializable transaction with the write, so the
 * loser either finds the roster already empty or is aborted on the slot row it
 * also tried to touch and finds it empty on retry. Pinned here for both
 * webinars and classes: the empty-inside-the-transaction path returns
 * `{ removed: false }` and never reaches the refund.
 */

const mockRefundRemovedAttendeeSeat = jest.fn();
const mockRemoveUserFromEventChannel = jest.fn();
const mockFindLiveEventSlot = jest.fn();
const mockRequireApiAuth = jest.fn();

const mockWebinarFindFirst = jest.fn();
const mockClassFindFirst = jest.fn();
const mockSlotFindMany = jest.fn();
const mockSlotUpdate = jest.fn();
const mockParticipantUpdateMany = jest.fn();
const mockTransaction = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinar: { findFirst: (...a: unknown[]) => mockWebinarFindFirst(...a) },
    class: { findFirst: (...a: unknown[]) => mockClassFindFirst(...a) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: (...a: unknown[]) => mockRequireApiAuth(...a),
  isPrivileged: (role: string) => role === "ADMIN" || role === "STAFF",
  forbiddenResponse: (message: string) =>
    new Response(JSON.stringify({ error: message }), { status: 403 }),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  participantReadLimiter: {},
}));

jest.mock("../../lib/payments/operations/event-refunds", () => ({
  __esModule: true,
  refundRemovedAttendeeSeat: (...a: unknown[]) =>
    mockRefundRemovedAttendeeSeat(...a),
}));

jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  removeUserFromEventChannel: (...a: unknown[]) =>
    mockRemoveUserFromEventChannel(...a),
}));

jest.mock("../../lib/appointments/live-event-slot", () => ({
  __esModule: true,
  findLiveEventSlot: (...a: unknown[]) => mockFindLiveEventSlot(...a),
}));

import { Prisma } from "@prisma/client";
import { DELETE as deleteWebinarParticipant } from "../../app/api/participants/webinar/[webinarId]/route";
import { DELETE as deleteClassParticipant } from "../../app/api/participants/class/[classId]/route";

const ORGANISER = {
  id: "user-organiser",
  role: "CONSULTANT",
  consultantProfileId: "consultant-1",
};
const ATTENDEE_ID = "user-attendee";

/** Runs the interactive callback against a tx client backed by the slot mocks. */
function runInteractiveTransaction(fn: unknown) {
  return (fn as (tx: unknown) => Promise<number>)({
    slotOfAppointment: {
      findMany: (...a: unknown[]) => mockSlotFindMany(...a),
      update: (...a: unknown[]) => mockSlotUpdate(...a),
    },
    appointmentParticipant: {
      updateMany: (...a: unknown[]) => mockParticipantUpdateMany(...a),
    },
  });
}

function serializationFailure() {
  return new Prisma.PrismaClientKnownRequestError(
    "could not serialize access due to concurrent update",
    { code: "P2034", clientVersion: "6.0.0" },
  );
}

/**
 * The two handlers differ only in the name of their route param, so the cases
 * are driven through one shape. Widened deliberately: keeping the two literal
 * param types would intersect across the table and satisfy neither.
 */
type ParticipantDelete = (
  request: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const CASES = [
  {
    label: "webinar",
    handler: deleteWebinarParticipant as unknown as ParticipantDelete,
    eventId: "webinar-1",
    participantScope: { webinarId: "webinar-1" },
    params: (): Promise<Record<string, string>> =>
      Promise.resolve({ webinarId: "webinar-1" }),
    findFirst: mockWebinarFindFirst,
  },
  {
    label: "class",
    handler: deleteClassParticipant as unknown as ParticipantDelete,
    eventId: "class-1",
    participantScope: { classId: "class-1" },
    params: (): Promise<Record<string, string>> =>
      Promise.resolve({ classId: "class-1" }),
    findFirst: mockClassFindFirst,
  },
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireApiAuth.mockResolvedValue({ session: { user: ORGANISER } });
  mockWebinarFindFirst.mockResolvedValue({ id: "webinar-1" });
  mockClassFindFirst.mockResolvedValue({ id: "class-1" });
  mockFindLiveEventSlot.mockResolvedValue(null);
  mockSlotUpdate.mockResolvedValue({});
  mockParticipantUpdateMany.mockResolvedValue({ count: 1 });
  // The real contract of refundRemovedAttendeeSeat — the roster client reads
  // all three fields to build the organiser's toast, so a stub of some invented
  // shape would freeze a response body the producer never returns.
  mockRefundRemovedAttendeeSeat.mockResolvedValue({
    amountRefundedPaise: 50_000,
    refundPct: 100,
    rail: "GATEWAY",
  });
  mockRemoveUserFromEventChannel.mockResolvedValue({ success: true });
  mockTransaction.mockImplementation((fn: unknown) =>
    runInteractiveTransaction(fn),
  );
});

describe.each(CASES)(
  "$label participant removal is single-writer (defect 8)",
  ({ handler, eventId, participantScope, params, findFirst }) => {
    function request() {
      return new Request(
        `http://localhost/api/participants?userId=${ATTENDEE_ID}`,
        { method: "DELETE" },
      );
    }

    it("re-reads inside the transaction and refuses to refund when the roster is already empty", async () => {
      // The rival removal committed between this request's auth check and its
      // write. Pre-fix the outer read had already banked a non-empty roster.
      mockSlotFindMany.mockResolvedValue([]);

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: false, refund: null });
      expect(mockSlotUpdate).not.toHaveBeenCalled();
      // #1319 A9 — the participant row is history, not a seat: a request that
      // released nothing must not stamp it CANCELLED either.
      expect(mockParticipantUpdateMany).not.toHaveBeenCalled();
      expect(mockRefundRemovedAttendeeSeat).not.toHaveBeenCalled();
      // Never mind the chat: nothing was released, so nothing is revoked.
      expect(mockRemoveUserFromEventChannel).not.toHaveBeenCalled();
    });

    it("runs the roster write at Serializable isolation", async () => {
      mockSlotFindMany.mockResolvedValue([]);

      await handler(request(), { params: params() });

      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // Budgets, not just the isolation level: the per-seat disconnect loop can
      // outrun Prisma's default 5s, and a P2028 timeout is rethrown rather than
      // retried — 500, seat still held, fee not returned.
      expect(mockTransaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      });
    });

    it("the winner disconnects every slot and refunds exactly once", async () => {
      mockSlotFindMany.mockResolvedValue([{ id: "slot-1" }, { id: "slot-2" }]);

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        removed: true,
        refund: {
          amountRefundedPaise: 50_000,
          refundPct: 100,
          rail: "GATEWAY",
        },
      });
      expect(mockSlotUpdate).toHaveBeenCalledTimes(2);
      // #1319 A9 — same transaction as the disconnects, so the seat and its
      // history commit together or not at all.
      expect(mockParticipantUpdateMany).toHaveBeenCalledTimes(1);
      expect(mockParticipantUpdateMany).toHaveBeenCalledWith({
        where: { appointment: participantScope, userId: ATTENDEE_ID },
        data: { status: "CANCELLED" },
      });
      expect(mockRefundRemovedAttendeeSeat).toHaveBeenCalledTimes(1);
      expect(mockRefundRemovedAttendeeSeat).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId,
          attendeeUserId: ATTENDEE_ID,
          initiatedBy: "organiser",
        }),
      );
    });

    it("a serialization abort retries, and the retry sees the empty roster", async () => {
      // The database, not the application, is what separates the two writers:
      // the loser is aborted on the slot row it also tried to write. Its retry
      // must land on the no-op answer rather than a second refund.
      mockTransaction
        .mockImplementationOnce(() => Promise.reject(serializationFailure()))
        .mockImplementationOnce((fn: unknown) => runInteractiveTransaction(fn));
      mockSlotFindMany.mockResolvedValue([]);

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: false, refund: null });
      expect(mockTransaction).toHaveBeenCalledTimes(2);
      expect(mockRefundRemovedAttendeeSeat).not.toHaveBeenCalled();
    });

    it("still 404s before any of this when the event is not the caller's", async () => {
      findFirst.mockResolvedValue(null);

      const res = await handler(request(), { params: params() });

      expect(res.status).toBe(404);
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  },
);
