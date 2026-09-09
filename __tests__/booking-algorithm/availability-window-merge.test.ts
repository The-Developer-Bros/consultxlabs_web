/**
 * @jest-environment node
 */

/**
 * #1320 — availability stored as adjacent one-hour rows must behave exactly
 * like one two-hour row on every surface: the merge-on-save helper, the
 * booking generator, and checkout's coverage rule.
 */

import fs from "fs";
import path from "path";
import {
  coalesceAndResolve,
  mergeAdjacentCustomRows,
  mergeAdjacentWeeklyRows,
} from "../../utils/slotAllocation/mergeAdjacentWeeklyRows";
import {
  findUncoveredAtom,
  loadPublishedCoverage,
  windowAtoms,
} from "../../utils/slotAllocation/availabilityCoverage";
import type { Tx } from "../../lib/prisma";
import {
  breakDownSlotsPreservingStatus,
  mergeConsecutiveSlots,
} from "../../utils/timeSlotsProcessing";
import type { TSlotTiming } from "../../types/slots";

// The live rows from the report: Monday 10:00–11:00 and 11:00–12:00 UTC
// (15:30–17:30 IST), stored as two 60-minute rows.
const ROW_A = {
  startDay: "MONDAY" as const,
  endDay: "MONDAY" as const,
  startTimeUtc: 600,
  endTimeUtc: 660,
  utcOffsetMinutes: 330,
};
const ROW_B = {
  startDay: "MONDAY" as const,
  endDay: "MONDAY" as const,
  startTimeUtc: 660,
  endTimeUtc: 720,
  utcOffsetMinutes: 330,
};
const ROW_GAP = {
  startDay: "MONDAY" as const,
  endDay: "MONDAY" as const,
  startTimeUtc: 840,
  endTimeUtc: 900,
  utcOffsetMinutes: 330,
};

describe("mergeAdjacentWeeklyRows", () => {
  it("folds exactly-adjacent same-day rows into one and leaves gaps alone", () => {
    const merged = mergeAdjacentWeeklyRows([ROW_GAP, ROW_B, ROW_A]);
    expect(merged).toEqual([{ ...ROW_A, endTimeUtc: 720 }, ROW_GAP]);
  });

  it("never merges across days, offsets, or overnight rows", () => {
    const tue = {
      ...ROW_B,
      startDay: "TUESDAY" as const,
      endDay: "TUESDAY" as const,
    };
    const otherOffset = { ...ROW_B, utcOffsetMinutes: -180 };
    const overnight = {
      startDay: "MONDAY" as const,
      endDay: "TUESDAY" as const,
      startTimeUtc: 1380,
      endTimeUtc: 60,
      utcOffsetMinutes: 330,
    };
    expect(mergeAdjacentWeeklyRows([ROW_A, tue])).toHaveLength(2);
    expect(mergeAdjacentWeeklyRows([ROW_A, otherOffset])).toHaveLength(2);
    expect(
      mergeAdjacentWeeklyRows([{ ...ROW_A, endTimeUtc: 1380 }, overnight]),
    ).toHaveLength(2);
  });

  it("is idempotent", () => {
    const once = mergeAdjacentWeeklyRows([ROW_A, ROW_B]);
    expect(mergeAdjacentWeeklyRows(once)).toEqual(once);
  });

  // A merged row longer than isValidTimeRange's cap is filtered out of the
  // settings form, and the next PUT deletes what the form did not send back.
  it("stops the fold at the twelve-hour bound", () => {
    const eightHours = { ...ROW_A, startTimeUtc: 0, endTimeUtc: 480 };
    const nextEightHours = { ...ROW_A, startTimeUtc: 480, endTimeUtc: 960 };
    expect(mergeAdjacentWeeklyRows([eightHours, nextEightHours])).toHaveLength(
      2,
    );

    const fourHours = { ...ROW_A, startTimeUtc: 0, endTimeUtc: 240 };
    const thenEightHours = { ...ROW_A, startTimeUtc: 240, endTimeUtc: 720 };
    expect(mergeAdjacentWeeklyRows([fourHours, thenEightHours])).toEqual([
      { ...fourHours, endTimeUtc: 720 },
    ]);
  });
});

