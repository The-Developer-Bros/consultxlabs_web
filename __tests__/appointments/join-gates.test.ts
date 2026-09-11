/**
 * @jest-environment node
 */

/**
 * #1270 — the join window was well covered (see session-join.test.ts) but the
 * two gates AROUND it were not, and both leaked.
 *
 * The consultant surfaces asked only "is a slot inside its window?", never "is
 * this booking confirmed?", so a consultant could open the video room for a
 * booking still at APPROVED_PENDING_PAYMENT — nobody has paid — or one already
 * COMPLETED, whose recording is sealed. The consultee adapter had required a
 * confirmed status since it was written; the two sides simply disagreed.
 *
 * `SessionTimeline` had the mirror-image hole. Its joinable branch compared the
 * clock against `startsAt`/`endsAt` and never looked at `meetingEndedAt`, so a
 * call the host had already closed kept offering JOIN for the remainder of the
 * booked hour.
 *
 * The predicates are pure, so they are tested directly. The wiring that carries
 * them into the surfaces is asserted against the sources, which is the same
 * shape the repo already uses for UI contracts it cannot render.
 */

import fs from "fs";
import path from "path";

import {
  CONSULTANT_JOIN_WINDOW_MS,
  CONSULTEE_JOIN_WINDOW_MS,
  getJoinableSlot,
  getSessionVMJoinState,
  type SessionSlotLike,
} from "@/lib/appointments/slots";
import { isConfirmedStatus } from "@/lib/appointments/status";
import type { SessionVM } from "@/lib/appointments/view-model";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8");

/** All fixtures live on one day so the clock reads like a real timeline. */
const at = (hhmm: string) => new Date(`2026-08-01T${hhmm}:00.000Z`);

/** A 10:00–11:00 consultation as the booking engine actually stores it. */
const oneHour = (): SessionSlotLike[] => [
  {
    id: "A",
    appointmentId: "appt-1",
    startsAt: at("10:00"),
    endsAt: at("10:30"),
    isTentative: false,
    completionStatus: "SCHEDULED",
  },
  {
    id: "B",
    appointmentId: "appt-1",
    startsAt: at("10:30"),
    endsAt: at("11:00"),
    isTentative: false,
    completionStatus: "SCHEDULED",
  },
];

/** The whole gate, as every join surface now composes it. */
const consultantMayJoin = (status: string, now: Date) =>
  isConfirmedStatus(status) &&
  getJoinableSlot(oneHour(), {
    joinWindowMs: CONSULTANT_JOIN_WINDOW_MS,
    now,
  }) !== null;

function session(extra: Partial<SessionVM> = {}): SessionVM {
  return {
    slotId: "A",
    appointmentId: "appt-1",
    startsAt: at("10:00"),
    endsAt: at("11:00"),
    isTentative: false,
    completionStatus: "SCHEDULED",
    meetingEndedAt: null,
    meetingEndedReason: null,
    ...extra,
  };
}

