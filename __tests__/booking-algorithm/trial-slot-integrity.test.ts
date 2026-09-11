/**
 * #1169 PR 1 — trial slot integrity + interval-granular locking.
 *
 * Four contracts, each of which has silently failed before:
 * 1. slotAtomStarts makes OVERLAPPING intervals share lock keys even when
 *    their start instants differ (the double-charge shape: 10:00–12:00 vs
 *    11:00–12:00).
 * 2. The trial route writes consultantProfileId on its slot (without it the
 *    slot escapes the slot_no_confirmed_overlap exclusion constraint, #1093
 *    §1) and locks under the SHARED slot-booking namespace (the retired
 *    trial-slot-booking namespace contended with nothing).
 * 3. Capacity reads whose query forgot the user include throw loudly instead
 *    of silently counting zero registrants for a sold-out event.
 * 4. lockSlotInterval is all-or-nothing over its atoms (#1170 review):
 *    contention rolls back every atom already held and names the conflicting
 *    atom in SlotLockError; Redis-down fails CLOSED (typed 503) before any
 *    atom is taken; and a multi-atom acquisition re-arms every atom to a
 *    fresh shared deadline, aborting if any ownership was already lost.
 */

import fs from "fs";
import path from "path";

// Functional in-memory SET NX / eval fake so lockSlotInterval can be exercised
// end-to-end (acquisition, re-arm, rollback) without a real Redis.
jest.mock("../../lib/redis", () => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const pexpireCalls: string[] = [];
  const failPexpire = new Set<string>();
  const client = {
    set: async (
      key: string,
      value: string,
      opts: { nx?: boolean; px?: number },
    ) => {
      const existing = store.get(key);
      if (existing && existing.expiresAt > Date.now()) return null;
      store.set(key, {
        value,
        expiresAt: Date.now() + (opts.px ?? 60000),
      });
      return "OK";
    },
    eval: async (script: string, keys: string[], args: string[]) => {
      const entry = store.get(keys[0]);
      if (!entry || entry.value !== args[0]) return 0;
      if (script.includes("pexpire")) {
        if (failPexpire.has(keys[0])) return 0;
        pexpireCalls.push(keys[0]);
        entry.expiresAt = Date.now() + Number(args[1]);
        return 1;
      }
      store.delete(keys[0]);
      return 1;
    },
  };
  return {
    __esModule: true,
    default: client,
    withCircuitBreaker: jest.fn(async (fn: () => unknown) => fn()),
    checkRedisHealth: jest.fn(async () => true),
    __test: { store, pexpireCalls, failPexpire },
  };
});

import {
  slotAtomStarts,
  lockSlotInterval,
  lockSlotBooking,
  BookingLockUnavailableError,
} from "../../utils/appointmentlock";
import { SlotLockError } from "../../utils/errors/SlotLockError";
import { getWebinarCapacity, getClassCapacity } from "../../lib/events/capacity";

const redisMock = jest.requireMock("../../lib/redis") as {
  checkRedisHealth: jest.Mock;
  __test: {
    store: Map<string, { value: string; expiresAt: number }>;
    pexpireCalls: string[];
    failPexpire: Set<string>;
  };
};
const redisTest = redisMock.__test;

