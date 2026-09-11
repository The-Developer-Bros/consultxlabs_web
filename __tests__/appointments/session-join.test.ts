/**
 * @jest-environment node
 */

/**
 * #1061 — a booking longer than 30 minutes is stored as N consecutive
 * `SlotOfAppointment` rows, but the video room used to be keyed to whichever
 * single row the clicking surface happened to pick. Two people in the same
 * booking could therefore sit alone in two different Stream rooms.
 *
 * These are the first tests to touch `lib/appointments/slots.ts` at all —
 * joinability and room identity had zero coverage, which is why the bug
 * survived. They pin the session (the contiguous run), not the row, as the
 * unit both the join window and the room key are measured over.
 */

import {
  CONSULTANT_JOIN_WINDOW_MS,
  DEFAULT_MEETING_DURATION_MS,
  CONSULTEE_JOIN_WINDOW_MS,
  findSessionRun,
  getCurrentOrNextSession,
  getJoinableSession,
  getJoinableSlot,
  getSessionJoinState,
  groupSlotsIntoRuns,
  type SessionSlotLike,
} from "@/lib/appointments/slots";

/** All fixtures live on one day so the clock reads like the issue's timeline. */
const at = (hhmm: string) => new Date(`2026-08-01T${hhmm}:00.000Z`);

function row(
  id: string,
  start: string,
  end: string,
  extra: Partial<SessionSlotLike> = {},
): SessionSlotLike {
  return {
    id,
    appointmentId: "appt-1",
    startsAt: at(start),
    endsAt: at(end),
    isTentative: false,
    completionStatus: "SCHEDULED",
    ...extra,
  };
}

/** A 10:00–11:00 consultation as the booking engine actually stores it. */
const oneHour = () => [row("A", "10:00", "10:30"), row("B", "10:30", "11:00")];

/** A 10:00–12:00 class: four rows. */
const twoHours = () => [
  row("A", "10:00", "10:30"),
  row("B", "10:30", "11:00"),
  row("C", "11:00", "11:30"),
  row("D", "11:30", "12:00"),
];

describe("session grouping", () => {
  it("collapses a one-hour booking's two rows into one session", () => {
    const runs = groupSlotsIntoRuns(oneHour());

    expect(runs).toHaveLength(1);
    expect(runs[0].anchor.id).toBe("A");
    expect(runs[0].slots.map((s) => s.id)).toEqual(["A", "B"]);
    expect(runs[0].startsAt).toEqual(at("10:00"));
    expect(runs[0].endsAt).toEqual(at("11:00"));
  });

  it("anchors every row of a run to the run's first row", () => {
    for (const slots of [oneHour(), twoHours()]) {
      for (const slot of slots) {
        expect(findSessionRun(slots, slot.id)?.anchor.id).toBe("A");
      }
    }
  });

  it("keeps a lone full-duration row as its own session", () => {
    const runs = groupSlotsIntoRuns([row("solo", "10:00", "12:00")]);

    expect(runs).toHaveLength(1);
    expect(runs[0].anchor.id).toBe("solo");
    expect(runs[0].endsAt).toEqual(at("12:00"));
  });

  it("does not fuse two sittings of the same appointment across a gap", () => {
    const runs = groupSlotsIntoRuns([
      row("A", "10:00", "10:30"),
      row("B", "14:00", "14:30"),
    ]);

    expect(runs.map((r) => r.anchor.id)).toEqual(["A", "B"]);
  });

  it("does not let a cancelled row bridge two runs", () => {
    const runs = groupSlotsIntoRuns([
      row("A", "10:00", "10:30"),
      row("B", "10:30", "11:00", { completionStatus: "CANCELLED" }),
      row("C", "11:00", "11:30"),
    ]);

    expect(runs.map((r) => r.anchor.id)).toEqual(["A", "C"]);
  });

  it("does not merge a tentative placeholder into a confirmed session", () => {
    const runs = groupSlotsIntoRuns([
      row("A", "10:00", "10:30"),
      row("B", "10:30", "11:00", { isTentative: true }),
    ]);

    expect(runs.map((r) => r.anchor.id)).toEqual(["A", "B"]);
  });

  it("falls back to a one-hour bound for a row with no endsAt", () => {
    // `MeetingSlot` declares endsAt as Date | string | null, so the join
    // surfaces really can hand us this shape.
    const runs = groupSlotsIntoRuns([
      { ...row("A", "10:00", "10:30"), endsAt: null },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].endsAt).toEqual(at("11:00"));
    expect(
      getSessionJoinState(runs[0], {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("10:45"),
      }),
    ).toBe("joinable");
    expect(
      getSessionJoinState(runs[0], {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("11:01"),
      }),
    ).toBe("ended");
  });

  it("uses that same fallback when deciding contiguity", () => {
    // A 10:00 row with no endsAt is assumed to run to 11:00, so an 11:00 row
    // continues it and a 10:30 one does not.
    const continues = groupSlotsIntoRuns([
      { ...row("A", "10:00", "10:30"), endsAt: null },
      row("B", "11:00", "11:30"),
    ]);
    const separate = groupSlotsIntoRuns([
      { ...row("A", "10:00", "10:30"), endsAt: null },
      row("B", "10:30", "11:00"),
    ]);

    expect(continues).toHaveLength(1);
    expect(continues[0].endsAt).toEqual(at("11:30"));
    expect(separate.map((r) => r.anchor.id)).toEqual(["A", "B"]);
  });

  it("never groups rows from different appointments together", () => {
    const runs = groupSlotsIntoRuns([
      row("A", "10:00", "10:30"),
      row("B", "10:30", "11:00", { appointmentId: "appt-2" }),
    ]);

    expect(runs.map((r) => r.anchor.id)).toEqual(["A", "B"]);
  });
});