describe("#1270 — a consultant needs a CONFIRMED booking, not just an open window", () => {
  // Mid-session, so the window is unambiguously open for every case below and
  // the status is the only thing deciding the answer.
  const live = at("10:20");

  it("lets a scheduled or in-progress booking through", () => {
    expect(consultantMayJoin("SCHEDULED", live)).toBe(true);
    expect(consultantMayJoin("IN_PROGRESS", live)).toBe(true);
    // Approved is confirmed for join purposes: the money is in and the
    // consultee holds the time.
    expect(consultantMayJoin("APPROVED", live)).toBe(true);
  });

  it("refuses a booking still awaiting payment", () => {
    // The exact leak: the slot is allocated and the clock says "now", but the
    // consultee has not paid, so there is nothing to deliver yet.
    expect(consultantMayJoin("APPROVED_PENDING_PAYMENT", live)).toBe(false);
    // The trial spelling of the same state.
    expect(consultantMayJoin("AWAITING_PAYMENT", live)).toBe(false);
  });

  it("refuses a terminal booking whose slot time has not passed", () => {
    // COMPLETED with a live window happens after an early wrap-up: the session
    // was closed out but its half-hour rows still run to 11:00.
    expect(consultantMayJoin("COMPLETED", live)).toBe(false);
    expect(consultantMayJoin("CANCELLED", live)).toBe(false);
    expect(consultantMayJoin("REJECTED", live)).toBe(false);
    expect(consultantMayJoin("EXPIRED", live)).toBe(false);
    // A converted trial: terminal-positive, so equally not joinable.
    expect(consultantMayJoin("CONVERTED", live)).toBe(false);
  });

  it("still refuses a confirmed booking outside its window", () => {
    // The status check ADDS to the window check; it does not replace it.
    expect(consultantMayJoin("SCHEDULED", at("09:00"))).toBe(false);
    expect(consultantMayJoin("SCHEDULED", at("11:30"))).toBe(false);
  });

  it("opens the host window 15 minutes out and the learner's at 10", () => {
    // 09:47 is inside the consultant's window and outside the consultee's —
    // the one place the two constants are allowed to disagree.
    expect(consultantMayJoin("SCHEDULED", at("09:47"))).toBe(true);
    expect(
      getJoinableSlot(oneHour(), {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("09:47"),
      }),
    ).toBeNull();
  });
});

describe("#1270 — a SessionVM row knows when its session has ended", () => {
  it("is joinable mid-session while the call is still open", () => {
    expect(
      getSessionVMJoinState(session(), {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("10:20"),
      }),
    ).toBe("joinable");
  });

  it("is ended for the rest of the hour once the host closes the call", () => {
    // The timeline bug: `now` is inside [startsAt, endsAt] at every one of
    // these instants, so the clock alone says "joinable" and JOIN stayed lit.
    const ended = session({ meetingEndedAt: at("10:10") });

    for (const now of ["10:11", "10:25", "10:45", "10:59"]) {
      expect(
        getSessionVMJoinState(ended, {
          joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          now: at(now),
        }),
      ).toBe("ended");
    }
  });

  it("counts down before the window opens and ends after the session", () => {
    expect(
      getSessionVMJoinState(session(), {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("09:00"),
      }),
    ).toBe("countdown");
    expect(
      getSessionVMJoinState(session(), {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("11:30"),
      }),
    ).toBe("ended");
  });

  it("disables a tentative or dead row rather than calling it joinable", () => {
    for (const extra of [
      { isTentative: true },
      { completionStatus: "CANCELLED" },
      { completionStatus: "RESCHEDULED" },
    ]) {
      expect(
        getSessionVMJoinState(session(extra), {
          joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
          now: at("10:20"),
        }),
      ).toBe("disabled");
    }
  });

  it("falls back to a one-hour session when the row carries no end", () => {
    const open = session({ endsAt: null });

    expect(
      getSessionVMJoinState(open, {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("10:45"),
      }),
    ).toBe("joinable");
    expect(
      getSessionVMJoinState(open, {
        joinWindowMs: CONSULTEE_JOIN_WINDOW_MS,
        now: at("11:01"),
      }),
    ).toBe("ended");
  });
});

