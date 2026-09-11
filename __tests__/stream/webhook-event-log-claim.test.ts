/**
 * @jest-environment node
 */

/**
 * #1134 P1-2 — the three-state machine in `logWebhookEvent`, and the two ways it
 * failed open.
 *
 * The states are encoded on `processed` + `error`:
 *   processed=true  + no error  -> SUCCESS      skip, idempotent
 *   processed=true  + error set -> FAILED       allow retry
 *   processed=false + no error  -> IN-PROGRESS  skip, another worker has it
 *
 * IN-PROGRESS has a five-minute staleness escape so a crashed `after()` cannot
 * wedge an event forever. Two defects lived in that escape:
 *
 *   1. The retry path reset `processed` and `error` but NOT `receivedAt`. The
 *      staleness check measures `now - receivedAt`, so a retried row was
 *      instantly older than the threshold — the in-progress guard fell open for
 *      exactly the rows it exists to protect, and the sweeper could pick up an
 *      event another worker was mid-way through.
 *   2. Both escapes read the row, decided, then wrote. Check-then-act: two
 *      workers both observe "stale", both write, both believe they own it, and
 *      the handler runs twice. For an attendance write or a moderation action
 *      that is a duplicate side effect, not a no-op.
 *
 * Both are now conditional writes whose row count IS the claim.
 */

const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockCreate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webhookEvent: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import {
  logWebhookEvent,
  markWebhookEventProcessed,
} from "../../lib/webhooks/event-log";

const SIX_MINUTES_AGO = new Date(Date.now() - 6 * 60 * 1000);
const ONE_MINUTE_AGO = new Date(Date.now() - 60 * 1000);

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockCreate.mockResolvedValue({ id: "new" });
});

describe("the FAILED -> retry path", () => {
  it("moves receivedAt forward, so the row is not instantly stale", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: true,
      error: "boom",
      receivedAt: SIX_MINUTES_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(true);
    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.receivedAt).toBeInstanceOf(Date);
    // Not the original — that was the bug: the retried row kept a timestamp
    // already past the staleness threshold, so the very next caller treated an
    // actively-processing event as abandoned.
    expect(data.receivedAt.getTime()).toBeGreaterThan(
      SIX_MINUTES_AGO.getTime(),
    );
  });

  it("claims conditionally, so a racing worker loses", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: true,
      error: "boom",
      receivedAt: SIX_MINUTES_AGO,
    });
    // Another worker got there first: our conditional write matches no row.
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
    expect(mockUpdateMany.mock.calls[0][0].where).toMatchObject({
      eventId: "e1",
      error: { not: null },
    });
  });
});

describe("the IN-PROGRESS staleness escape", () => {
  it("scopes the claim to the timestamp it read", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: null,
      receivedAt: SIX_MINUTES_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(true);
    // The read timestamp is in the WHERE. That is what makes exactly one of two
    // racing workers win, instead of both.
    expect(mockUpdateMany.mock.calls[0][0].where).toMatchObject({
      eventId: "e1",
      receivedAt: SIX_MINUTES_AGO,
    });
  });

  it("yields to the winner when the row moved under it", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: null,
      receivedAt: SIX_MINUTES_AGO,
    });
    mockUpdateMany.mockResolvedValue({ count: 0 });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
  });

  it("still refuses a genuinely in-flight event", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: false,
      error: null,
      receivedAt: ONE_MINUTE_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("the SUCCESS path stays idempotent", () => {
  it("skips a row already processed without error", async () => {
    mockFindUnique.mockResolvedValue({
      id: "r1",
      processed: true,
      error: null,
      receivedAt: SIX_MINUTES_AGO,
    });

    const res = await logWebhookEvent("stream", "e1", "call.ended", {});

    expect(res.isNew).toBe(false);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("closing a delivery out", () => {
  const mockUpdate = jest.fn();
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const prisma = require("../../lib/prisma").default;
    prisma.webhookEvent.update = mockUpdate;
    mockUpdate.mockResolvedValue({});
  });

  it("records success as a null error", async () => {
    await markWebhookEventProcessed("e1", undefined);
    expect(mockUpdate.mock.calls[0][0].data.error).toBeNull();
  });

  it("does NOT let an empty error message read as success", async () => {
    // `new Error("")` yields an empty processingError, and `"" || null`
    // collapsed to null — the SUCCESS shape. The event failed and was marked
    // permanently handled, and the sweeper skips processed=true/error=null, so
    // nothing would ever revisit it.
    await markWebhookEventProcessed("e1", "");
    expect(mockUpdate.mock.calls[0][0].data.error).not.toBeNull();
    expect(mockUpdate.mock.calls[0][0].data.error).toBe("unknown handler error");
  });

  it("keeps a real error message intact", async () => {
    await markWebhookEventProcessed("e1", "handler exploded");
    expect(mockUpdate.mock.calls[0][0].data.error).toBe("handler exploded");
  });
});
