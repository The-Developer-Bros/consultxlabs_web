/**
 * @jest-environment node
 */

import {
  withCronLock,
  CronLockHeldError,
  CronLockUnavailableError,
  LONG_JOB_TTL_MS,
} from "../../lib/cron/with-cron-lock";
import redis, {
  acquireLock,
  releaseLock,
  isMockRedis,
  checkRedisHealth,
} from "../../lib/redis";
import prisma from "../../lib/prisma";

// Both mocks are declared on the RELATIVE path while the module under test
// imports the `@/` alias. tsconfig maps `@/*` → `./*`, so next/jest resolves
// the two specifiers to one module and a single registration covers both.
jest.mock("../../lib/redis", () => ({
  __esModule: true,
  // #1169 — the wrapper now writes the fleet heartbeat through the default
  // export; without it `redis.set` is a TypeError swallowed by touchHeartbeat.
  default: { set: jest.fn() },
  acquireLock: jest.fn(),
  releaseLock: jest.fn().mockResolvedValue(undefined),
  isMockRedis: jest.fn(),
  checkRedisHealth: jest.fn(),
  // Breaker state probe — the wrapper consults this to tell a genuinely-held
  // lock apart from an open circuit (which must page, not skip).
  isRedisCircuitOpen: jest.fn().mockReturnValue(false),
}));

// #697 — the trail is reached through `await import("@/lib/prisma")` inside the
// wrapper. Unmocked, a test run would load the real client.
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    systemJobExecution: { create: jest.fn(), update: jest.fn() },
  },
}));

const mockAcquire = acquireLock as jest.Mock;
const mockRelease = releaseLock as jest.Mock;
const mockIsMock = isMockRedis as jest.Mock;
const mockHealth = checkRedisHealth as jest.Mock;
const mockSet = (redis as unknown as { set: jest.Mock }).set;
const trail = (
  prisma as unknown as {
    systemJobExecution: { create: jest.Mock; update: jest.Mock };
  }
).systemJobExecution;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsMock.mockReturnValue(false);
  mockHealth.mockResolvedValue(true);
  mockAcquire.mockResolvedValue("token-1");
  mockSet.mockResolvedValue("OK");
  trail.create.mockResolvedValue({ id: "exec-1" });
  trail.update.mockResolvedValue({});
});

