/**
 * @jest-environment node
 */

/**
 * #814/#821 — withDbConnectRetry must retry ONLY connectivity-shaped
 * failures (cold Supabase pooler from GH runners) and propagate everything
 * else immediately, mirroring the serializable-retry doctrine.
 */
import { Prisma } from "@prisma/client";
import {
  isDbConnectError,
  withDbConnectRetry,
} from "../../lib/db/connect-retry";

// Prisma 7 surfaces the observed failure as a KnownRequestError carrying
// code 'ETIMEDOUT' (see #814/#821 logs) — emulate that shape.
function etimedout(): Error {
  const err = new Error("Connection timed out") as Error & { code: string };
  err.code = "ETIMEDOUT";
  return err;
}

describe("isDbConnectError", () => {
  it("matches code-carrying timeouts, P1001, and init errors", () => {
    expect(isDbConnectError(etimedout())).toBe(true);
    const p1001 = new Error("server unreachable") as Error & { code: string };
    p1001.code = "P1001";
    expect(isDbConnectError(p1001)).toBe(true);
    expect(
      isDbConnectError(
        new Prisma.PrismaClientInitializationError("boom", "7.0.0"),
      ),
    ).toBe(true);
    expect(
      isDbConnectError(new Error("Can't reach database server at host")),
    ).toBe(true);
  });

  it("rejects business errors", () => {
    expect(isDbConnectError(new Error("Unique constraint failed"))).toBe(
      false,
    );
    expect(isDbConnectError(null)).toBe(false);
  });
});

describe("withDbConnectRetry", () => {
  it("retries a transient timeout and succeeds", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(etimedout())
      .mockResolvedValue("ok");

    await expect(
      withDbConnectRetry(fn, { attempts: 3, baseMs: 1 }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget", async () => {
    const fn = jest.fn().mockRejectedValue(etimedout());

    await expect(
      withDbConnectRetry(fn, { attempts: 3, baseMs: 1 }),
    ).rejects.toThrow("Connection timed out");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry business errors", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("validation failed"));

    await expect(
      withDbConnectRetry(fn, { attempts: 3, baseMs: 1 }),
    ).rejects.toThrow("validation failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
