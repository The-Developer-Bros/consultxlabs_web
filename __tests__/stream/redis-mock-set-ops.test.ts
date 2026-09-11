/**
 * @jest-environment node
 */

/**
 * #1280 — the set operations added to `MockRedis` for the frozen-channel ledger.
 *
 * They matter because `USE_MOCK_REDIS=true` is how local dev and parts of CI
 * run: a ledger that silently misbehaves against the mock would make the
 * maintenance drain look correct everywhere except production, which is the
 * worst place to find out. Stream grants `use-frozen-channel` to no role, so
 * the failure mode on the other side is a channel nobody — user or admin — can
 * post in, with no error text.
 */

import { MockRedis } from "../../lib/redis-mock";

const KEY = "maintenance:frozen-channels";

describe("MockRedis set operations", () => {
  let redis: MockRedis;

  beforeEach(() => {
    redis = new MockRedis();
  });

  it("accumulates members across calls, as the ledger writes them per batch", async () => {
    // The drain records each batch as it confirms it, so a second `sadd` must
    // add to the first rather than replace it — that is the whole point of the
    // incremental write.
    await redis.sadd(KEY, "webinar-1", "class-2");
    await redis.sadd(KEY, "webinar-3");

    expect((await redis.smembers(KEY)).sort()).toEqual([
      "class-2",
      "webinar-1",
      "webinar-3",
    ]);
  });

  it("does not duplicate a member re-added by a retried batch", async () => {
    await redis.sadd(KEY, "webinar-1");
    const added = await redis.sadd(KEY, "webinar-1", "class-2");

    // Returns the count of NEWLY added members, like the real SADD.
    expect(added).toBe(1);
    expect((await redis.smembers(KEY)).sort()).toEqual([
      "class-2",
      "webinar-1",
    ]);
  });

  it("removes only the members named, leaving the rest for the next run", async () => {
    // The unfreeze retires exactly what Stream confirmed. A channel Stream
    // refused must stay so the next OFF transition retries it.
    await redis.sadd(KEY, "webinar-1", "class-2", "webinar-3");
    const removed = await redis.srem(KEY, "webinar-1", "missing");

    expect(removed).toBe(1);
    expect((await redis.smembers(KEY)).sort()).toEqual([
      "class-2",
      "webinar-3",
    ]);
  });

  it("reads an absent key as empty rather than throwing", async () => {
    // The first-ever unfreeze, and every unfreeze after a clean sweep.
    expect(await redis.smembers("never-written")).toEqual([]);
  });

  it("drops the key once the last member is retired", async () => {
    await redis.sadd(KEY, "webinar-1");
    await redis.srem(KEY, "webinar-1");

    expect(await redis.smembers(KEY)).toEqual([]);
    expect(redis.keys()).not.toContain(KEY);
  });

  it("reads a key holding a non-set value as empty instead of throwing", async () => {
    // A programming error rather than a runtime condition — but throwing here
    // would take down a maintenance drain, so it degrades and the caller falls
    // back to the derived set.
    await redis.set(KEY, "not-json");

    expect(await redis.smembers(KEY)).toEqual([]);
  });
});
