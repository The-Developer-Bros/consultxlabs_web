/**
 * @jest-environment node
 */

/**
 * #1134 P1-20 — Stream caps `upsertUsers`, `addMembers`/`removeMembers` and
 * `deleteChannels` at 100 per request. Every bulk call in this codebase passed
 * the whole array straight through, so a webinar roster above 100 (the plan
 * default, and `Webinar.maxParticipants` is unbounded) produced an oversized
 * request that threw into a catch which did not even reach Sentry — the
 * attendee silently got no chat.
 */

import {
  addRemainingMembers,
  chunk,
  createMemberChunk,
  forEachChunk,
  queryChannelsPaged,
  STREAM_BATCH_LIMIT,
  STREAM_CONCURRENCY_LIMIT,
  STREAM_QUERY_CHANNELS_LIMIT,
  STREAM_QUERY_CHANNELS_MAX_OFFSET,
} from "@/lib/stream/batch";

describe("chunk", () => {
  it("defaults to Stream's documented ceiling", () => {
    expect(STREAM_BATCH_LIMIT).toBe(100);
    const batches = chunk(Array.from({ length: 250 }, (_, i) => i));
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
  });

  it("never emits an oversized batch, at any input size", () => {
    for (const n of [1, 99, 100, 101, 199, 200, 201, 1000]) {
      const batches = chunk(Array.from({ length: n }, (_, i) => i));
      expect(batches.every((b) => b.length <= STREAM_BATCH_LIMIT)).toBe(true);
      expect(batches.flat()).toHaveLength(n);
    }
  });

  it("loses nothing and preserves order", () => {
    const input = Array.from({ length: 137 }, (_, i) => `u${i}`);
    expect(chunk(input, 25).flat()).toEqual(input);
  });

  it("yields no batches for an empty list", () => {
    // The callers must not fire a request with an empty member array.
    expect(chunk([])).toEqual([]);
  });

  it("rejects a nonsense size rather than looping forever", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow();
  });
});

