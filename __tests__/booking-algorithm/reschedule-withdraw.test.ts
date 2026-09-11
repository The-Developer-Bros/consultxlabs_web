/**
 * Withdrawal semantics.
 *
 * The asymmetry pinned here is deliberate and easy to "simplify" away later:
 * a WITHDRAWAL restores the booking, a DECLINE does not. Both end the same
 * request, but they mean opposite things — the initiator no longer wants the
 * move, versus the other party not agreeing to it. Collapsing them would leave
 * a consultee who was declined silently back where they started with no
 * pending request, and would make the audit trail unable to say who ended it.
 */

import {
  RESCHEDULE_ALLOWED_FROM,
  RESCHEDULE_OPEN_STATUSES,
  RESCHEDULE_TERMINAL_STATUSES,
} from "@/lib/booking/transitions";

describe("WITHDRAWN is a first-class terminal state", () => {
  it("is terminal, so it releases the appointment's reschedule lock", () => {
    // transitionRescheduleRequest clears openForAppointmentId for any terminal
    // status. Miss this and a withdrawn request keeps the nullable-unique held,
    // permanently blocking every later reschedule of that booking.
    expect(RESCHEDULE_TERMINAL_STATUSES).toContain("WITHDRAWN");
  });

  it("is not an open state", () => {
    expect(RESCHEDULE_OPEN_STATUSES).not.toContain("WITHDRAWN");
  });

  it("is reachable only from a request still awaiting an answer", () => {
    expect(RESCHEDULE_ALLOWED_FROM.WITHDRAWN).toEqual([
      "PENDING_REVIEW",
      "COUNTERED",
    ]);
  });

  it("cannot be reached from a request that already resolved", () => {
    // The CAS guard is what stops a withdrawal un-releasing slots that a
    // concurrent accept has already re-confirmed.
    for (const settled of ["ACCEPTED", "AUTO_ACCEPTED", "DECLINED", "EXPIRED"]) {
      expect(RESCHEDULE_ALLOWED_FROM.WITHDRAWN).not.toContain(settled);
    }
  });

  it("stays distinct from DECLINED", () => {
    // Same allowed-from, deliberately different status: they resolve the
    // released slots differently, so they must not be collapsed into one.
    expect(RESCHEDULE_ALLOWED_FROM.DECLINED).toEqual(
      RESCHEDULE_ALLOWED_FROM.WITHDRAWN,
    );
    expect(RESCHEDULE_TERMINAL_STATUSES).toContain("DECLINED");
    expect(RESCHEDULE_TERMINAL_STATUSES).toContain("WITHDRAWN");
  });
});
