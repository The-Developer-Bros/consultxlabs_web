/**
 * @jest-environment node
 */

/**
 * #705 — the two things a ticket needs before it can face a regulator or a
 * phone call: a deadline that means something, and a handle a human can read
 * back.
 *
 * The SLA is sized to the IT Rules 2021 numbers because they are TIGHTER than
 * the Consumer Protection (E-Commerce) Rules 2020, so meeting them satisfies
 * both without first settling whether the platform is an intermediary. The
 * per-priority targets are an internal goal INSIDE that ceiling, never a
 * relaxation of it — that is what the first test pins.
 */

import {
  STATUTORY_ACK_HOURS,
  STATUTORY_RESOLUTION_DAYS,
  slaDeadlinesFor,
  slaStateOf,
  effectiveResolutionDueAt,
  applyStaffReply,
  userRepliedPatch,
  type SlaClock,
} from "@/lib/support/sla";
import {
  allocateTicketReference,
  formatTicketReference,
} from "@/lib/support/reference";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-03-01T00:00:00Z");

function clock(overrides: Partial<SlaClock> = {}): SlaClock {
  return {
    status: "OPEN",
    ackDueAt: null,
    acknowledgedAt: null,
    resolutionDueAt: null,
    resolvedAt: null,
    awaitingUserSince: null,
    pausedSeconds: 0,
    ...overrides,
  };
}

describe("SLA deadlines", () => {
  it("never exceeds the statutory ceiling on any priority", () => {
    for (const priority of ["LOW", "MEDIUM", "HIGH", "URGENT"] as const) {
      const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, T0);
      expect(ackDueAt.getTime() - T0.getTime()).toBeLessThanOrEqual(
        STATUTORY_ACK_HOURS * HOUR,
      );
      expect(resolutionDueAt.getTime() - T0.getTime()).toBeLessThanOrEqual(
        STATUTORY_RESOLUTION_DAYS * DAY,
      );
    }
  });

  it("is stricter for higher priority", () => {
    const urgent = slaDeadlinesFor("URGENT", T0);
    const low = slaDeadlinesFor("LOW", T0);
    expect(urgent.ackDueAt.getTime()).toBeLessThan(low.ackDueAt.getTime());
    expect(urgent.resolutionDueAt.getTime()).toBeLessThan(
      low.resolutionDueAt.getTime(),
    );
  });
});

describe("breach state", () => {
  it("breaches acknowledgement once the deadline passes unacknowledged", () => {
    const c = clock({ ackDueAt: new Date(T0.getTime() + HOUR) });
    expect(
      slaStateOf(c, new Date(T0.getTime() + 30 * 60_000)).ackBreached,
    ).toBe(false);
    expect(slaStateOf(c, new Date(T0.getTime() + 2 * HOUR)).ackBreached).toBe(
      true,
    );
  });

  it("stops both clocks once the ticket is settled", () => {
    // A resolved ticket cannot breach retroactively just because time passed.
    const c = clock({
      status: "RESOLVED",
      ackDueAt: new Date(T0.getTime() + HOUR),
      resolutionDueAt: new Date(T0.getTime() + DAY),
      resolvedAt: T0,
    });
    const state = slaStateOf(c, new Date(T0.getTime() + 30 * DAY));
    expect(state.ackBreached).toBe(false);
    expect(state.resolutionBreached).toBe(false);
  });

  it("reports no deadline for a ticket that predates the SLA columns", () => {
    const state = slaStateOf(clock(), new Date(T0.getTime() + 30 * DAY));
    expect(state.ackBreached).toBe(false);
    expect(state.resolutionBreached).toBe(false);
    expect(state.msToAckDue).toBeNull();
  });
});