describe("mergeAdjacentCustomRows (#1320)", () => {
  const CUSTOM_A = {
    startsAt: new Date(Date.UTC(2026, 8, 7, 10, 0)),
    endsAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
  };
  const CUSTOM_B = {
    startsAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
    endsAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
  };

  it("folds an exactly-adjacent pair into one row", () => {
    expect(mergeAdjacentCustomRows([CUSTOM_B, CUSTOM_A])).toEqual([
      { startsAt: CUSTOM_A.startsAt, endsAt: CUSTOM_B.endsAt },
    ]);
  });

  it("leaves a one-minute gap alone", () => {
    const gapped = {
      ...CUSTOM_B,
      startsAt: new Date(CUSTOM_B.startsAt.getTime() + 60_000),
    };
    expect(mergeAdjacentCustomRows([CUSTOM_A, gapped])).toHaveLength(2);
  });

  it("folds an overlap and keeps the later end", () => {
    const overlapping = {
      startsAt: new Date(Date.UTC(2026, 8, 7, 10, 30)),
      endsAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
    };
    const contained = {
      startsAt: new Date(Date.UTC(2026, 8, 7, 10, 15)),
      endsAt: new Date(Date.UTC(2026, 8, 7, 10, 45)),
    };
    expect(mergeAdjacentCustomRows([CUSTOM_A, overlapping])).toEqual([
      { startsAt: CUSTOM_A.startsAt, endsAt: overlapping.endsAt },
    ]);
    expect(mergeAdjacentCustomRows([CUSTOM_A, contained])).toEqual([CUSTOM_A]);
  });

  it("is idempotent", () => {
    const once = mergeAdjacentCustomRows([CUSTOM_A, CUSTOM_B]);
    expect(mergeAdjacentCustomRows(once)).toEqual(once);
  });

  it("stops the fold at the twelve-hour bound", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 8, 7, hour, 0));
    const eightHours = { startsAt: at(0), endsAt: at(8) };
    const nextEightHours = { startsAt: at(8), endsAt: at(16) };
    expect(mergeAdjacentCustomRows([eightHours, nextEightHours])).toHaveLength(
      2,
    );

    const fourHours = { startsAt: at(0), endsAt: at(4) };
    const thenEightHours = { startsAt: at(4), endsAt: at(12) };
    expect(mergeAdjacentCustomRows([fourHours, thenEightHours])).toEqual([
      { startsAt: at(0), endsAt: at(12) },
    ]);
  });
});

// Monday 2026-09-07 10:00–12:00 UTC as four 30-minute atoms across two rows.
function atom(
  startHourUtc: number,
  half: 0 | 1,
  rowId: string,
): TSlotTiming & { isAllocated: boolean; bookingStatus: "available" } {
  const start = new Date(Date.UTC(2026, 8, 7, startHourUtc, half * 30));
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    slotId: `${rowId}-${start.toISOString()}`,
    dateInISO: start.toISOString(),
    dayOfWeek: "MONDAY",
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    slotOfAvailabilityId: rowId,
    slotOfAppointmentId: "",
    localStartTime: "",
    localEndTime: "",
    type: "WEEKLY",
    isAllocated: false,
    bookingStatus: "available",
  };
}
const ATOMS = [
  atom(10, 0, "rowA"),
  atom(10, 1, "rowA"),
  atom(11, 0, "rowB"),
  atom(11, 1, "rowB"),
];

