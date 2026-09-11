/**
 * The three time-change affordances on the consultant's appointment menu.
 *
 * Manage Timings writes new times straight onto the calendar with no notice
 * requirement and no acceptance from anyone, so it may only be offered where
 * nobody else has committed to a time. Where somebody has, the negotiated
 * Reschedule takes its place — the two are alternatives, and offering both
 * would hand a consultant a way around the proposal (#1082).
 *
 * Unschedule sits outside that pair rather than inside it. It withdraws a
 * placed group event's date and puts it back in the allocate queue with the
 * sale, the enrolment and the money all untouched, so a confirmed webinar
 * offers Timings AND Unschedule, and a 1:1 never offers Unschedule at all.
 */

import {
  allowsManageTimings,
  allowsUnschedule,
  slotsAllowReschedule,
  upcomingSlots,
} from "@/lib/appointments/slots";
import type { AppointmentKind } from "@/lib/appointments/view-model";

type TestSlot = {
  isTentative?: boolean | null;
  completionStatus?: string | null;
};

const confirmed: TestSlot[] = [
  { isTentative: false, completionStatus: "SCHEDULED" },
];
const tentative: TestSlot[] = [{ isTentative: true, completionStatus: null }];
const nothingAllocated: TestSlot[] = [];

/** Mirrors ConsultantAppointmentsAdapter's two guards, minus the status checks. */
function offered(kind: AppointmentKind, slots: TestSlot[]) {
  const timings = allowsManageTimings(kind, slots);
  return { timings, reschedule: !timings && slotsAllowReschedule(slots) };
}

/** All three menu gates together, which is how a consultant actually meets them. */
function menu(kind: AppointmentKind, slots: TestSlot[]) {
  return { ...offered(kind, slots), unschedule: allowsUnschedule(kind, slots) };
}

