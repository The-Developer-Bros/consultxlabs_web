/**
 * @jest-environment node
 */

/**
 * #1280 — the orphan reconciler could only see a session that received NOTHING.
 *
 * Stream fires `call.recording_ready` once per FILE and splits any session over
 * two hours into separate files, so a three-file session is three deliveries.
 * Lose the second and third and the session has one `Recording` row, fails the
 * `recordings: { none: {} }` candidate filter, and is never examined again — the
 * missing segments are silently gone when Stream deletes them at day fourteen.
 *
 * Not hypothetical: the webhook endpoint rejected every delivery for months
 * because it demanded a secret Stream does not issue, and exactly one Stream
 * event has been received since that was fixed. Partial delivery is the
 * expected shape of recovery here, not an edge case.
 */

const mockFindMany = jest.fn();
const mockCount = jest.fn();
const mockSync = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meetingSession: {
      findMany: (...a: unknown[]) => mockFindMany(...a),
      count: (...a: unknown[]) => mockCount(...a),
    },
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
}));

jest.mock("../../lib/stream/recording-service", () => ({
  RecordingService: {
    syncSessionRecordings: (...a: unknown[]) => mockSync(...a),
  },
}));

import { reconcileOrphanedRecordings } from "../../scripts/stream/reconcile-orphaned-recordings";

/** Was this findMany the orphan pass or the partial pass? */
const isPass = (call: unknown[], key: "none" | "some") =>
  JSON.stringify((call[0] as { where?: unknown })?.where ?? {}).includes(
    `"${key}":{}`,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockCount.mockResolvedValue(0);
  mockSync.mockResolvedValue({ ok: true });
});

describe("orphan reconciler — partially delivered sessions", () => {
  it("re-examines sessions that already have a Recording", async () => {
    mockFindMany.mockImplementation((args: { where?: unknown }) =>
      Promise.resolve(
        JSON.stringify(args.where).includes('"some":{}')
          ? [{ id: "partial-1", streamCallId: "slot-1" }]
          : [],
      ),
    );

    const result = await reconcileOrphanedRecordings();

    const passes = mockFindMany.mock.calls;
    expect(passes.some((c) => isPass(c, "none"))).toBe(true);
    // Without the second pass this is false: a session holding one file of
    // three never appears as a candidate.
    expect(passes.some((c) => isPass(c, "some"))).toBe(true);
    expect(result.partialScanned).toBe(1);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it("counts a recovered segment separately from a wholly-missing session", async () => {
    mockFindMany.mockImplementation((args: { where?: unknown }) =>
      Promise.resolve(
        JSON.stringify(args.where).includes('"some":{}')
          ? [{ id: "partial-1", streamCallId: "slot-1" }]
          : [],
      ),
    );
    // syncSessionRecordings pushes newly created rows into the array it is given.
    mockSync.mockImplementation((_s: unknown, out: unknown[]) => {
      out.push({ id: "rec-segment-2" });
      return Promise.resolve({ ok: true });
    });

    const result = await reconcileOrphanedRecordings();

    // A row created here means a session we believed complete was missing a
    // file — a different and more alarming signal than one that never arrived.
    expect(result.partialRecovered).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it("spends its budget on wholly-orphaned sessions first", async () => {
    // The orphan pass fills the entire run budget, so nothing is left over.
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `orphan-${i}`,
      streamCallId: `slot-${i}`,
    }));
    mockFindMany.mockImplementation((args: { where?: unknown }) =>
      Promise.resolve(
        JSON.stringify(args.where).includes('"none":{}') ? many : [],
      ),
    );

    const result = await reconcileOrphanedRecordings();

    expect(mockFindMany.mock.calls.some((c) => isPass(c, "some"))).toBe(false);
    expect(result.partialScanned).toBe(0);
  });

  it("treats a SWALLOWED sync failure as a failure, not as an empty result", async () => {
    // `syncSessionRecordings` catches Stream and persistence errors internally so
    // one bad session cannot abort a batch — so it RESOLVES on failure and the
    // try/catch below almost never fires in production. Reading that as "no
    // recordings found" is the exact mistake this job exists to catch: an
    // unreachable Stream would be counted as checked-and-empty, run still green.
    mockFindMany.mockImplementation((args: { where?: unknown }) =>
      Promise.resolve(
        JSON.stringify(args.where).includes('"none":{}')
          ? [{ id: "orphan-1", streamCallId: "slot-1" }]
          : [],
      ),
    );
    mockSync.mockResolvedValue({ ok: false, reason: "stream-unreachable" });

    const result = await reconcileOrphanedRecordings();

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("stream-unreachable");
    // And crucially NOT counted as a session Stream had nothing for.
    expect(result.stillMissing).toBe(0);
  });

  it("does not let one failing session abort the rest of the pass", async () => {
    mockFindMany.mockImplementation((args: { where?: unknown }) =>
      Promise.resolve(
        JSON.stringify(args.where).includes('"some":{}')
          ? [
              { id: "partial-bad", streamCallId: "slot-bad" },
              { id: "partial-ok", streamCallId: "slot-ok" },
            ]
          : [],
      ),
    );
    mockSync.mockImplementationOnce(() =>
      Promise.reject(new Error("stream 500")),
    );

    const result = await reconcileOrphanedRecordings();

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("partial session partial-bad");
  });
});