describe("forEachChunk", () => {
  it("runs batches sequentially", async () => {
    // Sequential on purpose: Stream rate-limits per app, so firing twenty
    // chunks at once to shave latency off one webinar create is how you 429
    // every other request in flight.
    const order: string[] = [];
    await forEachChunk(
      Array.from({ length: 30 }, (_, i) => i),
      async (batch, index) => {
        order.push(`start:${index}`);
        await new Promise((r) => setTimeout(r, 1));
        order.push(`end:${index}`);
        expect(batch.length).toBeLessThanOrEqual(10);
      },
      10,
    );
    expect(order).toEqual([
      "start:0",
      "end:0",
      "start:1",
      "end:1",
      "start:2",
      "end:2",
    ]);
  });

  it("does not invoke the callback for an empty list", async () => {
    const fn = jest.fn();
    await forEachChunk([], fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates a failure rather than silently skipping the rest", async () => {
    const seen: number[] = [];
    await expect(
      forEachChunk(
        [1, 2, 3, 4],
        async (batch, index) => {
          seen.push(index);
          if (index === 1) throw new Error("stream 429");
        },
        2,
      ),
    ).rejects.toThrow("stream 429");
    // Stopped at the failure; the caller decides whether to retry.
    expect(seen).toEqual([0, 1]);
  });
});

describe("payload ceiling vs fan-out width", () => {
  it("keeps them as separate constants", () => {
    // They answer different questions and only coincidentally started the same.
    // STREAM_BATCH_LIMIT is how many items fit in ONE request (upsertUsers,
    // addMembers, deleteChannels). STREAM_CONCURRENCY_LIMIT is how many separate
    // requests to have in flight for operations Stream gives no bulk endpoint
    // for — freezing a channel being the one that bit.
    expect(STREAM_CONCURRENCY_LIMIT).toBeLessThan(STREAM_BATCH_LIMIT);
    expect(Number.isInteger(STREAM_CONCURRENCY_LIMIT)).toBe(true);
    expect(STREAM_CONCURRENCY_LIMIT).toBeGreaterThan(0);
  });

  it("rejects a non-integer chunk size instead of silently misbehaving", () => {
    // `items.slice(i, i + 2.5)` does not throw; it produces uneven chunks and a
    // caller that thinks it bounded a payload has not.
    expect(() => chunk([1, 2, 3], 2.5)).toThrow(/positive integer/);
    expect(() => chunk([1, 2, 3], 0)).toThrow(/positive integer/);
    expect(() => chunk([1, 2, 3], -1)).toThrow(/positive integer/);
  });
});

describe("queryChannelsPaged", () => {
  /**
   * Stand-in for Stream: holds `total` channels and returns at most
   * STREAM_QUERY_CHANNELS_LIMIT of them per call, no matter what limit is
   * asked for. That trimming is the whole defect (#1270).
   */
  const streamLike = (total: number) => {
    const calls: { limit: number; offset: number }[] = [];
    const fetchPage = async ({
      limit,
      offset,
    }: {
      limit: number;
      offset: number;
    }) => {
      calls.push({ limit, offset });
      const served = Math.min(limit, STREAM_QUERY_CHANNELS_LIMIT);
      return Array.from({ length: total }, (_, i) => `ch-${i}`).slice(
        offset,
        offset + served,
      );
    };
    return { calls, fetchPage };
  };

  it("pages at Stream's real cap, not at the requested limit", () => {
    // The constant IS the assertion. Asking for 100 and receiving 30 is what
    // made `while (page.length === PAGE_SIZE)` exit after one page.
    expect(STREAM_QUERY_CHANNELS_LIMIT).toBe(30);
  });

  it("asks for a second page when the first comes back exactly full", async () => {
    const { calls, fetchPage } = streamLike(45);

    const { channels, truncated } = await queryChannelsPaged(fetchPage);

    // The regression this pins: 30 rows back must NOT read as "that is all".
    expect(calls).toHaveLength(2);
    expect(channels).toHaveLength(45);
    expect(truncated).toBe(false);
  });

  it("sees a stale channel sitting past the first page", async () => {
    const { fetchPage } = streamLike(60);
    const stale = async (opts: { limit: number; offset: number }) => {
      const page = await fetchPage(opts);
      return page.map((id) => (id === "ch-41" ? "stale-dm" : id));
    };

    const { channels } = await queryChannelsPaged(stale);

    // Position 41 is the DM revocation leak: the old walk stopped at 30, so
    // reconciliation never classified this membership stale and never revoked
    // it.
    expect(channels).toContain("stale-dm");
  });

  it("advances by the rows returned, never by the requested limit", async () => {
    const { calls, fetchPage } = streamLike(90);

    await queryChannelsPaged(fetchPage);

    // `offset += 100` would have jumped 0 -> 100 and skipped 70 channels.
    expect(calls.map((c) => c.offset)).toEqual([0, 30, 60, 90]);
  });

  it("stops on a short page without a wasted extra request", async () => {
    const { calls, fetchPage } = streamLike(12);

    const { channels, truncated } = await queryChannelsPaged(fetchPage);

    expect(calls).toHaveLength(1);
    expect(channels).toHaveLength(12);
    expect(truncated).toBe(false);
  });

  it("treats an empty first page as an empty answer, not a truncated one", async () => {
    // This is the circuit-breaker degrade path: breaker-open hands back [].
    const { channels, truncated } = await queryChannelsPaged(async () => []);

    expect(channels).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("stops at Stream's offset ceiling and says the answer is partial", async () => {
    const { calls, fetchPage } = streamLike(5000);

    const { channels, truncated } = await queryChannelsPaged(fetchPage);

    // Silent truncation would let a partial reconcile report a clean sweep.
    expect(truncated).toBe(true);
    expect(channels.length).toBeGreaterThan(STREAM_QUERY_CHANNELS_MAX_OFFSET);
    expect(
      calls.every((c) => c.offset <= STREAM_QUERY_CHANNELS_MAX_OFFSET),
    ).toBe(true);
  });
});

describe("createMemberChunk / addRemainingMembers", () => {
  const roster = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

  it("passes a small roster through whole, with no follow-up request", async () => {
    const channel = { addMembers: jest.fn().mockResolvedValue({}) };

    expect(createMemberChunk(roster(2))).toEqual(["u0", "u1"]);
    await addRemainingMembers(channel, roster(2));

    expect(channel.addMembers).not.toHaveBeenCalled();
  });

  it("caps the create() roster and adds the rest in bounded batches", async () => {
    const channel = { addMembers: jest.fn().mockResolvedValue({}) };
    const members = roster(250);

    const first = createMemberChunk(members);
    await addRemainingMembers(channel, members);

    // A 250-seat webinar used to hand all 250 to create() and be rejected.
    expect(first).toHaveLength(STREAM_BATCH_LIMIT);
    expect(first[0]).toBe("u0");
    expect(channel.addMembers).toHaveBeenCalledTimes(2);

    const sent = channel.addMembers.mock.calls.map(([batch]) => batch);
    expect(sent.map((b: string[]) => b.length)).toEqual([100, 50]);
    // Nobody is dropped and nobody is added twice.
    expect([...first, ...sent.flat()]).toEqual(members);
  });

  it("keeps the head of the roster in the atomic create", () => {
    // Callers order host and joiner first precisely so they cannot land in a
    // follow-up request that fails on its own.
    const members = ["host", "joiner", ...roster(500)];
    expect(createMemberChunk(members).slice(0, 2)).toEqual(["host", "joiner"]);
  });
});
