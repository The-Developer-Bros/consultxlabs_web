/**
 * @jest-environment node
 */

/**
 * #1557 / #1124 — `/api/health` on a cold instance.
 *
 * The route used to arm its database deadline, hit the instance's first-await
 * stall, and report `database: "unreachable"` because the deadline woke before
 * the query ran. Now it yields first, measures the yield, and arms nothing
 * until the loop is back. The pins: a block that lands on that first yield is
 * reported under `platform.eventLoopStallMs` and does NOT touch `database` or
 * `status`; a database that really fails still does.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { user: { findFirst: jest.fn() } },
}));

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: { get: jest.fn() },
  isMockRedis: () => true,
}));

jest.mock("../../lib/maintenance", () => ({
  getMaintenanceState: jest.fn(async () => ({
    phase: "OFF",
    reason: null,
    estimatedEnd: null,
    bypassSecret: null,
    betterstackIncidentId: null,
  })),
}));

jest.mock("../../lib/stream/health", () => ({
  getStreamStatus: jest.fn(async () => ({
    configured: true,
    reachable: true,
    breakerOpen: false,
    latencyMs: 12,
  })),
}));

import * as Sentry from "@sentry/nextjs";

import { GET } from "../../app/api/health/route";
import prisma from "@/lib/prisma";

const findFirst = prisma.user.findFirst as unknown as jest.Mock;
const warn = Sentry.logger.warn as jest.Mock;

const request = () => new Request("https://x.test/api/health");

/** Block the loop synchronously for `ms` on its next turn. */
function blockLoopSoon(ms: number): void {
  setTimeout(() => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* busy */
    }
  }, 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  findFirst.mockResolvedValue({ id: "u1" });
});

describe("GET /api/health", () => {
  it("is healthy with a running loop and a reachable database", async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.database).toBe("connected");
    expect(body.platform.eventLoopStallMs).toBeLessThan(50);
    expect(body.platform.databaseProbeRetried).toBe(false);
    expect(typeof body.platform.databaseLatencyMs).toBe("number");
    expect(typeof body.platform.processUptimeMs).toBe("number");
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a first-await stall under platform and leaves the database verdict alone", async () => {
    // Queued before the handler runs, so it lands on the handler's first
    // yield — the same place #1124's stall lands on a brand-new instance.
    blockLoopSoon(60);

    const res = await GET(request());
    const body = await res.json();

    expect(body.platform.eventLoopStallMs).toBeGreaterThanOrEqual(55);
    expect(body.database).toBe("connected");
    expect(body.status).toBe("healthy");
    expect(findFirst).toHaveBeenCalledTimes(1);
    // Under the 1 s reporting threshold: telemetry in the body, no log line.
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a stall over the reporting threshold as a cold-instance stall, not a DB failure", async () => {
    blockLoopSoon(1_050);

    const body = await (await GET(request())).json();

    expect(body.platform.eventLoopStallMs).toBeGreaterThan(1_000);
    expect(body.database).toBe("connected");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("Cold-instance event-loop stall");
    expect(warn.mock.calls[0][1].extra.eventLoopStallMs).toBe(
      body.platform.eventLoopStallMs,
    );
  });

  it("a database that really fails is still degraded, and says why", async () => {
    findFirst.mockRejectedValue(new Error("connection refused"));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.database).toBe("unreachable");
    expect(body.platform.databaseProbeRetried).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("DB health probe failed");
    expect(warn.mock.calls[0][1].extra).toMatchObject({
      message: "connection refused",
      timedOut: false,
      retried: false,
    });
  });
});