describe("allowsManageTimings", () => {
  it("keeps Timings on a webinar whose instance is already confirmed", () => {
    // Attendees bought into a published schedule; there is no counterparty to
    // send a proposal to, and thirty of them cannot each accept one.
    expect(offered("WEBINAR", confirmed)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on a class instance", () => {
    expect(offered("CLASS", confirmed)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on an offering that was never scheduled", () => {
    // The `unscheduled-class-…` / `unscheduled-webinar-…` rows: no Appointment
    // row at all, so no slots.
    expect(offered("CLASS", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
    });
    expect(offered("WEBINAR", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on a consultation whose slots are still tentative", () => {
    // Nothing has been placed — the request is awaiting allocation, so the
    // consultee holds no time yet.
    expect(offered("CONSULTATION", tentative)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("keeps Timings on an approved 1:1 with nothing allocated", () => {
    // "Not scheduled · 0/0". Reschedule refuses it for want of a time to move,
    // so Timings has to hold this case or the row would offer neither.
    expect(offered("CONSULTATION", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
    });
  });

  it("replaces Timings with Reschedule on a confirmed consultation", () => {
    expect(offered("CONSULTATION", confirmed)).toEqual({
      timings: false,
      reschedule: true,
    });
  });

  it("replaces Timings with Reschedule on a confirmed subscription session", () => {
    expect(
      offered("SUBSCRIPTION", [
        { isTentative: false, completionStatus: "SCHEDULED" },
        { isTentative: false, completionStatus: "SCHEDULED" },
      ]),
    ).toEqual({ timings: false, reschedule: true });
  });

  it("refuses Timings on a confirmed trial", () => {
    // A trial is 1:1 and the consultant allocates the time, but the slot is
    // created non-tentative and the consultee is notified of it — so it is a
    // commitment by the same test as a consultation. The consultant's menu
    // offers a trial neither action today, because the reschedule API has no
    // TRIAL branch; that gap predates this and is out of scope.
    expect(allowsManageTimings("TRIAL", confirmed)).toBe(false);
    expect(offered("TRIAL", confirmed)).toEqual({
      timings: false,
      reschedule: true,
    });
  });

  it("offers exactly one action in every settled case", () => {
    const cases: Array<[AppointmentKind, TestSlot[]]> = [
      ["WEBINAR", confirmed],
      ["CLASS", confirmed],
      ["CLASS", nothingAllocated],
      ["WEBINAR", nothingAllocated],
      ["CONSULTATION", tentative],
      ["CONSULTATION", nothingAllocated],
      ["CONSULTATION", confirmed],
      ["SUBSCRIPTION", confirmed],
      ["TRIAL", confirmed],
    ];
    for (const [kind, slots] of cases) {
      const { timings, reschedule } = offered(kind, slots);
      expect(timings).not.toBe(reschedule);
    }
  });

  it("offers neither only while a proposal is already live", () => {
    // The one deliberate gap: a released slot awaiting a new time IS the open
    // reschedule, so Reschedule would earn a 409 and Timings would write
    // straight over the proposal the consultee is still answering.
    const inFlight: TestSlot[] = [
      { isTentative: false, completionStatus: "SCHEDULED" },
      { isTentative: true, completionStatus: "RESCHEDULED" },
    ];
    expect(menu("CONSULTATION", inFlight)).toEqual({
      timings: false,
      reschedule: false,
      unschedule: false,
    });
  });

  it("refuses Timings when a LATER session is still committed", () => {
    // The reverse of the case above, and the one that actually bit: a partial
    // reschedule releases one session of a multi-session booking, so the
    // earliest slot is the released one while the consultee still holds a
    // confirmed time afterwards. Reading only slots[0] saw "tentative" and
    // handed back the unilateral surface.
    const releasedFirst: TestSlot[] = [
      { isTentative: true, completionStatus: "RESCHEDULED" },
      { isTentative: false, completionStatus: "SCHEDULED" },
    ];
    expect(menu("SUBSCRIPTION", releasedFirst).timings).toBe(false);
    expect(menu("CONSULTATION", releasedFirst).timings).toBe(false);
  });

  it("still offers Timings when every upcoming session is unallocated", () => {
    const allTentative: TestSlot[] = [
      { isTentative: true, completionStatus: null },
      { isTentative: true, completionStatus: null },
    ];
    expect(menu("SUBSCRIPTION", allTentative).timings).toBe(true);
  });
});

describe("allowsUnschedule", () => {
  it("offers a confirmed webinar Timings AND Unschedule, never Reschedule", () => {
    // The pair's "exactly one" property is about Timings vs Reschedule only.
    // Unschedule is orthogonal: it withdraws the date, Timings sets a new one.
    expect(menu("WEBINAR", confirmed)).toEqual({
      timings: true,
      reschedule: false,
      unschedule: true,
    });
  });

  it("offers a confirmed class Timings AND Unschedule, never Reschedule", () => {
    expect(menu("CLASS", confirmed)).toEqual({
      timings: true,
      reschedule: false,
      unschedule: true,
    });
  });

  it("withholds Unschedule from an offering that was never scheduled", () => {
    // No Appointment row, so no slots and no date to withdraw. Timings is the
    // surface for putting one on the calendar in the first place.
    expect(menu("WEBINAR", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
      unschedule: false,
    });
    expect(menu("CLASS", nothingAllocated)).toEqual({
      timings: true,
      reschedule: false,
      unschedule: false,
    });
  });

  it("withholds Unschedule from an event already unscheduled", () => {
    // The release leaves every slot tentative, so the action is idempotent by
    // construction rather than by a second guard.
    expect(allowsUnschedule("WEBINAR", tentative)).toBe(false);
    expect(allowsUnschedule("CLASS", tentative)).toBe(false);
  });

  it("offers Unschedule while any session of a part-released class is still placed", () => {
    // A class is several session appointments; the route releases all of them,
    // so one still-placed session is enough to have something to withdraw.
    const partlyReleased: TestSlot[] = [
      { isTentative: true, completionStatus: "RESCHEDULED" },
      { isTentative: false, completionStatus: "SCHEDULED" },
    ];
    expect(allowsUnschedule("CLASS", partlyReleased)).toBe(true);
  });

  it("never offers Unschedule for a 1:1, whatever its slots look like", () => {
    // Releasing a time a counterparty holds is the negotiation Reschedule runs.
    const oneToOne: AppointmentKind[] = [
      "CONSULTATION",
      "SUBSCRIPTION",
      "TRIAL",
    ];
    for (const kind of oneToOne) {
      for (const slots of [confirmed, tentative, nothingAllocated]) {
        expect(allowsUnschedule(kind, slots)).toBe(false);
      }
    }
  });

  it("gives a confirmed 1:1 Reschedule and neither other action", () => {
    expect(menu("CONSULTATION", confirmed)).toEqual({
      timings: false,
      reschedule: true,
      unschedule: false,
    });
    expect(menu("SUBSCRIPTION", confirmed)).toEqual({
      timings: false,
      reschedule: true,
      unschedule: false,
    });
  });
});

describe("upcomingSlots", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  const hoursFromNow = (h: number) =>
    new Date(now.getTime() + h * 3_600_000).toISOString();

  it("drops finished sessions and orders the rest", () => {
    const slots = [
      { startsAt: hoursFromNow(48), endsAt: hoursFromNow(49) },
      { startsAt: hoursFromNow(-48), endsAt: hoursFromNow(-47) },
      { startsAt: hoursFromNow(24), endsAt: hoursFromNow(25) },
    ];
    expect(upcomingSlots(slots, now).map((s) => s.startsAt)).toEqual([
      hoursFromNow(24),
      hoursFromNow(48),
    ]);
  });

  it("keeps Timings on a program whose remaining sessions are unallocated", () => {
    // A subscription part-way through: past sessions are confirmed, but the
    // consultee holds no future time. Deciding on the raw list would read the
    // finished session as a commitment and hide the action.
    const slots = [
      {
        startsAt: hoursFromNow(-48),
        endsAt: hoursFromNow(-47),
        isTentative: false,
        completionStatus: "COMPLETED",
      },
      {
        startsAt: hoursFromNow(24),
        endsAt: hoursFromNow(25),
        isTentative: true,
        completionStatus: null,
      },
    ];
    expect(allowsManageTimings("SUBSCRIPTION", upcomingSlots(slots, now))).toBe(
      true,
    );
  });
});