describe("mergeConsecutiveSlots (#1320)", () => {
  it("merges contiguous available atoms across row ids and keeps every covering id", () => {
    const merged = mergeConsecutiveSlots(ATOMS);
    expect(merged).toHaveLength(1);
    expect(merged[0].startsAt).toBe(ATOMS[0].startsAt);
    expect(merged[0].endsAt).toBe(ATOMS[3].endsAt);
    expect(merged[0].slotOfAvailabilityId).toBe("rowA");
    expect(merged[0].slotOfAvailabilityIds).toEqual(["rowA", "rowB"]);
  });

  it("does not merge across a booked atom or a time gap", () => {
    const booked = { ...ATOMS[2], isAllocated: true };
    expect(
      mergeConsecutiveSlots([ATOMS[0], ATOMS[1], booked, ATOMS[3]]),
    ).toHaveLength(3);
    expect(mergeConsecutiveSlots([ATOMS[0], ATOMS[3]])).toHaveLength(2);
  });

  // Adjacency is exact. A sub-minute tolerance would offer a window whose
  // uncovered seconds no row publishes, and checkout's union rule then
  // rejects the booking the grid promised.
  it.each([1_000, 60_000])("does not merge across a %dms gap", (gapMs) => {
    const shifted = {
      ...ATOMS[2],
      startsAt: new Date(
        new Date(ATOMS[2].startsAt).getTime() + gapMs,
      ).toISOString(),
    };
    expect(mergeConsecutiveSlots([ATOMS[0], ATOMS[1], shifted])).toHaveLength(
      2,
    );
  });

  it("keeps every id an already-merged slot carries", () => {
    const earlier = atom(9, 1, "rowZ"); // 09:30–10:00, ends where rowA starts
    const alreadyMerged = {
      ...ATOMS[0],
      endsAt: ATOMS[3].endsAt,
      slotOfAvailabilityIds: ["rowA", "rowB"],
    };
    const merged = mergeConsecutiveSlots([earlier, alreadyMerged]);
    expect(merged).toHaveLength(1);
    expect(merged[0].slotOfAvailabilityIds).toEqual(["rowZ", "rowA", "rowB"]);
  });
});

describe("breakDownSlotsPreservingStatus (#1320)", () => {
  it("offers a two-hour window at the row boundary the grid promises", () => {
    const windows = breakDownSlotsPreservingStatus(ATOMS, 2, "Asia/Kolkata");
    expect(windows.map((w) => `${w.startsAt}→${w.endsAt}`)).toEqual([
      `${ATOMS[0].startsAt}→${ATOMS[3].endsAt}`,
    ]);
  });

  it("still offers both one-hour windows", () => {
    const windows = breakDownSlotsPreservingStatus(ATOMS, 1, "Asia/Kolkata");
    expect(windows).toHaveLength(3); // 10:00, 10:30, 11:00 starts
  });
});

describe("checkout coverage rule (#1320)", () => {
  const start = new Date(Date.UTC(2026, 8, 7, 10, 0)); // Monday
  const end = new Date(Date.UTC(2026, 8, 7, 12, 0));

  it("a two-hour window spanning two adjacent rows is fully covered", () => {
    expect(
      findUncoveredAtom(windowAtoms(start, end), [ROW_A, ROW_B], []),
    ).toBeNull();
  });

  it("a window that crosses a gap reports the first uncovered atom", () => {
    const uncovered = findUncoveredAtom(
      windowAtoms(start, end),
      [ROW_A, ROW_GAP],
      [],
    );
    expect(uncovered?.start.toISOString()).toBe(
      new Date(Date.UTC(2026, 8, 7, 11, 0)).toISOString(),
    );
  });

  it("custom rows cover atoms too", () => {
    const custom = [
      {
        startsAt: new Date(Date.UTC(2026, 8, 7, 11, 0)),
        endsAt: new Date(Date.UTC(2026, 8, 7, 12, 0)),
      },
    ];
    expect(
      findUncoveredAtom(windowAtoms(start, end), [ROW_A], custom),
    ).toBeNull();
  });

  it("checkout validates against the union, not the named row", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/payments/operations/checkout.ts"),
      "utf8",
    );
    expect(src).toContain("findUncoveredAtom(atoms, weeklyRows, customRows)");
    expect(src).not.toMatch(/isMinuteWithinWeeklySlot\(\s*candidateDay/);
  });

  it("every save path merges adjacent rows", () => {
    for (const f of [
      "utils/onboarding-server.ts",
      "app/api/user/consultants/[id]/route.ts",
    ]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src).toContain("mergeAdjacentWeeklyRows(");
      expect(src).toContain("mergeAdjacentCustomRows(");
    }
    for (const [f, helper] of [
      ["app/api/slots/availability/weekly/route.ts", "coalesceAndResolve("],
      [
        "app/api/slots/availability/weekly/[id]/route.ts",
        "coalesceAndResolve(",
      ],
      [
        "app/api/slots/availability/custom/route.ts",
        "coalesceAndResolveCustom(",
      ],
      [
        "app/api/slots/availability/custom/[id]/route.ts",
        "coalesceAndResolveCustom(",
      ],
    ]) {
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).toContain(
        helper,
      );
    }
  });
});

