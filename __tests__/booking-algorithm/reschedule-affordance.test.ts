/**
 * The Reschedule menu item's slot-derived gate.
 *
 * Both sides now share one predicate because they drifted: the consultee's had
 * the zero-slot and in-flight checks, the consultant's had neither, so a
 * consultant could open a picker for a booking with nothing to move or one
 * already awaiting a new time — reaching a 409 or PROPOSAL_WINDOW_CLOSED that
 * the menu should never have offered.
 */

import { slotsAllowReschedule } from "@/lib/appointments/slots";

describe("slotsAllowReschedule", () => {
  it("allows a booking with confirmed sessions", () => {
    expect(
      slotsAllowReschedule([
        { isTentative: false, completionStatus: "SCHEDULED" },
        { isTentative: false, completionStatus: "SCHEDULED" },
      ]),
    ).toBe(true);
  });

  it("refuses an approved booking with nothing allocated", () => {
    // "Not scheduled · 0/0" — the proposal window is derived from the earliest
    // released session, so there is nothing to derive it from.
    expect(slotsAllowReschedule([])).toBe(false);
  });

  it("refuses a request still awaiting its first allocation", () => {
    expect(
      slotsAllowReschedule([{ isTentative: true, completionStatus: null }]),
    ).toBe(false);
  });

  it("refuses while a reschedule is already in flight", () => {
    // openForAppointmentId is a nullable-unique, so a second live request is
    // impossible — offering the action again only earns a 409.
    expect(
      slotsAllowReschedule([
        { isTentative: false, completionStatus: "SCHEDULED" },
        { isTentative: true, completionStatus: "RESCHEDULED" },
      ]),
    ).toBe(false);
  });

  it("stays permissive about sessions that merely finished", () => {
    // COMPLETED is not RESCHEDULED: a subscription with past sessions and
    // future ones is still movable.
    expect(
      slotsAllowReschedule([
        { isTentative: false, completionStatus: "COMPLETED" },
        { isTentative: false, completionStatus: "SCHEDULED" },
      ]),
    ).toBe(true);
  });
});
