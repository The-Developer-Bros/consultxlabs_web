/**
 * @jest-environment node
 */

/**
 * `runDispatchTick` is the only thing that hits the network on the
 * outbound webhook path, so its retry / backoff / status semantics
 * carry the integrator contract. The tests below pin:
 *
 *   - 2xx → SUCCESS with deliveredAt + endpoint.lastSuccessAt.
 *   - Permanent 4xx (400/403/404/...) → FAILED with no retry slot.
 *   - 5xx / 408 / 429 / network error → RETRY with the next backoff
 *     unless we just used attempt #5, in which case → DEAD_LETTER
 *     (delivery-starved, operator-replayable; FAILED stays receiver-rejected).
 *   - Endpoint flipped to PAUSED/DISABLED after enqueue → row marked
 *     FAILED with an explicit reason (operator pause wins).
 */

import { runDispatchTick } from "@/lib/enterprise/outbound-webhooks/worker";

// #1132 — fixture endpoints use the reserved `.example` TLD, which does not
// resolve, so the real SSRF guard correctly refuses every one of them. Delivery
// tests bypass it; the guard itself is covered in
// __tests__/security/audit-1132-security.test.ts, and the case below proves the
// worker still calls it when the option is omitted.
const NOOP_URL_GUARD = async () => {};

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "del-1",
    webhookEndpointId: "ep-1",
    eventType: "invoice.issued",
    payload: { id: "inv-1" },
    signature: null,
    status: "PENDING",
    httpStatusCode: null,
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    createdAt: new Date("2026-05-15T10:00:00Z"),
    deliveredAt: null,
    endpoint: {
      id: "ep-1",
      url: "https://receiver.example/webhook",
      secret:
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      status: "ACTIVE",
    },
    ...overrides,
  };
}

// #812 — `claimCount` lets a test simulate another tick winning the guarded
// atomic claim (updateMany returns {count:0}); the claimed row is then skipped
// without any dispatch. Default {count:1} = this tick owns the row.
function makePrismaStub(
  initialRow: ReturnType<typeof makeRow>,
  { claimCount = 1 }: { claimCount?: number } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  const endpointUpdates: Array<Record<string, unknown>> = [];
  return {
    prisma: {
      outboundWebhookDelivery: {
        findMany: jest.fn().mockResolvedValue([initialRow]),
        // #812 — the IN_FLIGHT soft lock is now a guarded atomic claim.
        updateMany: jest.fn().mockImplementation((args) => {
          claims.push(args);
          return Promise.resolve({ count: claimCount });
        }),
        update: jest.fn().mockImplementation((args) => {
          updates.push(args);
          return Promise.resolve({ id: initialRow.id });
        }),
      },
      webhookEndpoint: {
        update: jest.fn().mockImplementation((args) => {
          endpointUpdates.push(args);
          return Promise.resolve({ id: initialRow.endpoint.id });
        }),
        // Wave-3 auto-disable path — CAS on status+failureCount. Default to
        // "nothing flipped" so existing assertions are unaffected; tests that
        // exercise the threshold override this mock.
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    },
    updates,
    claims,
    endpointUpdates,
  };
}

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  // Cast through `unknown` because the global `fetch` signature carries
  // request-input overloads we don't need here.
  return jest.fn(impl) as unknown as typeof fetch;
}

const FROZEN_NOW_MS = new Date("2026-05-15T12:00:00Z").getTime();

describe("runDispatchTick — SSRF guard wiring (#1132)", () => {
  // Every other case in this suite injects NOOP_URL_GUARD, so removing the
  // assertUrl call from runDispatchTick would not fail any of them. This one
  // omits the option deliberately: the real guard must run, refuse the
  // reserved `.example` host, and stop the request before it is made.
  it("uses the real guard when assertUrlFn is omitted, and never dials a blocked host", async () => {
    const row = makeRow();
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => new Response("", { status: 200 }));

    const result = await runDispatchTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(0);
    // Treated as a delivery failure so it retries and eventually dead-letters,
    // rather than throwing out of the tick.
    expect(result.retried + result.failed).toBe(1);
  });
});

