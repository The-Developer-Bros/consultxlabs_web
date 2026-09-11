/**
 * @jest-environment node
 */

/**
 * #1146 — the maintenance drain, which had no test coverage at all.
 *
 * That is not incidental. All three findings below were found by reading the
 * file during a review of a DESCENDANT pull request, survived the merge of the
 * PR that owned it, and were only written down because #1146 was filed to catch
 * findings the merges orphaned. A file that ends group chat and marks slots
 * UNVERIFIED had nothing pinning any of it.
 *
 * The stakes are asymmetric in one direction. Stream grants
 * `use-frozen-channel` to NO role by default, so a channel left frozen is
 * unwritable by every user AND every admin, with no error message and no
 * visible cause. Freezing is cheap to get wrong and expensive to notice.
 */

const mockFindMany = jest.fn();
const mockTransaction = jest.fn();
const mockCallEnd = jest.fn();
const mockUpdatePartial = jest.fn();
const mockGetEventChannelIds = jest.fn();
const mockSadd = jest.fn();
const mockSmembers = jest.fn();
const mockSrem = jest.fn();
const mockStopRecording = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

// Relative paths, not the `@/` alias — the alias resolves to a different module
// instance here, so the mock silently does not bind.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meetingSession: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      // The drain builds the transaction array by CALLING these, so they have
      // to exist before `$transaction` is even reached.
      update: jest.fn((args: unknown) => args),
    },
    slotOfAppointment: { update: jest.fn((args: unknown) => args) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    sadd: (...a: unknown[]) => mockSadd(...a),
    smembers: (...a: unknown[]) => mockSmembers(...a),
    srem: (...a: unknown[]) => mockSrem(...a),
    get: (...a: unknown[]) => mockRedisGet(...a),
    set: (...a: unknown[]) => mockRedisSet(...a),
    del: (...a: unknown[]) => mockRedisDel(...a),
  },
  // Pass-through: the drain's own degradation is what is under test, not the
  // breaker's.
  withCircuitBreaker: async (op: () => unknown, fallback?: () => unknown) => {
    try {
      return await op();
    } catch (e) {
      if (fallback) return fallback();
      throw e;
    }
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: () => ({
      updatePartial: (...a: unknown[]) => mockUpdatePartial(...a),
    }),
  }),
  getStreamVideoClient: () => ({
    video: { call: () => ({ end: (...a: unknown[]) => mockCallEnd(...a) }) },
  }),
  withStreamCircuitBreaker: async (op: () => unknown) => op(),
}));

jest.mock("../../lib/stream/appointment-channels", () => ({
  getEventChannelIdsForAppointment: (...a: unknown[]) =>
    mockGetEventChannelIds(...a),
}));

jest.mock("../../lib/stream/recording-service", () => ({
  RecordingService: class {
    stopRecording = (...a: unknown[]) => mockStopRecording(...a);
  },
}));

jest.mock("../../lib/novu/service", () => ({
  notifyMaintenanceStarted: jest.fn(async () => undefined),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { warn: jest.fn(), info: jest.fn(), fmt: (s: unknown) => s },
}));

// No pause between batches — the pacing is real behaviour but 2s per batch
// would make this suite useless.
jest.mock("../../lib/stream/batch", () => ({
  ...jest.requireActual("../../lib/stream/batch"),
  pause: jest.fn(async () => undefined),
}));

import {
  drainActiveSessions,
  unfreezeChannelsAfterMaintenance,
} from "../../actions/maintenance/drain-sessions";
import { REDIS_KEYS } from "../../lib/maintenance-keys";

