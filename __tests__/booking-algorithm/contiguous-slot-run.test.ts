/**
 * #1071 — contiguous N×30min slot runs for planner create/update.
 */

import "./setup";

import {
  assertSingleContiguousLiveRun,
  buildContiguousSlotAtoms,
  replaceContiguousSlotRun,
  SLOT_DURATION_MS,
} from "@/lib/appointments/contiguous-slot-run";

describe("buildContiguousSlotAtoms", () => {
  const startsAt = new Date("2026-08-10T10:00:00.000Z");

  it("creates one atom for a 30-minute session", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 0.5,
      consultantProfileId: "cp_1",
    });
    expect(atoms).toHaveLength(1);
    expect(atoms[0].startsAt.toISOString()).toBe("2026-08-10T10:00:00.000Z");
    expect(atoms[0].endsAt.toISOString()).toBe("2026-08-10T10:30:00.000Z");
  });

  it("creates four contiguous atoms for a 2-hour session", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 2,
      consultantProfileId: "cp_1",
      isTentative: false,
    });
    expect(atoms).toHaveLength(4);
    for (let i = 0; i < atoms.length; i++) {
      const expectedStart = startsAt.getTime() + i * SLOT_DURATION_MS;
      expect(atoms[i].startsAt.getTime()).toBe(expectedStart);
      expect(atoms[i].endsAt.getTime()).toBe(expectedStart + SLOT_DURATION_MS);
    }
    for (let i = 1; i < atoms.length; i++) {
      expect(atoms[i].startsAt.getTime()).toBe(atoms[i - 1].endsAt.getTime());
    }
  });

  it("creates two atoms for a 60-minute session (allocator parity)", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 1,
      consultantProfileId: "cp_1",
    });
    expect(atoms).toHaveLength(2);
    expect(atoms[1].endsAt.getTime() - atoms[0].startsAt.getTime()).toBe(
      60 * 60 * 1000,
    );
  });

  it("attaches user connects when userIds are provided", () => {
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 1,
      consultantProfileId: "cp_1",
      userIds: ["u1", "u2", "u1"],
    });
    expect(atoms[0].user?.connect).toEqual([{ id: "u1" }, { id: "u2" }]);
  });

  it("rejects non-positive duration", () => {
    expect(() =>
      buildContiguousSlotAtoms({
        startsAt,
        durationInHours: 0,
        consultantProfileId: "cp_1",
      }),
    ).toThrow(/durationInHours/);
  });
});

describe("assertSingleContiguousLiveRun", () => {
  it("accepts a contiguous 2-hour run", () => {
    const startsAt = new Date("2026-08-10T10:00:00.000Z");
    const atoms = buildContiguousSlotAtoms({
      startsAt,
      durationInHours: 2,
      consultantProfileId: "cp_1",
    });
    expect(() =>
      assertSingleContiguousLiveRun(
        atoms.map((a, i) => ({
          id: `s${i}`,
          appointmentId: "a1",
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          isTentative: false,
          completionStatus: "SCHEDULED",
        })),
      ),
    ).not.toThrow();
  });

  it("rejects the old #1071 failure mode (first atom moved, rest stranded)", () => {
    expect(() =>
      assertSingleContiguousLiveRun([
        {
          id: "s0",
          appointmentId: "a1",
          startsAt: new Date("2026-08-14T10:00:00.000Z"),
          endsAt: new Date("2026-08-14T10:30:00.000Z"),
          completionStatus: "SCHEDULED",
        },
        {
          id: "s1",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T10:30:00.000Z"),
          endsAt: new Date("2026-08-10T11:00:00.000Z"),
          completionStatus: "SCHEDULED",
        },
        {
          id: "s2",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T11:00:00.000Z"),
          endsAt: new Date("2026-08-10T11:30:00.000Z"),
          completionStatus: "SCHEDULED",
        },
      ]),
    ).toThrow(/exactly one contiguous run/);
  });

  it("ignores CANCELLED / RESCHEDULED rows when checking contiguity", () => {
    expect(() =>
      assertSingleContiguousLiveRun([
        {
          id: "dead",
          appointmentId: "a1",
          startsAt: new Date("2026-08-01T10:00:00.000Z"),
          endsAt: new Date("2026-08-01T10:30:00.000Z"),
          completionStatus: "RESCHEDULED",
        },
        {
          id: "s0",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T10:00:00.000Z"),
          endsAt: new Date("2026-08-10T10:30:00.000Z"),
          completionStatus: "SCHEDULED",
        },
        {
          id: "s1",
          appointmentId: "a1",
          startsAt: new Date("2026-08-10T10:30:00.000Z"),
          endsAt: new Date("2026-08-10T11:00:00.000Z"),
          completionStatus: "SCHEDULED",
        },
      ]),
    ).not.toThrow();
  });
});