describe("slotAtomStarts — interval → 30-minute atom keys", () => {
  const at = (iso: string) => new Date(iso);

  it("covers an aligned interval with one atom per half hour", () => {
    const atoms = slotAtomStarts(
      at("2026-09-01T10:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    );
    expect(atoms.map((a) => a.toISOString())).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:30:00.000Z",
      "2026-09-01T11:00:00.000Z",
      "2026-09-01T11:30:00.000Z",
    ]);
  });

  it("makes overlapping intervals with different starts share atoms", () => {
    const a = slotAtomStarts(
      at("2026-09-01T10:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    ).map((d) => d.toISOString());
    const b = slotAtomStarts(
      at("2026-09-01T11:00:00.000Z"),
      at("2026-09-01T12:00:00.000Z"),
    ).map((d) => d.toISOString());
    const shared = b.filter((atom) => a.includes(atom));
    expect(shared).toEqual([
      "2026-09-01T11:00:00.000Z",
      "2026-09-01T11:30:00.000Z",
    ]);
  });

  it("floors an unaligned start to the half-hour grid so it still collides", () => {
    const atoms = slotAtomStarts(
      at("2026-09-01T10:10:00.000Z"),
      at("2026-09-01T10:40:00.000Z"),
    ).map((d) => d.toISOString());
    expect(atoms).toEqual([
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T10:30:00.000Z",
    ]);
  });

  it("returns no atoms for an empty interval", () => {
    const t = at("2026-09-01T10:00:00.000Z");
    expect(slotAtomStarts(t, t)).toHaveLength(0);
  });
});

describe("trial route source contract (#1093 §1)", () => {
  const routeSource = fs.readFileSync(
    path.join(process.cwd(), "app/api/trials/[trialId]/route.ts"),
    "utf8",
  );

  it("stamps consultantProfileId on the trial slot create", () => {
    // The line only exists inside the slot-create block, so a whole-file
    // containment check is exact enough.
    expect(routeSource).toContain(
      "consultantProfileId: existingTrial.consultantProfileId",
    );
  });

  it("locks under the shared slot-booking namespace, not a trial-only one", () => {
    expect(routeSource).toContain("lockSlotBooking");
    expect(routeSource).not.toContain("trial-slot-booking");
    expect(routeSource).not.toContain("lockTrialSlot");
  });

  it("validates availability on the transaction client, not the global one", () => {
    expect(routeSource).toContain("db: Tx");
    expect(routeSource).toMatch(/validateSlotAvailability\(\s*tx,/);
  });

  it("takes the consultee lock before the slot lock (checkout's global order, #898)", () => {
    // The GiST net and the slot atoms are both consultant-keyed; only the
    // consultee lock stops two trials for the same consultee booking through
    // two different consultants concurrently (#1170 review).
    const consulteeAt = routeSource.search(/await lockConsulteeBooking\(/);
    const slotAt = routeSource.search(/await lockSlotBooking\(/);
    expect(consulteeAt).toBeGreaterThan(-1);
    expect(slotAt).toBeGreaterThan(-1);
    expect(consulteeAt).toBeLessThan(slotAt);
    expect(routeSource).toContain("unlockConsulteeBooking");
  });
});

describe("lock module source contract", () => {
  const lockSource = fs.readFileSync(
    path.join(process.cwd(), "utils/appointmentlock.ts"),
    "utf8",
  );

  it("has retired the trial-slot-booking namespace entirely", () => {
    // Key CONSTRUCTION is what must be gone; the tombstone comment may still
    // name the namespace.
    expect(lockSource).not.toContain("`trial-slot-booking:${");
    expect(lockSource).not.toContain("export async function lockTrialSlot");
  });
});

/**
 * Behavioral lock semantics against the in-memory SET NX / eval fake (#1170
 * review). Retry backoff is exponential and would burn real wall-clock, so the
 * contention case runs under fake timers and drains the delays explicitly —
 * same pattern as event-checkout-lock-fail-closed.test.ts.
 */
async function settleWithTimers<T>(p: Promise<T>): Promise<T | Error> {
  const tracked = p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );
  // 6 attempts per atom; drain every pending backoff timer until it settles.
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await jest.runAllTimersAsync();
  }
  const r = await tracked;
  return r.ok ? r.v : r.e;
}

describe("lockSlotInterval — all-or-nothing acquisition semantics", () => {
  const CID = "consultant-1";
  const key = (iso: string) => `slot-booking:${CID}:${iso}`;
  const START = "2026-09-01T10:00:00.000Z";

  beforeEach(() => {
    redisTest.store.clear();
    redisTest.pexpireCalls.length = 0;
    redisTest.failPexpire.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("acquires every atom and re-arms all of them to a fresh shared deadline", async () => {
    const locks = await lockSlotInterval(
      CID,
      new Date(START),
      new Date("2026-09-01T11:00:00.000Z"),
    );

    expect(locks.map((l) => l.key)).toEqual([
      key("2026-09-01T10:00:00.000Z"),
      key("2026-09-01T10:30:00.000Z"),
    ]);
    // Every atom is owned in Redis under the lock's own value.
    for (const lock of locks) {
      expect(redisTest.store.get(lock.key)?.value).toBe(lock.value);
    }
    // #1170 review — sequential backoff erodes early atoms' TTLs, so the
    // final step re-arms EVERY atom (pexpire) to one fresh deadline.
    expect(redisTest.pexpireCalls).toEqual(locks.map((l) => l.key));
    const deadlines = locks.map(
      (l) => redisTest.store.get(l.key)!.expiresAt,
    );
    expect(Math.abs(deadlines[0] - deadlines[1])).toBeLessThan(2000);
    for (const d of deadlines) {
      expect(d).toBeGreaterThan(Date.now() + 50_000);
    }
  });

  it("skips the re-arm roundtrip for a single-atom interval (no erosion possible)", async () => {
    const locks = await lockSlotInterval(
      CID,
      new Date(START),
      new Date("2026-09-01T10:30:00.000Z"),
    );

    expect(locks).toHaveLength(1);
    expect(redisTest.store.get(locks[0].key)?.value).toBe(locks[0].value);
    expect(redisTest.pexpireCalls).toEqual([]);
  });

  it("rolls back every held atom on contention and names the conflicting atom", async () => {
    jest.useFakeTimers();
    // A foreign writer holds the MIDDLE atom of 10:00–11:30.
    const heldISO = "2026-09-01T10:30:00.000Z";
    redisTest.store.set(key(heldISO), {
      value: "someone-else",
      expiresAt: Date.now() + 3_600_000,
    });

    const err = await settleWithTimers(
      lockSlotBooking(CID, START, "2026-09-01T11:30:00.000Z"),
    );

    expect(err).toBeInstanceOf(SlotLockError);
    expect(err).toMatchObject({
      consultantId: CID,
      slotTime: heldISO,
      retryAfterSeconds: 60,
    });
    // All-or-nothing: the first atom was taken then ROLLED BACK, the atom
    // after the conflict was never attempted, the foreign hold is untouched.
    expect(redisTest.store.has(key("2026-09-01T10:00:00.000Z"))).toBe(false);
    expect(redisTest.store.has(key("2026-09-01T11:00:00.000Z"))).toBe(false);
    expect(redisTest.store.get(key(heldISO))?.value).toBe("someone-else");
    expect(redisTest.pexpireCalls).toEqual([]);
  });

  it("fails CLOSED with a typed 503 when Redis is unhealthy, before taking any atom", async () => {
    redisMock.checkRedisHealth.mockResolvedValueOnce(false);

    const err = await lockSlotBooking(
      CID,
      START,
      "2026-09-01T11:00:00.000Z",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BookingLockUnavailableError);
    expect((err as BookingLockUnavailableError).httpStatus).toBe(503);
    expect((err as BookingLockUnavailableError).code).toBe(
      "BOOKING_LOCK_UNAVAILABLE",
    );
    // Fail closed means NO partial state: nothing was written to Redis.
    expect(redisTest.store.size).toBe(0);
  });

  it("aborts and rolls back when a re-arm fails (ownership already lost)", async () => {
    redisTest.failPexpire.add(key("2026-09-01T10:00:00.000Z"));

    const err = await lockSlotInterval(
      CID,
      START,
      "2026-09-01T11:00:00.000Z",
    ).catch((e: unknown) => e);

    // A lost re-arm means the interval is NOT protected — the acquisition
    // must surface as retryable contention, never return partially-armed locks.
    expect(err).toBeInstanceOf(SlotLockError);
    expect(redisTest.store.has(key("2026-09-01T10:00:00.000Z"))).toBe(false);
    expect(redisTest.store.has(key("2026-09-01T10:30:00.000Z"))).toBe(false);
  });
});

describe("capacity include-trap (#676 CN-4)", () => {
  const plan = { maxParticipants: 10 };

  it("throws when webinar slots were loaded without the user relation", () => {
    expect(() =>
      getWebinarCapacity({
        webinar: {
          maxParticipants: null,
          appointment: { slotsOfAppointment: [{ startsAt: "x" }] },
        },
        plan,
      }),
    ).toThrow(/user was not included/);
  });

  it("counts normally when the user relation is present", () => {
    const capacity = getWebinarCapacity({
      webinar: {
        maxParticipants: null,
        appointment: {
          slotsOfAppointment: [
            { user: [{ id: "u1" }, { id: "u2" }] },
            { user: [{ id: "u1" }] },
          ],
        },
      },
      plan,
    });
    expect(capacity.registered).toBe(2);
    expect(capacity.remaining).toBe(8);
    expect(capacity.isFull).toBe(false);
  });

  it("throws for class capacity with a missing user relation on any session", () => {
    expect(() =>
      getClassCapacity({
        classInstance: {
          maxParticipants: 1,
          appointments: [
            { slotsOfAppointment: [{ user: [{ id: "u1" }] }] },
            { slotsOfAppointment: [{ notUser: true }] },
          ],
        },
        plan,
      }),
    ).toThrow(/user was not included/);
  });
});
