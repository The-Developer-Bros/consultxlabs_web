/**
 * @jest-environment node
 */

/**
 * #1199 — the consultee Home month view merged non-contiguous sittings.
 *
 * `groupSlotsIntoSessions` grouped by `appointmentId` alone, which is a claim
 * that a booking is one session no matter when its rows sit. A subscription
 * with a Tuesday 09:00 and a Thursday 16:00 sitting therefore rendered ONE
 * phantom session running from Tuesday morning to Thursday afternoon, and the
 * "Sessions Completed" stat counted the pair as one.
 *
 * It now delegates to `groupSlotsIntoRuns`, which is the definition every
 * other surface already uses: contiguous rows, same appointment, same
 * tentative flag — cancelled and rescheduled rows dropped rather than left to
 * bridge two runs that never touched.
 */

import {
  groupSlotsIntoSessions,
  type ProcessedEventSlot,
} from "../../app/dashboard/consultee/[consulteeId]/(features)/home/event-processor";

const APPT = "appt-1";
const DAY = "2026-03-04";

function slot(
  id: string,
  startIso: string,
  endIso: string,
  extra: Partial<ProcessedEventSlot> = {},
): ProcessedEventSlot {
  return {
    id,
    appointmentId: APPT,
    startsAt: new Date(startIso),
    endsAt: new Date(endIso),
    isTentative: false,
    completionStatus: null,
    ...extra,
  };
}

describe("groupSlotsIntoSessions", () => {
  it("splits two non-contiguous 30-minute slots on one day into two sessions", () => {
    const sessions = groupSlotsIntoSessions([
      slot("s1", `${DAY}T09:00:00.000Z`, `${DAY}T09:30:00.000Z`),
      slot("s2", `${DAY}T16:00:00.000Z`, `${DAY}T16:30:00.000Z`),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].startTime.toISOString()).toBe(`${DAY}T09:00:00.000Z`);
    expect(sessions[0].endTime.toISOString()).toBe(`${DAY}T09:30:00.000Z`);
    expect(sessions[1].startTime.toISOString()).toBe(`${DAY}T16:00:00.000Z`);
    expect(sessions[1].endTime.toISOString()).toBe(`${DAY}T16:30:00.000Z`);
    // Same appointment, two rows — so the React key has to come off the run.
    expect(sessions[0].appointmentId).toBe(APPT);
    expect(sessions[1].appointmentId).toBe(APPT);
    expect(sessions[0].id).not.toBe(sessions[1].id);
  });

  it("still collapses a genuine back-to-back run into one session", () => {
    const sessions = groupSlotsIntoSessions([
      slot("s1", `${DAY}T09:00:00.000Z`, `${DAY}T09:30:00.000Z`),
      slot("s2", `${DAY}T09:30:00.000Z`, `${DAY}T10:00:00.000Z`),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].startTime.toISOString()).toBe(`${DAY}T09:00:00.000Z`);
    expect(sessions[0].endTime.toISOString()).toBe(`${DAY}T10:00:00.000Z`);
  });

  it("does not let a cancelled row bridge two runs", () => {
    // The cancelled middle atom would make 09:00–10:30 look contiguous.
    const sessions = groupSlotsIntoSessions([
      slot("s1", `${DAY}T09:00:00.000Z`, `${DAY}T09:30:00.000Z`),
      slot("s2", `${DAY}T09:30:00.000Z`, `${DAY}T10:00:00.000Z`, {
        completionStatus: "CANCELLED",
      }),
      slot("s3", `${DAY}T10:00:00.000Z`, `${DAY}T10:30:00.000Z`),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("sorts sessions chronologically whatever order the rows arrive in", () => {
    const sessions = groupSlotsIntoSessions([
      slot("late", `${DAY}T16:00:00.000Z`, `${DAY}T16:30:00.000Z`),
      slot("early", `${DAY}T09:00:00.000Z`, `${DAY}T09:30:00.000Z`),
    ]);

    expect(sessions.map((s) => s.id)).toEqual(["early", "late"]);
  });

  it("marks a finished run completed and a future one upcoming", () => {
    const past = new Date(Date.now() - 3 * 3_600_000);
    const future = new Date(Date.now() + 3 * 3_600_000);
    const halfHour = 30 * 60_000;
    const sessions = groupSlotsIntoSessions([
      slot(
        "past",
        past.toISOString(),
        new Date(past.getTime() + halfHour).toISOString(),
      ),
      slot(
        "future",
        future.toISOString(),
        new Date(future.getTime() + halfHour).toISOString(),
      ),
    ]);

    expect(sessions.map((s) => s.status)).toEqual(["completed", "upcoming"]);
  });
});
