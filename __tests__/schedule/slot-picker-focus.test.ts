// #1073 — the instant the slot picker opens on, and where that instant lands
// on the grid. Target selection is per-surface only in the sense that each
// surface hands the resolver a different set of sessions, so these cases are
// written as the shapes those subjects actually arrive in.

import type { SlotLike } from "@/lib/appointments/view-model";
import {
  FOCUS_LEAD_ROWS,
  earliestAvailabilityRow,
  focusGridPosition,
  focusScrollRow,
  focusTargetRow,
  resolveFocusTarget,
} from "@/lib/scheduling/slot-picker-focus";

const NOW = new Date("2026-08-01T09:00:00Z");

function session(
  id: string,
  startsAt: string,
  overrides: Partial<SlotLike> = {},
): SlotLike {
  return {
    id,
    appointmentId: `appt-${id}`,
    startsAt,
    endsAt: new Date(
      new Date(startsAt).getTime() + 60 * 60 * 1000,
    ).toISOString(),
    isTentative: false,
    ...overrides,
  };
}

describe("resolveFocusTarget", () => {
  it("targets the one session of a single-session consultation", () => {
    const focus = resolveFocusTarget(
      { slots: [session("s1", "2026-08-08T05:00:00Z")] },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-08-08T05:00:00Z"),
      precision: "session",
    });
  });

  it("targets a past session when the single session has already run", () => {
    const focus = resolveFocusTarget(
      { slots: [session("s1", "2026-07-20T05:00:00Z")] },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-07-20T05:00:00Z"),
      precision: "session",
    });
  });

  it("prefers the session awaiting a time over the next upcoming one", () => {
    // The released session is LATER than the next confirmed one, so picking it
    // cannot be an accident of sort order.
    const focus = resolveFocusTarget(
      {
        slots: [
          session("done", "2026-07-20T05:00:00Z"),
          session("next", "2026-08-02T05:00:00Z"),
          session("released", "2026-08-06T05:00:00Z", { isTentative: true }),
        ],
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-08-06T05:00:00Z"),
      precision: "session",
    });
  });

  it("targets the next upcoming session of a fully-placed program", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("w1", "2026-07-20T05:00:00Z"),
          session("w3", "2026-08-10T05:00:00Z"),
          session("w2", "2026-08-04T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-08-04T05:00:00Z"),
      precision: "session",
    });
  });

  it("ignores a released session whose old time has already passed", () => {
    // Opening on it would put the consultant on a week of disabled cells —
    // the dead end the period anchor exists to avoid.
    const focus = resolveFocusTarget(
      {
        slots: [
          session("stale", "2026-07-10T05:00:00Z", { isTentative: true }),
          session("next", "2026-08-05T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus.at).toEqual(new Date("2026-08-05T05:00:00Z"));
  });

  it("ignores soft-deleted sessions", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("tombstoned", "2026-08-02T05:00:00Z", {
            deletedAt: "2026-07-25T00:00:00Z",
          }),
          session("live", "2026-08-09T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus.at).toEqual(new Date("2026-08-09T05:00:00Z"));
  });

  it("falls back to the most recent session of a finished program", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("w1", "2026-06-01T05:00:00Z"),
          session("w3", "2026-07-15T05:00:00Z"),
          session("w2", "2026-06-20T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-07-15T05:00:00Z"),
      precision: "session",
    });
  });

  it("ignores sessions that were cancelled or already moved", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("gone", "2026-08-02T05:00:00Z", {
            completionStatus: "CANCELLED",
          }),
          session("moved", "2026-08-03T05:00:00Z", {
            completionStatus: "RESCHEDULED",
          }),
          session("live", "2026-08-09T05:00:00Z"),
        ],
      },
      NOW,
    );

    expect(focus.at).toEqual(new Date("2026-08-09T05:00:00Z"));
  });

  it("looks forward, not back, when placed sessions are over but the window is not", () => {
    // Every session so far has run, and there are months of period left to
    // fill. The remaining sessions can only go in the future, so the past is
    // both the wrong answer and — in allocate mode, where the availability
    // request runs from the visible week to `allowedEnd` — a needlessly
    // enormous fetch (#997).
    const focus = resolveFocusTarget(
      {
        slots: [
          session("w1", "2026-05-04T05:00:00Z"),
          session("w2", "2026-06-01T05:00:00Z"),
        ],
        allowedStart: new Date("2026-05-01T00:00:00Z"),
        allowedEnd: new Date("2026-12-01T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({ at: NOW, precision: "period" });
  });

  it("still targets the last session once the window has closed too", () => {
    const focus = resolveFocusTarget(
      {
        slots: [
          session("w1", "2026-05-04T05:00:00Z"),
          session("w2", "2026-06-01T05:00:00Z"),
        ],
        allowedStart: new Date("2026-05-01T00:00:00Z"),
        allowedEnd: new Date("2026-06-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-06-01T05:00:00Z"),
      precision: "session",
    });
  });

  it("targets the start of the scheduling period when nothing is scheduled", () => {
    // An `unscheduled-class-<id>` subject: a period, and no sessions at all.
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-09-01T00:00:00Z"),
        allowedEnd: new Date("2026-11-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-09-01T00:00:00Z"),
      precision: "period",
    });
  });

  it("never opens on a period start that has already passed", () => {
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-07-01T00:00:00Z"),
        allowedEnd: new Date("2026-11-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({ at: NOW, precision: "period" });
  });

  it("opens on the last day of a period that has already closed", () => {
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-05-01T00:00:00Z"),
        allowedEnd: new Date("2026-06-30T00:00:00Z"),
      },
      NOW,
    );

    expect(focus).toEqual({
      at: new Date("2026-06-30T00:00:00Z"),
      precision: "period",
    });
  });

  it("falls back to now when there is neither a session nor a period", () => {
    expect(resolveFocusTarget({}, NOW)).toEqual({
      at: NOW,
      precision: "period",
    });
  });

  it("never lands past the end of an inverted window", () => {
    // Bad data rather than a real window, but honouring it would open the
    // picker outside the bound it clamps selection to.
    const focus = resolveFocusTarget(
      {
        allowedStart: new Date("2026-12-01T00:00:00Z"),
        allowedEnd: new Date("2026-09-01T00:00:00Z"),
      },
      NOW,
    );

    expect(focus.at).toEqual(new Date("2026-09-01T00:00:00Z"));
  });
});