describe("the resolution clock pauses while we are waiting on the user", () => {
  it("does not count an open wait against the team", () => {
    // Without the pause, a customer who takes three days to answer reads as the
    // team breaching a one-day target, and the number stops meaning anything.
    const c = clock({
      resolutionDueAt: new Date(T0.getTime() + DAY),
      awaitingUserSince: new Date(T0.getTime() + 2 * HOUR),
    });
    const now = new Date(T0.getTime() + 3 * DAY);
    expect(slaStateOf(c, now).resolutionBreached).toBe(false);
    expect(effectiveResolutionDueAt(c, now)!.getTime()).toBe(
      T0.getTime() + DAY + (3 * DAY - 2 * HOUR),
    );
  });

  it("still breaches when the delay was ours", () => {
    const c = clock({ resolutionDueAt: new Date(T0.getTime() + DAY) });
    expect(
      slaStateOf(c, new Date(T0.getTime() + 2 * DAY)).resolutionBreached,
    ).toBe(true);
  });

  it("banks a closed wait and does not double count a second user message", () => {
    const waited = userRepliedPatch(
      { awaitingUserSince: new Date(T0.getTime() + HOUR), pausedSeconds: 0 },
      new Date(T0.getTime() + 5 * HOUR),
    );
    expect(waited).toEqual({
      pausedSeconds: 4 * 3600,
      awaitingUserSince: null,
    });
    // Second message in a row: we were not waiting, so nothing is banked.
    expect(
      userRepliedPatch({ awaitingUserSince: null, pausedSeconds: 4 * 3600 }),
    ).toEqual({});
  });

  it("claims each milestone in the WHERE clause, so the FIRST reply wins", async () => {
    // Reading the row and then writing unconditionally is not enough: at READ
    // COMMITTED two staff replying at the same instant both see null, and the
    // later write moves a timestamp that is supposed to be the first one. The
    // guard has to be a condition the database evaluates.
    const calls: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }[] = [];
    const tx = {
      supportTicket: {
        updateMany: jest.fn(async (a: never) => {
          calls.push(a as never);
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({ awaitingUserSince: null })),
      },
    };
    await applyStaffReply(tx as never, "t1", T0);

    const ack = calls.find(
      (c) => "acknowledgedAt" in c.data && c.where.acknowledgedAt !== undefined,
    );
    const first = calls.find((c) => "firstAgentReplyAt" in c.data);
    expect(ack!.where).toEqual({ id: "t1", acknowledgedAt: null });
    expect(first!.where).toEqual({ id: "t1", firstAgentReplyAt: null });
  });

  it("banks an open wait exactly once, guarded by a compare-and-swap", async () => {
    const openedAt = new Date(T0.getTime() - DAY);
    const calls: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }[] = [];
    const tx = {
      supportTicket: {
        updateMany: jest.fn(async (a: never) => {
          calls.push(a as never);
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({ awaitingUserSince: openedAt })),
      },
    };
    await applyStaffReply(tx as never, "t1", T0);

    const bank = calls.find((c) => "pausedSeconds" in c.data);
    // Increment, not a read-modify-write, and only for the row still holding
    // the timestamp we read — the loser of a race banks nothing.
    expect(bank!.data.pausedSeconds).toEqual({ increment: 24 * 3600 });
    expect(bank!.where).toEqual({ id: "t1", awaitingUserSince: openedAt });
  });
});

describe("ticket reference", () => {
  it("is speakable, year-scoped and fits the column", () => {
    const ref = formatTicketReference(2026, 123);
    expect(ref).toBe("FAM-2026-000123");
    expect(ref.length).toBeLessThanOrEqual(20);
  });

  it("allocates the pre-increment value, so the first ticket of a year is 1", () => {
    // The counter row is seeded with nextSeq=2 BECAUSE the create path also
    // allocates seq 1 — an off-by-one here would hand two tickets the same
    // number on the very first day of a year.
    const tx = {
      supportTicketCounter: {
        upsert: jest.fn().mockResolvedValue({ nextSeq: 2 }),
      },
    };
    return allocateTicketReference(tx as never, T0).then((ref) => {
      expect(ref).toBe("FAM-2026-000001");
      const args = tx.supportTicketCounter.upsert.mock.calls[0][0];
      // Uniqueness comes from the DB doing the increment, not from us reading
      // and writing back — that read-modify-write is the race.
      expect(args.update).toEqual({ nextSeq: { increment: 1 } });
      expect(args.create).toEqual({ year: 2026, nextSeq: 2 });
    });
  });

  it("hands concurrent allocators distinct numbers", async () => {
    let next = 1;
    const tx = {
      supportTicketCounter: {
        upsert: jest.fn().mockImplementation(async () => ({ nextSeq: ++next })),
      },
    };
    const refs = await Promise.all(
      Array.from({ length: 5 }, () => allocateTicketReference(tx as never, T0)),
    );
    expect(new Set(refs).size).toBe(5);
  });
});