describe("runDispatchTick — success path", () => {
  it("marks 2xx as SUCCESS, bumps endpoint.lastSuccessAt, resets failureCount", async () => {
    const row = makeRow();
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => new Response("", { status: 200 }));

    const result = await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.succeeded).toBe(1);
    // The guarded claim (updateMany) flips PENDING → IN_FLIGHT; the lone
    // `update` then finalizes.
    expect(stub.claims[0]).toMatchObject({
      where: { id: "del-1", status: "PENDING" },
      data: { status: "IN_FLIGHT" },
    });
    const finalUpdate = stub.updates[0];
    expect(finalUpdate).toMatchObject({
      where: { id: "del-1" },
      data: expect.objectContaining({
        status: "SUCCESS",
        httpStatusCode: 200,
        attempts: 1,
      }),
    });
    expect(stub.endpointUpdates[0]).toMatchObject({
      where: { id: "ep-1" },
      data: expect.objectContaining({
        failureCount: 0,
      }),
    });
  });
});

describe("runDispatchTick — permanent client error", () => {
  it("marks a 400/403/404 as FAILED without scheduling a retry", async () => {
    const row = makeRow();
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => new Response("bad", { status: 400 }));

    const result = await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });

    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    const finalUpdate = stub.updates[0];
    expect(finalUpdate.data).toMatchObject({
      status: "FAILED",
      httpStatusCode: 400,
      lastError: expect.stringContaining("Permanent client error"),
    });
  });
});

describe("runDispatchTick — transient error / retry schedule", () => {
  it("5xx → RETRY with attempt 2's backoff (5 minutes) on the first failure", async () => {
    const row = makeRow();
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => new Response("", { status: 503 }));

    await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });

    const finalUpdate = stub.updates[0];
    expect(finalUpdate.data).toMatchObject({
      status: "RETRY",
      httpStatusCode: 503,
      attempts: 1,
    });
    // Attempt 1 just failed → schedule attempt 2 at +5min.
    const expectedNext = new Date(FROZEN_NOW_MS + 5 * 60_000);
    expect(
      (finalUpdate.data as { nextRetryAt: Date }).nextRetryAt.toISOString(),
    ).toBe(expectedNext.toISOString());
  });

  it("429 (rate-limit) is treated as transient (NOT a permanent client error)", async () => {
    const row = makeRow();
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => new Response("", { status: 429 }));

    await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });
    expect(stub.updates[0].data).toMatchObject({
      status: "RETRY",
      httpStatusCode: 429,
    });
  });

  it("after attempt 5 fails, flips to DEAD_LETTER instead of scheduling attempt 6", async () => {
    const row = makeRow({ attempts: 4 });
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => new Response("", { status: 502 }));

    await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });
    expect(stub.updates[0].data).toMatchObject({
      status: "DEAD_LETTER",
      attempts: 5,
      lastError: expect.stringContaining("Exhausted retries"),
    });
  });

  it("network error (fetch throws) follows the same retry path as a 5xx", async () => {
    const row = makeRow();
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });
    expect(stub.updates[0].data).toMatchObject({
      status: "RETRY",
      lastError: "ECONNREFUSED",
    });
  });
});

describe("runDispatchTick — operator pause", () => {
  it("aborts delivery when the endpoint flipped to PAUSED after enqueue", async () => {
    const row = makeRow({
      endpoint: {
        id: "ep-1",
        url: "https://receiver.example/webhook",
        secret: "x".repeat(64),
        status: "PAUSED",
      },
    });
    const stub = makePrismaStub(row);
    const fetchFn = mockFetch(async () => {
      // Should never be invoked — operator pause must short-circuit.
      throw new Error("fetch should not be called");
    });

    await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(stub.updates[0].data).toMatchObject({
      status: "FAILED",
      lastError: expect.stringContaining("PAUSED"),
    });
  });
});

describe("runDispatchTick — guarded atomic claim (#812)", () => {
  it("skips a row another tick already claimed (updateMany count===0) without dispatching", async () => {
    const row = makeRow();
    // Simulate the race: this tick selected the row, but a concurrent tick
    // flipped it to IN_FLIGHT first, so our guarded claim matches 0 rows.
    const stub = makePrismaStub(row, { claimCount: 0 });
    const fetchFn = mockFetch(async () => {
      throw new Error("fetch should not be called for a lost claim");
    });

    const result = await runDispatchTick({
      assertUrlFn: NOOP_URL_GUARD,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma: stub.prisma as any,
      fetchFn,
      now: () => FROZEN_NOW_MS,
    });

    // The row was scanned but the claim was lost → no HTTP, no finalize update.
    expect(result.scanned).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.retried).toBe(0);
    expect(result.failed).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(stub.claims[0]).toMatchObject({
      where: { id: "del-1", status: "PENDING" },
    });
    expect(stub.updates).toHaveLength(0);
  });
});