describe("two parties in one booking resolve the same room", () => {
  /**
   * The test that fails on `dev`: the consultant clicks Join five minutes in
   * and the consultee twenty-five minutes in, from surfaces that pick
   * different rows. Both must come back with row A, because
   * `getOrCreateAppointmentMeeting` mints `slot-${id}` from whatever it is
   * handed.
   */
  it("gives the consultant, the consultee and a late joiner row A", () => {
    const slots = oneHour();

    const consultant = getJoinableSlot(slots, {
      joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
      now: at("10:05"),
    });
    const consultee = getJoinableSlot(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:25"),
    });
    const lateJoiner = getJoinableSlot(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:35"),
    });

    expect(consultant?.id).toBe("A");
    expect(consultee?.id).toBe("A");
    expect(lateJoiner?.id).toBe("A");
  });

  it("holds across all four rows of a two-hour session", () => {
    const slots = twoHours();
    const times = ["09:50", "10:29", "10:31", "11:15", "11:59"];

    for (const now of times) {
      expect(
        getJoinableSlot(slots, {
          joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          now: at(now),
        })?.id,
      ).toBe("A");
    }
  });
});

describe("the join window spans the whole session", () => {
  const joinable = (now: string) =>
    getJoinableSession(oneHour(), {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at(now),
    }) !== null;

  it("opens 10 minutes before the session starts", () => {
    expect(joinable("09:45")).toBe(false);
    expect(joinable("09:52")).toBe(true);
  });

  it("stays open through the second half hour", () => {
    // 10:00–10:20 was the Home tab's dead zone: live session, greyed Join.
    expect(joinable("10:05")).toBe(true);
    expect(joinable("10:29")).toBe(true);
    expect(joinable("10:45")).toBe(true);
    expect(joinable("10:59")).toBe(true);
  });

  it("closes at the end of the run, not the end of the first row", () => {
    expect(joinable("11:01")).toBe(false);
  });

  it("still closes at 10:30 for a genuine 30-minute booking", () => {
    const slots = [row("A", "10:00", "10:30")];
    const at1029 = getJoinableSession(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:29"),
    });
    const at1031 = getJoinableSession(slots, {
      joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
      now: at("10:31"),
    });

    expect(at1029?.anchor.id).toBe("A");
    expect(at1031).toBeNull();
  });

  it("falls back to the default duration when a row has no endsAt", () => {
    // `MeetingSlot` declares `endsAt` nullable and the join surfaces do hand
    // that shape over, so the run bounds depend on this fallback.
    const runs = groupSlotsIntoRuns([
      row("A", "10:00", "10:30", { endsAt: null }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].endsAt.getTime() - runs[0].startsAt.getTime()).toBe(
      DEFAULT_MEETING_DURATION_MS,
    );
  });
});

