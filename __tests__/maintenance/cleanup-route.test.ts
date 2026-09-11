/**
 * @jest-environment node
 */

/**
 * `cleanupRoute` is now the whole HTTP surface of 36 cleanup endpoints, several
 * of which are money jobs. Every guard those routes used to carry by hand — the
 * cron-secret check, the maintenance gate, the lock-held mapping and the
 * result-to-status mapping — exists exactly once, so a defect in any of them is
 * a defect in all 36 at the same time.
 *
 * The status mapping is the one worth pinning hardest. The routes only supply a
 * callback; if the factory ever stopped calling it, every money route would
 * answer a clean 200 on a failed run, and the per-route tests — which assert
 * against the route's source text — would all still pass.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/**
 * Both dependencies are mocked with the error classes declared inside the
 * factory, the same way `__tests__/payments/admin-refund-error-mapping.test.ts`
 * does it: the factory imports them from these paths, so `instanceof` compares
 * identical constructors, and the real modules stay out of the graph. That
 * matters here — `lib/cron/with-cron-lock` pulls in `lib/redis`, and a routing
 * test must not need a Redis to prove a status code.
 */
jest.mock("../../lib/cron/with-cron-lock", () => ({
  CronLockHeldError: class CronLockHeldError extends Error {},
  withCronLock: jest.fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  assertNotInMaintenance: jest.fn(),
  MaintenanceActiveError: class MaintenanceActiveError extends Error {
    httpStatus = 503;
    phase: string;
    constructor(jobName: string, phase: string) {
      super(`Maintenance mode is ${phase} — ${jobName} is unavailable`);
      this.phase = phase;
    }
  },
}));

import type { NextRequest } from "next/server";

import {
  cleanupRoute,
  InvalidLimitError,
  parseLimitParam,
  statusFor,
} from "../../lib/cron/cleanup-route";
import { CronLockHeldError } from "../../lib/cron/with-cron-lock";
import {
  assertNotInMaintenance,
  MaintenanceActiveError,
} from "../../lib/maintenance-cron";

const guard = assertNotInMaintenance as jest.Mock;

const SECRET = "test-cron-secret";

function request(auth: string | null = `Bearer ${SECRET}`): NextRequest {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return { headers } as unknown as NextRequest;
}

describe("statusFor", () => {
  it("puts failure ahead of the needs-attention flag", () => {
    // The bug this replaced: `flagged ? 207 : success ? 200 : 500` answered a
    // 2xx for a run that both failed and flagged, so a monitor read it healthy.
    expect(statusFor({ success: false }, true)).toBe(500);
    expect(statusFor({ success: false }, false)).toBe(500);
  });

  it("maps a clean run to 200 and a clean-but-flagged run to 207", () => {
    expect(statusFor({ success: true }, false)).toBe(200);
    expect(statusFor({ success: true }, true)).toBe(207);
  });

  it("treats a result with no success field as successful", () => {
    // Several routes return counters only; absence is not failure.
    expect(statusFor({})).toBe(200);
  });
});

/**
 * #1459 — `reconcile-orphaned-confirmations` kept its own parser that logged a
 * malformed `?limit=` and swept the defaults, so a broken caller produced a run
 * that looked healthy. Every ticker target now shares this one, which is worth
 * pinning directly rather than only through the route's 400 mapping.
 */
describe("parseLimitParam", () => {
  const withLimit = (raw: string | null): NextRequest =>
    ({
      nextUrl: {
        searchParams: new URLSearchParams(raw === null ? "" : { limit: raw }),
      },
    }) as unknown as NextRequest;

  it("refuses a present-but-invalid limit instead of falling back to unbounded", () => {
    // "" is `?limit=`: present, so it is junk rather than the absent default.
    for (const raw of ["", "abc", "0", "-5", "2.5"]) {
      expect(() => parseLimitParam(withLimit(raw))).toThrow(InvalidLimitError);
    }
  });

  it("clamps above the cap and passes a sane value through", () => {
    expect(parseLimitParam(withLimit("5000"))).toBe(500);
    expect(parseLimitParam(withLimit("50"))).toBe(50);
  });

  it("treats an absent limit as the unbounded GitHub Actions run", () => {
    expect(parseLimitParam(withLimit(null))).toBeUndefined();
  });
});

describe("cleanupRoute", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    guard.mockResolvedValue(undefined);
    process.env = { ...OLD_ENV, CRON_SECRET: SECRET };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("rejects a caller without the cron secret and never runs the job", async () => {
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    const res = await POST(request("Bearer wrong-secret-of-equal-length"));

    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a caller with no authorization header at all", async () => {
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    expect((await POST(request(null))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects everyone when no cron secret is configured", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.VERCEL_CRON_SECRET;
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    expect((await POST(request())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("honours the route's status callback", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => ({ success: true, discrepancies: 3 }),
      status: (r) => statusFor(r, r.discrepancies > 0),
    });

    expect((await POST(request())).status).toBe(207);
  });

  it("maps a failed run to 500 by default", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => ({ success: false, errorCount: 2 }),
    });

    const res = await POST(request());

    expect(res.status).toBe(500);
    // The body stays the result, not an error envelope: the run itself finished.
    expect(await res.json()).toEqual({ success: false, errorCount: 2 });
  });

  it("answers 409 when a concurrent run holds the lock", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => {
        throw new CronLockHeldError("held");
      },
    });

    expect((await POST(request())).status).toBe(409);
  });

  it("answers 503 with the phase when maintenance is active", async () => {
    guard.mockRejectedValue(new MaintenanceActiveError("test-job", "DEGRADED"));
    const run = jest.fn();
    const { POST } = cleanupRoute({ job: "test-job", run });

    const res = await POST(request());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ phase: "DEGRADED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the job name to the maintenance guard, since DEGRADED keys on it", async () => {
    const { POST } = cleanupRoute({
      job: "reconcile-pending-refunds",
      run: async () => ({ success: true }),
    });

    await POST(request());

    expect(guard).toHaveBeenCalledWith("reconcile-pending-refunds");
  });

  it("answers 400 INVALID_LIMIT and never runs the job on a bad ?limit=", async () => {
    const run = jest.fn(() => {
      throw new InvalidLimitError();
    });
    const { POST } = cleanupRoute({ job: "test-job", run });

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID_LIMIT" });
  });

  it("never returns the exception text to the caller", async () => {
    const { POST } = cleanupRoute({
      job: "test-job",
      run: async () => {
        throw new Error('relation "Payment" column "razorpayPayoutId"');
      },
      failureMessage: "Failed to run the test job",
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "Failed to run the test job" });
    expect(JSON.stringify(body)).not.toContain("razorpayPayoutId");
  });
});