describe("#1270 — the surfaces are wired to those predicates", () => {
  const consultantAdapter = read(
    "app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter.tsx",
  );
  const consultantHome = read(
    "app/dashboard/consultant/[consultantId]/(features)/home/HomeTab.tsx",
  );
  const timeline = read("components/appointments/SessionTimeline.tsx");

  it("gates the consultant adapter's Join on a confirmed status", () => {
    // The bucket test this replaced only excluded the terminal-NEGATIVE
    // states, so it let a pending-payment or completed booking through.
    expect(consultantAdapter).toMatch(
      /canJoinNow[\s\S]*?isConfirmedStatus\(vm\.status\)/,
    );
    expect(consultantAdapter).toMatch(/if \(canJoinNow\(vm\)\) \{/);
  });

  it("gates the consultant home row on the same status", () => {
    expect(consultantHome).toContain("isConfirmedStatus(");
    expect(consultantHome).toContain("getAppointmentLifecycleStatus(");
  });

  it("keeps every dev backdoor on one flag and additive to the gate", () => {
    for (const src of [consultantAdapter, consultantHome]) {
      expect(src).toContain(
        'process.env.NEXT_PUBLIC_ENABLE_DEV_TOOLS === "true"',
      );
      expect(src).not.toContain('process.env.NODE_ENV !== "production"');
    }
    // The dev arm renders where the real Join does not; it never re-labels or
    // un-disables the real one.
    expect(consultantHome).toContain("isDev && !isJoinable");
    expect(consultantHome).not.toContain("isDev ? false : !isJoinable");
    expect(consultantAdapter).toContain(
      "isDev && hasSlotRows(vm) && !canJoinNow(vm)",
    );
  });

  it("routes the timeline's row status through the shared join state", () => {
    expect(timeline).toContain("getSessionVMJoinState(");
    // The hand-rolled comparison that could not see an ended call.
    expect(timeline).not.toContain("now >= start - joinWindowMs");
  });

  it("never renders the word JOIN as inert text", () => {
    // The button owns that word. The status label is a state, and it is muted
    // like every other non-actionable one.
    expect(timeline).not.toContain('joinable: "JOIN"');
    expect(timeline).toContain('joinable: "IN PROGRESS"');
  });
});

describe("#1270 — there is one join window per role, imported everywhere", () => {
  const surfaces = [
    "app/dashboard/consultee/[consulteeId]/(features)/home/HomeTab.tsx",
    "app/dashboard/consultant/[consultantId]/(features)/trials/TrialsTab.tsx",
    "components/planner/components/EventManagementDashboard.tsx",
    "components/appointments/SessionTimeline.tsx",
    "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
    "app/dashboard/consultant/[consultantId]/(features)/appointments/ConsultantAppointmentsAdapter.tsx",
    "lib/data/org-member-program.ts",
    "lib/data/org-member-arrangement.ts",
  ];

  it("declares the window nowhere but lib/appointments/slots.ts", () => {
    for (const rel of surfaces) {
      const src = read(rel);
      expect(src).toMatch(/(CONSULTEE|CONSULTANT)_JOIN_WINDOW_MS/);
      // Every local re-declaration this replaced was one of these literals.
      expect(src).not.toMatch(/=\s*1[05]\s*\*\s*60\s*\*\s*1000/);
    }
  });

  it("gives hosts 15 minutes and learners 10", () => {
    expect(CONSULTANT_JOIN_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(CONSULTEE_JOIN_WINDOW_MS).toBe(10 * 60 * 1000);
    // The planner is a host surface and used to hold its own 10-minute copy.
    expect(
      read("components/planner/components/EventManagementDashboard.tsx"),
    ).toContain("CONSULTANT_JOIN_WINDOW_MS");
  });
});

describe("#1270 — the consultee adapter joins through the shared hook", () => {
  const adapter = read(
    "components/appointments/consultee/ConsulteeAppointmentsAdapter.tsx",
  );
  const eventActions = read(
    "components/appointments/consultee/useEventActions.ts",
  );

  it("awaits the video client instead of reading it synchronously", () => {
    expect(adapter).toContain("useLazyJoinMeeting");
    expect(adapter).not.toContain("getGlobalVideoClient");
    // The destructive, and untrue, toast that condition used to produce.
    expect(adapter).not.toContain('title: "Not signed in"');
  });

  it("clears the row's busy state on the success path too", () => {
    // `joiningId` used to be reset only in `catch`, so a successful join left
    // the row spinning until the route changed.
    expect(adapter).toContain("if (!navigating) setJoiningId(null)");
  });

  it("drops the dead consultee join handler and its static SDK import", () => {
    // Zero callers, and the `@/lib/meeting` import it needed dragged the
    // Stream video SDK into every bundle that touched this hook (#248).
    expect(eventActions).not.toContain("handleJoinSession");
    expect(eventActions).not.toContain('from "@/lib/meeting"');
    expect(eventActions).not.toContain("getOrCreateAppointmentMeeting");
  });
});