describe("focusTargetRow", () => {
  const availability = [
    { startTime: new Date("2026-08-03T10:00:00Z") },
    { startTime: new Date("2026-08-04T08:30:00Z") },
  ];

  it("uses the session's own row, availability notwithstanding", () => {
    const row = focusTargetRow(
      { at: new Date("2026-08-03T14:30:00Z"), precision: "session" },
      availability,
      "UTC",
    );

    expect(row).toBe(29); // 14:30
  });

  it("routes a window bound through first availability instead of 00:00", () => {
    const row = focusTargetRow(
      { at: new Date("2026-08-03T00:00:00Z"), precision: "period" },
      availability,
      "UTC",
    );

    expect(row).toBe(17); // 08:30, not row 0
  });

  it("falls back to the bound's own row when nothing is published", () => {
    const row = focusTargetRow(
      { at: new Date("2026-08-03T06:00:00Z"), precision: "period" },
      [],
      "UTC",
    );

    expect(row).toBe(12);
  });
});

describe("focusScrollRow", () => {
  it("leaves rows above the target rather than clipping it to the edge", () => {
    expect(focusScrollRow(20)).toBe(20 - FOCUS_LEAD_ROWS);
  });

  it("clamps at the top instead of scrolling negative", () => {
    expect(focusScrollRow(0)).toBe(0);
    expect(focusScrollRow(1)).toBe(0);
    expect(focusScrollRow(FOCUS_LEAD_ROWS)).toBe(0);
  });
});

describe("focusGridPosition", () => {
  // One instant, three zones. The row and the calendar date both move with the
  // zone — reading either in the viewer's zone instead of the grid's is how
  // focus lands an offset away (#1064's defect class).
  const at = new Date("2026-08-01T02:30:00Z");

  it("reads the row in the timezone it is given, not the viewer's", () => {
    expect(focusGridPosition(at, "UTC")).toEqual({
      year: 2026,
      month: 8,
      day: 1,
      hour: 2,
      minute: 30,
      rowIndex: 5,
    });

    expect(focusGridPosition(at, "Asia/Kolkata")).toEqual({
      year: 2026,
      month: 8,
      day: 1,
      hour: 8,
      minute: 0,
      rowIndex: 16,
    });
  });

  it("moves the calendar date too when the zone pushes across midnight", () => {
    // 22:30 the previous evening in New York — a different day, and therefore
    // a different week column, from the same instant.
    expect(focusGridPosition(at, "America/New_York")).toEqual({
      year: 2026,
      month: 7,
      day: 31,
      hour: 22,
      minute: 30,
      rowIndex: 45,
    });
  });

  it("puts midnight on the first row, on its OWN day", () => {
    // An h24 formatter writes this as 24:00 against 31 July; the day would
    // then be off by one everywhere the same parts are read.
    expect(focusGridPosition(new Date("2026-08-01T00:00:00Z"), "UTC")).toEqual({
      year: 2026,
      month: 8,
      day: 1,
      hour: 0,
      minute: 0,
      rowIndex: 0,
    });
  });
});

describe("earliestAvailabilityRow", () => {
  it("returns the earliest published time of day across the week", () => {
    const row = earliestAvailabilityRow(
      [
        { startTime: new Date("2026-08-03T14:00:00Z") },
        { startTime: new Date("2026-08-04T09:30:00Z") },
        { startTime: new Date("2026-08-05T11:00:00Z") },
      ],
      "UTC",
    );

    expect(row).toBe(19); // 09:30
  });

  it("returns null when the consultant has published nothing", () => {
    expect(earliestAvailabilityRow([], "UTC")).toBeNull();
  });
});
