/**
 * @jest-environment node
 */

/**
 * The HTTP twins of the cron jobs live under `app/api/cleanup/**` and share the
 * job cores, but they run inside the Next server, where `abortIfMaintenance`'s
 * `process.exit(0)` would take the whole instance down with the request. They
 * call `assertNotInMaintenance` instead, which must apply exactly the same
 * phase rule and surface it as a 503-carrying error.
 *
 * These cases pin that rule: OFFLINE stops every job, DEGRADED stops only the
 * jobs on FINANCIAL_JOB_NAMES, and an unreachable Redis fails open so a Redis
 * outage never becomes a cleanup outage.
 */

const mockGet = jest.fn();

jest.mock("@upstash/redis", () => ({
  Redis: jest.fn().mockImplementation(() => ({ get: mockGet })),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/job-sentry", () => ({
  flushJobSentry: jest.fn(),
  runJob: jest.fn(),
}));

import {
  assertNotInMaintenance,
  MaintenanceActiveError,
  FINANCIAL_JOB_NAMES,
} from "../../lib/maintenance-cron";

const FINANCIAL_JOB = "process-payouts";
const PLAIN_JOB = "cleanup-auth-tokens";

describe("assertNotInMaintenance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  });

  it("uses names that really are (and are not) on the financial list", () => {
    // Guards the fixtures: a rename would otherwise silently turn the DEGRADED
    // cases below into two copies of the same assertion.
    expect(FINANCIAL_JOB_NAMES.has(FINANCIAL_JOB)).toBe(true);
    expect(FINANCIAL_JOB_NAMES.has(PLAIN_JOB)).toBe(false);
  });

  it("throws a 503 error for every job when the phase is OFFLINE", async () => {
    mockGet.mockResolvedValue("OFFLINE");

    for (const job of [FINANCIAL_JOB, PLAIN_JOB]) {
      const error = await assertNotInMaintenance(job).catch((e) => e);
      expect(error).toBeInstanceOf(MaintenanceActiveError);
      expect(error.httpStatus).toBe(503);
      expect(error.phase).toBe("OFFLINE");
      expect(error.jobName).toBe(job);
    }
  });

  it("throws for a financial job when the phase is DEGRADED", async () => {
    mockGet.mockResolvedValue("DEGRADED");

    const error = await assertNotInMaintenance(FINANCIAL_JOB).catch((e) => e);
    expect(error).toBeInstanceOf(MaintenanceActiveError);
    expect(error.phase).toBe("DEGRADED");
    expect(error.httpStatus).toBe(503);
  });

  it("lets a non-financial job through when the phase is DEGRADED", async () => {
    mockGet.mockResolvedValue("DEGRADED");

    await expect(assertNotInMaintenance(PLAIN_JOB)).resolves.toBeUndefined();
  });

  it("lets every job through when maintenance is off", async () => {
    for (const phase of [null, "OFF"]) {
      mockGet.mockResolvedValue(phase);
      await expect(
        assertNotInMaintenance(FINANCIAL_JOB),
      ).resolves.toBeUndefined();
      await expect(assertNotInMaintenance(PLAIN_JOB)).resolves.toBeUndefined();
    }
  });

  it("fails open when the Redis probe throws", async () => {
    mockGet.mockRejectedValue(new Error("upstash unreachable"));

    await expect(
      assertNotInMaintenance(FINANCIAL_JOB),
    ).resolves.toBeUndefined();
  });

  it("fails open when Redis is not configured at all", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    await expect(
      assertNotInMaintenance(FINANCIAL_JOB),
    ).resolves.toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