describe("withCronLock", () => {
  it("acquires with the #476 key shape, runs, and releases", async () => {
    const fn = jest.fn().mockResolvedValue("done");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).resolves.toBe("done");
    expect(mockAcquire).toHaveBeenCalledWith(
      "cron:lock:dunning",
      15 * 60 * 1000,
    );
    expect(mockRelease).toHaveBeenCalledWith("cron:lock:dunning", "token-1");
  });

  it("honours a custom TTL", async () => {
    await withCronLock(
      "create-payout-batch",
      { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
      async () => null,
    );
    expect(mockAcquire).toHaveBeenCalledWith(
      "cron:lock:create-payout-batch",
      LONG_JOB_TTL_MS,
    );
  });

  it("throws CronLockHeldError (409) when the lock is held — job skips", async () => {
    mockAcquire.mockResolvedValue(null);
    const fn = jest.fn();
    const err = await withCronLock("dunning", { failMode: "closed" }, fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CronLockHeldError);
    expect((err as CronLockHeldError).httpStatus).toBe(409);
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases even when the job throws", async () => {
    const boom = new Error("boom");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("fail-closed: refuses to run on mock Redis (pages via exit 1)", async () => {
    mockIsMock.mockReturnValue(true);
    const fn = jest.fn();
    await expect(
      withCronLock("dunning", { failMode: "closed" }, fn),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("#1205-triage: breaker OPEN at acquire → CronLockUnavailableError (pages), not a held skip", async () => {
    mockAcquire.mockResolvedValue(null);
    mockHealth.mockResolvedValue(true); // pre-acquire health passes
    const { isRedisCircuitOpen } = jest.requireMock("../../lib/redis") as {
      isRedisCircuitOpen: jest.Mock;
    };
    isRedisCircuitOpen.mockReturnValue(true);

    const fn = jest.fn().mockResolvedValue("done");
    const err = await withCronLock("dunning", { failMode: "closed" }, fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CronLockUnavailableError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("#1205-triage: null acquire + Redis downed AFTER a healthy gate pages too", async () => {
    // The first-four-failures window: breaker CLOSED, but every op fails —
    // acquire returns null via the error fallback while isRedisCircuitOpen()
    // is false. Only the fresh health probe distinguishes this from "held".
    // Healthy at the pre-acquire gate (Redis reachable then), down by the
    // post-null re-probe — exactly the mid-window failure the old code
    // misclassified as CronLockHeldError.
    mockHealth.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockAcquire.mockResolvedValue(null);
    const { isRedisCircuitOpen } = jest.requireMock("../../lib/redis") as {
      isRedisCircuitOpen: jest.Mock;
    };
    isRedisCircuitOpen.mockReturnValue(false);
    const fn = jest.fn().mockResolvedValue("done");

    const err = await withCronLock("dunning", { failMode: "closed" }, fn).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CronLockUnavailableError);
    // Two probes total: the pre-acquire gate + the post-null re-probe.
    expect(mockHealth).toHaveBeenCalledTimes(2);
  });

  it("fail-closed: refuses to run when Redis is unhealthy (circuit open)", async () => {
    mockHealth.mockResolvedValue(false);
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => null),
    ).rejects.toBeInstanceOf(CronLockUnavailableError);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("fail-open: runs unlocked on mock Redis with a warning", async () => {
    mockIsMock.mockReturnValue(true);
    const fn = jest.fn().mockResolvedValue(42);
    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, fn),
    ).resolves.toBe(42);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it("fail-open: still skips when the lock is genuinely held", async () => {
    mockAcquire.mockResolvedValue(null);
    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, async () => 1),
    ).rejects.toBeInstanceOf(CronLockHeldError);
  });
});

/**
 * #697 INF-2 — the SystemJobExecution trail. The job is the product; the trail
 * is bookkeeping about it. Every assertion here exists to keep that ordering
 * true, because a trail that can fail a payout run is worse than no trail.
 */
describe("withCronLock job trail (#697)", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("opens a RUNNING row and closes it COMPLETED with a duration", async () => {
    await withCronLock("dunning", { failMode: "closed" }, async () => "ok");

    expect(trail.create).toHaveBeenCalledTimes(1);
    expect(trail.create.mock.calls[0][0].data).toMatchObject({
      jobId: "dunning",
      jobName: "dunning",
      status: "RUNNING",
    });
    expect(trail.update).toHaveBeenCalledTimes(1);
    const finish = trail.update.mock.calls[0][0];
    expect(finish.where).toEqual({ id: "exec-1" });
    expect(finish.data.status).toBe("COMPLETED");
    expect(finish.data.errorLog).toBeUndefined();
    expect(typeof finish.data.durationMs).toBe("number");
    expect(finish.data.endedAt).toBeInstanceOf(Date);
  });

  it("closes the row FAILED with the stack, and still rethrows", async () => {
    const boom = new Error("payout gateway 500");
    await expect(
      withCronLock("process-payouts", { failMode: "closed" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const finish = trail.update.mock.calls[0][0];
    expect(finish.data.status).toBe("FAILED");
    expect(finish.data.errorLog).toContain("payout gateway 500");
  });

  it("truncates errorLog — @db.Text is not a licence for unbounded stacks", async () => {
    const huge = new Error("x".repeat(50_000));
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => {
        throw huge;
      }),
    ).rejects.toBe(huge);

    expect(trail.update.mock.calls[0][0].data.errorLog).toHaveLength(8_000);
  });

  it("a failed trail OPEN never fails the job, and skips the close", async () => {
    trail.create.mockRejectedValue(new Error("no DATABASE_URL"));
    const fn = jest.fn().mockResolvedValue("still ran");

    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, fn),
    ).resolves.toBe("still ran");

    expect(fn).toHaveBeenCalledTimes(1);
    // No row id means nothing to update — and no second failure to swallow.
    expect(trail.update).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("a failed trail CLOSE never fails the job", async () => {
    trail.update.mockRejectedValue(new Error("connection reset"));
    await expect(
      withCronLock("cleanup-auth-tokens", { failMode: "open" }, async () => 7),
    ).resolves.toBe(7);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it("a failed trail CLOSE never masks the job's own error", async () => {
    trail.update.mockRejectedValue(new Error("connection reset"));
    const boom = new Error("the real failure");
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("writes no trail when the lock is held — a skip is not a run", async () => {
    mockAcquire.mockResolvedValue(null);
    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => 1),
    ).rejects.toBeInstanceOf(CronLockHeldError);
    expect(trail.create).not.toHaveBeenCalled();
  });

  it("writes no trail on the unlocked mock-Redis path", async () => {
    mockIsMock.mockReturnValue(true);
    await withCronLock(
      "cleanup-auth-tokens",
      { failMode: "open" },
      async () => 1,
    );
    expect(trail.create).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});

/**
 * #866 — the fleet dead-man. /api/health reads this one key, so every locked
 * run has to refresh it and none of them may die trying.
 */
describe("withCronLock fleet heartbeat (#866)", () => {
  it("refreshes cron:heartbeat:last with an ISO timestamp", async () => {
    await withCronLock("dunning", { failMode: "closed" }, async () => null);

    expect(mockSet).toHaveBeenCalledTimes(1);
    const [key, value] = mockSet.mock.calls[0];
    expect(key).toBe("cron:heartbeat:last");
    expect(Number.isNaN(Date.parse(value as string))).toBe(false);
  });

  it("a failed heartbeat write never fails the job", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockSet.mockRejectedValue(new Error("upstash 503"));

    await expect(
      withCronLock("dunning", { failMode: "closed" }, async () => "ok"),
    ).resolves.toBe("ok");

    warn.mockRestore();
  });
});
