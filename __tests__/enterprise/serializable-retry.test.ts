/**
 * @jest-environment node
 */

import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { Prisma } from "@prisma/client";

function p2034() {
  return new Prisma.PrismaClientKnownRequestError("serialization failure", {
    code: "P2034",
    clientVersion: "test",
  });
}

describe("withSerializableRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withSerializableRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries P2034 and succeeds on a later attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockResolvedValue("ok");
    await expect(withSerializableRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries and rethrows the P2034", async () => {
    const fn = jest.fn().mockRejectedValue(p2034());
    await expect(withSerializableRetry(fn, 2)).rejects.toMatchObject({
      code: "P2034",
    });
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not retry non-P2034 errors", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(withSerializableRetry(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry business rejections (IllegalTransitionError)", async () => {
    // A 409 means the state machine said no — retrying would turn a correct
    // rejection into a corrupting second attempt.
    const fn = jest
      .fn()
      .mockRejectedValue(new IllegalTransitionError("Contract", "ACTIVE"));
    await expect(withSerializableRetry(fn)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