describe("replaceContiguousSlotRun", () => {
  function stubTx(liveRows: Array<Record<string, unknown>>) {
    const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
    const creates: Array<Record<string, unknown>> = [];
    const updateManyCalls: Array<{
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    }> = [];
    let findManyCalls = 0;
    return {
      updates,
      creates,
      updateManyCalls,
      tx: {
        slotOfAppointment: {
          findMany: jest.fn(async () => {
            findManyCalls += 1;
            if (findManyCalls === 1) return liveRows;
            // Post-write live read — synthesise from creates + updated times.
            const retired = new Set(
              updates
                .filter((u) => u.data.completionStatus === "RESCHEDULED")
                .map((u) => u.id),
            );
            const isLive = (r: Record<string, unknown>) =>
              !r.deletedAt &&
              r.completionStatus !== "CANCELLED" &&
              r.completionStatus !== "RESCHEDULED" &&
              !retired.has(r.id as string);
            const kept = liveRows.filter(isLive).map((r) => {
              const upd = [...updates].reverse().find((u) => u.id === r.id);
              return upd ? { ...r, ...upd.data } : r;
            });
            return [...kept, ...creates].sort(
              (a, b) =>
                new Date(a.startsAt as Date).getTime() -
                new Date(b.startsAt as Date).getTime(),
            );
          }),
          updateMany: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: { in: string[] } };
              data: Record<string, unknown>;
            }) => {
              updateManyCalls.push({ where, data });
              for (const id of where.id.in) {
                updates.push({ id, data });
              }
              return { count: where.id.in.length };
            },
          ),
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: Record<string, unknown>;
            }) => {
              updates.push({ id: where.id, data });
              return {};
            },
          ),
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
            creates.push({ id: `new-${creates.length}`, ...data });
            return {};
          }),
        },
      },
    };
  }

  it("updates overlapping live rows in place and soft-retires surplus", async () => {
    const startsAt = new Date("2026-08-10T10:00:00.000Z");
    const liveRows = [
      {
        id: "s0",
        startsAt,
        endsAt: new Date("2026-08-10T10:30:00.000Z"),
        completionStatus: "SCHEDULED",
        deletedAt: null,
        user: [{ id: "u1" }],
      },
      {
        id: "s1",
        startsAt: new Date("2026-08-10T10:30:00.000Z"),
        endsAt: new Date("2026-08-10T11:00:00.000Z"),
        completionStatus: "SCHEDULED",
        deletedAt: null,
        user: [{ id: "u1" }],
      },
      {
        id: "dead",
        startsAt: new Date("2026-08-01T10:00:00.000Z"),
        endsAt: new Date("2026-08-01T10:30:00.000Z"),
        completionStatus: "RESCHEDULED",
        deletedAt: null,
        user: [{ id: "u2" }],
      },
    ];
    const { tx, updates, creates } = stubTx(liveRows);

    const result = await replaceContiguousSlotRun(tx as never, {
      appointmentId: "a1",
      startsAt: new Date("2026-08-14T12:00:00.000Z"),
      durationInHours: 0.5,
      consultantProfileId: "cp_1",
    });

    // One live atom kept (updated), one surplus soft-retired, dead untouched.
    // Assert startsAt — updateMany's tentative pre-pass also touches s0.
    expect(
      updates.some(
        (u) =>
          u.id === "s0" &&
          (u.data.startsAt as Date | undefined)?.toISOString() ===
            "2026-08-14T12:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      updates.some(
        (u) => u.id === "s1" && u.data.completionStatus === "RESCHEDULED",
      ),
    ).toBe(true);
    expect(updates.some((u) => u.id === "dead")).toBe(false);
    expect(creates).toHaveLength(0);
    expect(result.preservedUserIds).toEqual(["u1"]);
    expect(result.createdCount).toBe(1);
  });

  it("creates extra atoms when duration grows and preserves user ids", async () => {
    const liveRows = [
      {
        id: "s0",
        startsAt: new Date("2026-08-10T10:00:00.000Z"),
        endsAt: new Date("2026-08-10T10:30:00.000Z"),
        completionStatus: "SCHEDULED",
        deletedAt: null,
        user: [{ id: "host" }, { id: "buyer" }],
      },
    ];
    const { tx, updates, creates } = stubTx(liveRows);

    const result = await replaceContiguousSlotRun(tx as never, {
      appointmentId: "a1",
      startsAt: new Date("2026-08-10T10:00:00.000Z"),
      durationInHours: 1,
      consultantProfileId: "cp_1",
    });

    expect(
      updates.some(
        (u) =>
          u.id === "s0" &&
          (u.data.startsAt as Date | undefined)?.toISOString() ===
            "2026-08-10T10:00:00.000Z",
      ),
    ).toBe(true);
    expect(creates).toHaveLength(1);
    expect(result.preservedUserIds.sort()).toEqual(["buyer", "host"]);
    expect(result.createdCount).toBe(2);
  });

  it("tentative-flips the whole live run before an overlapping forward shift", async () => {
    // 2h @ 10:00 → 11:00: without the pre-pass, updating s0 to [11:00,11:30)
    // collides with s2 still holding that window under slot_no_confirmed_overlap.
    const liveRows = [0, 1, 2, 3].map((i) => ({
      id: `s${i}`,
      startsAt: new Date(`2026-08-10T${10 + Math.floor(i / 2)}:${i % 2 === 0 ? "00" : "30"}:00.000Z`),
      endsAt: new Date(
        `2026-08-10T${10 + Math.floor((i + 1) / 2)}:${(i + 1) % 2 === 0 ? "00" : "30"}:00.000Z`,
      ),
      completionStatus: "SCHEDULED",
      deletedAt: null,
      user: [],
    }));
    const { tx, updateManyCalls, updates } = stubTx(liveRows);

    await replaceContiguousSlotRun(tx as never, {
      appointmentId: "a1",
      startsAt: new Date("2026-08-10T11:00:00.000Z"),
      durationInHours: 2,
      consultantProfileId: "cp_1",
      isTentative: false,
    });

    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].data).toEqual({ isTentative: true });
    expect(updateManyCalls[0].where.id.in.sort()).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
    ]);
    // Per-row restores must follow the tentative pre-pass (first 4 updates
    // are the updateMany fan-out in the stub).
    const restoreIdx = updates.findIndex(
      (u) => u.id === "s0" && u.data.startsAt instanceof Date,
    );
    expect(restoreIdx).toBeGreaterThanOrEqual(4);
    expect(updates[restoreIdx].data.isTentative).toBe(false);
  });
});