/**
 * The covering-row lookup is a containment test WITHIN one day pair. Without
 * `endDay` an overnight row (endTimeUtc < startTimeUtc) matches any same-day
 * row that starts earlier, so an edit is answered with someone else's window.
 */
describe("coalesceAndResolve resolves the edited row (#1320)", () => {
  interface StoredRow {
    id: string;
    startDay: string;
    endDay: string;
    startTimeUtc: number;
    endTimeUtc: number;
    utcOffsetMinutes: number;
  }
  const SAME_DAY: StoredRow = {
    id: "same-day",
    startDay: "MONDAY",
    endDay: "MONDAY",
    startTimeUtc: 540,
    endTimeUtc: 1080,
    utcOffsetMinutes: 0,
  };
  const OVERNIGHT: StoredRow = {
    id: "overnight",
    startDay: "MONDAY",
    endDay: "TUESDAY",
    startTimeUtc: 1320,
    endTimeUtc: 120,
    utcOffsetMinutes: 0,
  };

  function weeklyDb(rows: StoredRow[]) {
    return {
      slotOfAvailabilityWeekly: {
        findMany: async () => rows,
        deleteMany: async () => ({ count: 0 }),
        createMany: async () => ({ count: 0 }),
        findFirst: async ({
          where,
        }: {
          where: {
            startDay: string;
            endDay: string;
            startTimeUtc: { lte: number };
            endTimeUtc: { gte: number };
          };
        }) =>
          // Absent filters are absent, as Prisma treats them — so dropping
          // the endDay term makes the same-day row match this window again.
          rows.find(
            (r) =>
              r.startDay === where.startDay &&
              (where.endDay === undefined || r.endDay === where.endDay) &&
              r.startTimeUtc <= where.startTimeUtc.lte &&
              r.endTimeUtc >= where.endTimeUtc.gte,
          ) ?? null,
      },
    } as unknown as Pick<Tx, "slotOfAvailabilityWeekly">;
  }

  it("answers an overnight edit with the overnight row, not a same-day one", async () => {
    const covering = await coalesceAndResolve(
      weeklyDb([SAME_DAY, OVERNIGHT]),
      "cp-1",
      {
        startDay: OVERNIGHT.startDay as "MONDAY",
        endDay: OVERNIGHT.endDay as "TUESDAY",
        startTimeUtc: OVERNIGHT.startTimeUtc,
        endTimeUtc: OVERNIGHT.endTimeUtc,
      },
    );
    expect(covering?.id).toBe("overnight");
  });
});

describe("loadPublishedCoverage (#1320)", () => {
  function coverageDb(deletedAt: Date | null) {
    return {
      consultantProfile: {
        findUnique: async () => ({ scheduleType: "WEEKLY", deletedAt }),
      },
      slotOfAvailabilityWeekly: { findMany: async () => [ROW_A, ROW_B] },
      slotOfAvailabilityCustom: { findMany: async () => [] },
    } as unknown as Pick<
      Tx,
      | "consultantProfile"
      | "slotOfAvailabilityWeekly"
      | "slotOfAvailabilityCustom"
    >;
  }
  const start = new Date(Date.UTC(2026, 8, 7, 10, 0));
  const end = new Date(Date.UTC(2026, 8, 7, 12, 0));

  it("publishes the active arm for a live profile", async () => {
    const coverage = await loadPublishedCoverage(
      coverageDb(null),
      "cp-1",
      start,
      end,
    );
    expect(coverage.weeklyRows).toHaveLength(2);
    expect(
      findUncoveredAtom(windowAtoms(start, end), coverage.weeklyRows, []),
    ).toBeNull();
  });

  // Rows outlive a soft-deleted profile, and checkout can reach this loader
  // without ever seeing the named row. Publishing them would sell a session
  // with an expert who no longer takes bookings.
  it("publishes nothing for a soft-deleted profile", async () => {
    const coverage = await loadPublishedCoverage(
      coverageDb(new Date()),
      "cp-1",
      start,
      end,
    );
    expect(coverage).toEqual({
      scheduleType: null,
      weeklyRows: [],
      customRows: [],
    });
    expect(
      findUncoveredAtom(windowAtoms(start, end), coverage.weeklyRows, []),
    ).not.toBeNull();
  });
});