/** A live session row, trimmed to the fields the drain reads. */
function session(id: string, appointmentId: string) {
  return {
    id,
    streamCallId: `slot-${id}`,
    slotOfAppointmentId: `slot-row-${id}`,
    isRecording: false,
    slotOfAppointment: {
      appointmentId,
      user: [{ id: `u-${id}` }],
      appointment: {},
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallEnd.mockResolvedValue(undefined);
  mockTransaction.mockResolvedValue(undefined);
  mockUpdatePartial.mockResolvedValue(undefined);
  mockSadd.mockResolvedValue(1);
  mockSrem.mockResolvedValue(1);
  mockSmembers.mockResolvedValue([]);
  mockGetEventChannelIds.mockResolvedValue([]);
  mockFindMany.mockResolvedValue([]);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue("OK");
  mockRedisDel.mockResolvedValue(1);
});

describe("drainActiveSessions — one bad row must not take the window with it", () => {
  it("continues the drain, and still freezes chat, after a failed DB write", async () => {
    mockFindMany.mockResolvedValue([
      session("a", "appt-1"),
      session("b", "appt-2"),
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1"]);
    // The first session's transaction rejects; the second must still run.
    mockTransaction
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce(undefined);

    const result = await drainActiveSessions();

    // Both calls were ended on Stream. Before the fix, the rejection propagated
    // straight out of drainActiveSessions, so every LATER session kept running
    // on Stream while the platform went OFFLINE.
    expect(mockCallEnd).toHaveBeenCalledTimes(2);
    expect(result.drained).toBe(1);
    expect(result.errors.some((e) => e.includes("deadlock"))).toBe(true);

    // The sharper half of the same bug: the freeze happens AFTER the loop, so a
    // throw inside it meant NO channel was frozen at all — the maintenance
    // posture was silently skipped for the entire window.
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: true } });
  });

  it("records only CONFIRMED-frozen channels in the ledger", async () => {
    mockFindMany.mockResolvedValue([session("a", "appt-1")]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1", "class-2"]);
    mockUpdatePartial
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stream 500"));

    await drainActiveSessions();

    // A channel Stream refused is not frozen. Listing it would make the
    // unfreeze report work it never did.
    const recorded = mockSadd.mock.calls.flatMap((c) => c.slice(1));
    expect(recorded).toContain("webinar-1");
    expect(recorded).not.toContain("class-2");
  });

  it("does not fail the drain when the ledger write fails", async () => {
    mockFindMany.mockResolvedValue([session("a", "appt-1")]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1"]);
    mockSadd.mockRejectedValue(new Error("redis down"));

    const result = await drainActiveSessions();

    // The freeze happened. Rolling it back because bookkeeping failed would be
    // strictly worse, and the unfreeze still has its derived fallback.
    expect(mockUpdatePartial).toHaveBeenCalled();
    expect(result.errors.some((e) => e.includes("redis down"))).toBe(true);
  });
});

describe("unfreezeChannelsAfterMaintenance — reverse what was frozen, not what we can guess", () => {
  it("prefers the ledger over re-deriving the set", async () => {
    mockSmembers.mockResolvedValue(["webinar-1", "class-2"]);

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.source).toBe("ledger");
    expect(result.unfrozen).toBe(2);
    expect(mockUpdatePartial).toHaveBeenCalledWith({ set: { frozen: false } });
    // The derived query is what missed a session whose `call.end()` failed —
    // frozen, never stamped, therefore invisible to it. It must not run when
    // the exact answer is available.
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("retires only the channels Stream confirmed unfrozen", async () => {
    mockSmembers.mockResolvedValue(["webinar-1", "class-2"]);
    mockUpdatePartial
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stream 500"));

    await unfreezeChannelsAfterMaintenance();

    const retired = mockSrem.mock.calls.flatMap((c) => c.slice(1));
    expect(retired).toContain("webinar-1");
    // Left in the ledger deliberately, so the next OFF transition tries again
    // rather than leaving it frozen for good.
    expect(retired).not.toContain("class-2");
  });

  it("UNIONS ledger and derived when a ledger write failed mid-drain", async () => {
    // The batch-boundary hole. Batches are recorded incrementally, so if batch
    // A records, batch B freezes fine, and B's `sadd` fails, the ledger holds
    // only A. Treating non-empty as complete would reverse A, skip the derived
    // path, and leave every channel in B frozen for good — unwritable by every
    // user AND every admin, with no error text and no visible cause.
    mockRedisGet.mockResolvedValue("1"); // a previous drain marked it incomplete
    mockSmembers.mockResolvedValue(["webinar-recorded"]);
    mockFindMany.mockResolvedValue([
      { slotOfAppointment: { appointmentId: "appt-b" } },
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-unrecorded"]);

    const result = await unfreezeChannelsAfterMaintenance();

    // Both, not either. Unfreezing something already unfrozen is an idempotent
    // no-op costing one rate-limited call; missing one is permanent.
    expect(result.unfrozen).toBe(2);
    expect(result.source).toBe("derived");

    // #1302 review — the union path still RETIRES what the ledger held. Gating
    // retirement on `source` (now "derived") stranded those ids forever: the
    // set never shrank, so every later OFF transition re-unfroze them, burning
    // the 300/min budget and reopening channels the #1303 dormancy sweep had
    // since frozen on purpose.
    const retired = mockSrem.mock.calls.flatMap((c) => c.slice(1));
    expect(retired).toContain("webinar-recorded");
  });

  it("does not union when the ledger is known complete", async () => {
    // The common path must stay cheap — no extra Prisma query, no redundant
    // Stream calls — or the union would cost something on every OFF transition.
    mockRedisGet.mockResolvedValue(null);
    mockSmembers.mockResolvedValue(["webinar-1"]);

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.source).toBe("ledger");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("treats an unreadable marker as suspect and unions anyway", async () => {
    // Being wrong here costs a few redundant unfreeze calls. Being wrong the
    // other way costs a channel nobody can post in.
    mockRedisGet.mockRejectedValue(new Error("redis down"));
    mockSmembers.mockResolvedValue(["webinar-1"]);
    mockFindMany.mockResolvedValue([
      { slotOfAppointment: { appointmentId: "appt-b" } },
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-2"]);

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.unfrozen).toBe(2);
  });

  it("records the incompleteness marker when a ledger write fails", async () => {
    mockFindMany.mockResolvedValue([session("a", "appt-1")]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1"]);
    mockSadd.mockRejectedValue(new Error("redis down"));

    await drainActiveSessions();

    expect(mockRedisSet).toHaveBeenCalledWith(
      REDIS_KEYS.FROZEN_LEDGER_INCOMPLETE,
      "1",
    );
  });

  it("clears the marker only after a CLEAN unfreeze", async () => {
    mockRedisGet.mockResolvedValue("1");
    mockSmembers.mockResolvedValue(["webinar-1"]);
    mockFindMany.mockResolvedValue([]);
    mockGetEventChannelIds.mockResolvedValue([]);

    await unfreezeChannelsAfterMaintenance();
    expect(mockRedisDel).toHaveBeenCalledWith(
      REDIS_KEYS.FROZEN_LEDGER_INCOMPLETE,
    );

    // ...and not while anything is still frozen.
    jest.clearAllMocks();
    mockRedisGet.mockResolvedValue("1");
    mockSmembers.mockResolvedValue(["webinar-1", "webinar-2"]);
    mockFindMany.mockResolvedValue([]);
    mockGetEventChannelIds.mockResolvedValue([]);
    mockUpdatePartial
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stream 500"));

    await unfreezeChannelsAfterMaintenance();
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it("falls back to the derived set when the ledger is empty", async () => {
    mockSmembers.mockResolvedValue([]);
    mockFindMany.mockResolvedValue([
      { slotOfAppointment: { appointmentId: "appt-1" } },
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1"]);

    const result = await unfreezeChannelsAfterMaintenance();

    // Approximate beats never. A key lost to eviction, or a freeze that ran
    // before this ledger existed, must not mean chat stays frozen forever.
    expect(result.source).toBe("derived");
    expect(result.unfrozen).toBe(1);
  });

  it("falls back to the derived set when Redis is unreachable", async () => {
    mockSmembers.mockRejectedValue(new Error("redis down"));
    mockFindMany.mockResolvedValue([
      { slotOfAppointment: { appointmentId: "appt-1" } },
    ]);
    mockGetEventChannelIds.mockResolvedValue(["webinar-1"]);

    const result = await unfreezeChannelsAfterMaintenance();

    expect(result.source).toBe("derived");
    expect(result.unfrozen).toBe(1);
  });

  it("reads and writes the same ledger key the freeze used", async () => {
    mockSmembers.mockResolvedValue(["webinar-1"]);

    await unfreezeChannelsAfterMaintenance();

    // Two halves of one mechanism in two functions: a typo in either key is a
    // permanently frozen channel that nothing reports.
    expect(mockSmembers).toHaveBeenCalledWith(REDIS_KEYS.FROZEN_CHANNELS);
    expect(mockSrem.mock.calls[0][0]).toBe(REDIS_KEYS.FROZEN_CHANNELS);
  });
});