describe("ending the call ends the session", () => {
  // #1270 — a DELIBERATE end (`call_ended`). The `session_timeout` counterpart
  // is asserted below, because the distinction between them is the whole point
  // of `isDeliberateEnd`.
  const ended = {
    id: "ms-1",
    endedAt: at("10:10"),
    endedReason: "call_ended",
  };

  it("does not re-light Join later in the booked hour", () => {
    const slots = oneHour();
    slots[0].meetingSession = ended;

    for (const now of ["10:25", "10:45", "10:59"]) {
      expect(
        getJoinableSession(slots, {
          joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          now: at(now),
        }),
      ).toBeNull();
    }
  });

  it("does NOT end the session when Stream merely timed out the room", () => {
    // #1270 — the bug this predicate exists for. Stream fires
    // `call.session_ended` `inactivity_timeout_seconds` after the LAST
    // participant leaves — 30s on the live call type — so one party stepping
    // out for coffee at 09:56 of a 10:00-11:00 booking produced this row.
    // Treating it like a host closing the room locked BOTH sides out of a
    // session they had paid for and that had not started.
    const slots = oneHour();
    slots[0].meetingSession = {
      id: "ms-1",
      endedAt: at("10:10"),
      endedReason: "session_timeout",
    };

    expect(
      getSessionJoinState(groupSlotsIntoRuns(slots)[0], { now: at("10:25") }),
    ).toBe("joinable");
  });

  it("treats a reconciler's guess as non-terminal too", () => {
    // `reconciled_no_end` and `stream_not_found` are the orphan sweeper saying
    // "I could not tell", which is not the same as "the host closed it".
    for (const reason of ["reconciled_no_end", "stream_not_found"]) {
      const slots = oneHour();
      slots[0].meetingSession = {
        id: "ms-1",
        endedAt: at("10:10"),
        endedReason: reason,
      };

      expect(
        getSessionJoinState(groupSlotsIntoRuns(slots)[0], { now: at("10:25") }),
      ).toBe("joinable");
    }
  });

  it("treats a row with no reason as terminal, for historical safety", () => {
    // Rows written before the column existed carry no reason. Reading those as
    // deliberate is the conservative direction; the REQUIRED field on the slot
    // shape is what stops a forgetful projection reaching this branch.
    const slots = oneHour();
    slots[0].meetingSession = {
      id: "ms-1",
      endedAt: at("10:10"),
      endedReason: null,
    };

    expect(
      getSessionJoinState(groupSlotsIntoRuns(slots)[0], { now: at("10:25") }),
    ).toBe("ended");
  });

  it("is honoured wherever the MeetingSession happens to hang", () => {
    // Legacy rows created by the bug attached the session to a later row.
    const slots = oneHour();
    slots[1].meetingSession = ended;

    expect(
      getSessionJoinState(groupSlotsIntoRuns(slots)[0], {
        now: at("10:45"),
      }),
    ).toBe("ended");
  });
});

describe("state of a session that is not joinable", () => {
  it("counts down before the window opens", () => {
    expect(
      getSessionJoinState(groupSlotsIntoRuns(oneHour())[0], {
        now: at("09:00"),
      }),
    ).toBe("countdown");
  });

  it("is disabled while the run is only a tentative placeholder", () => {
    const slots = [
      row("A", "10:00", "10:30", { isTentative: true }),
      row("B", "10:30", "11:00", { isTentative: true }),
    ];

    expect(
      getSessionJoinState(groupSlotsIntoRuns(slots)[0], { now: at("10:05") }),
    ).toBe("disabled");
    expect(getJoinableSlot(slots, { now: at("10:05") })).toBeNull();
  });

  it("has ended once the run's last row is over", () => {
    expect(
      getSessionJoinState(groupSlotsIntoRuns(oneHour())[0], {
        now: at("11:30"),
      }),
    ).toBe("ended");
  });
});

describe("current-or-next session", () => {
  it("returns the live session rather than the one after it", () => {
    const slots = [
      ...oneHour(),
      row("C", "14:00", "14:30", { appointmentId: "appt-2" }),
    ];

    // The old `first slot whose startsAt is in the future` rule returned row B
    // here, which is what greyed out Home's Join and split the room.
    expect(getCurrentOrNextSession(slots, at("10:25"))?.anchor.id).toBe("A");
  });

  it("falls forward once the live session is over", () => {
    const slots = [
      ...oneHour(),
      row("C", "14:00", "14:30", { appointmentId: "appt-2" }),
    ];

    expect(getCurrentOrNextSession(slots, at("11:05"))?.anchor.id).toBe("C");
  });

  it("falls back to the most recent past session", () => {
    expect(getCurrentOrNextSession(oneHour(), at("18:00"))?.anchor.id).toBe(
      "A",
    );
  });

  it("returns null when there is nothing live to show", () => {
    expect(getCurrentOrNextSession([], at("10:00"))).toBeNull();
  });
});
