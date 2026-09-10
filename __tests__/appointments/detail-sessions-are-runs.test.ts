/**
 * @jest-environment node
 */

/**
 * #1061 display half — the appointments list rendered a 4-hour consultation
 * (12:30–16:30 IST, eight rows) as "2:00 PM – 2:30 PM", while the Manage
 * Timings grid drew the same booking correctly as one continuous run. The two
 * surfaces disagreed and the list was the wrong one.
 *
 * All THREE appointment mappers carried their own `sessionsOf`, each mapping
 * one SessionVM per stored `SlotOfAppointment` row, so a four-hour booking
 * became eight half-hour "sessions" and every consumer downstream — the row's
 * time range, the session count, the timeline, the anchor — inherited that.
 * They now share `sessionsOfAppointment`, which emits one view-model per
 * contiguous run via the same `groupSlotsIntoRuns` the room key and the join
 * gate use.
 *
 * The detail mapper is exercised in depth because it is the one with siblings
 * and group progress; the two list mappers get the reported case, because the
 * list is the surface the defect was seen on.
 */

import { mapAppointmentDetail } from "@/lib/appointments/map-detail";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import { mapConsultantAppointments } from "@/lib/appointments/map-consultant";
import type { TAppointmentDetail } from "@/lib/data/appointment-detail";

const NOW = new Date("2026-08-01T06:00:00.000Z");

interface SlotRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  user: Array<{ id: string }>;
  meetingSession: {
    id: string;
    endedAt: Date | null;
    endedReason: string | null;
    recordings: never[];
  } | null;
}

/** 30-minute rows, the only unit the allocator stores. */
function row(
  id: string,
  startsAt: string,
  extra: Record<string, unknown> = {},
): SlotRow {
  const start = new Date(startsAt);
  return {
    id,
    startsAt: start,
    endsAt: new Date(start.getTime() + 30 * 60_000),
    isTentative: false,
    completionStatus: "SCHEDULED",
    user: [],
    meetingSession: null,
    ...extra,
  };
}

/** N back-to-back rows from `startsAt` — how one booking is actually stored. */
function run(
  prefix: string,
  startsAt: string,
  count: number,
  extra: Record<string, unknown> = {},
): SlotRow[] {
  const start = new Date(startsAt);
  return Array.from({ length: count }, (_, i) =>
    row(
      `${prefix}-${i}`,
      new Date(start.getTime() + i * 30 * 60_000).toISOString(),
      extra,
    ),
  );
}

const consultationFacts = {
  consultation: {
    status: "SCHEDULED",
    requestedBy: { user: { name: "Priya" } },
    consultationPlan: {
      title: "Career strategy deep dive",
      consultantProfile: { id: "cp-1", user: { name: "Arjun" } },
    },
  },
};

function detail(
  appointment: Record<string, unknown>,
  siblings: Array<Record<string, unknown>> = [],
): TAppointmentDetail {
  const base = {
    appointmentType: "CONSULTATION",
    organizationId: null,
    trialSession: null,
    ...consultationFacts,
  };
  return {
    appointment: { ...base, ...appointment },
    siblings: siblings.map((s) => ({ ...base, ...s })),
  } as unknown as TAppointmentDetail;
}

const map = (d: TAppointmentDetail) =>
  mapAppointmentDetail(d, "consultee", NOW).vm;

/** What the list row actually renders from. */
const span = (s: { startsAt: Date; endsAt: Date | null }) => [
  s.startsAt.toISOString(),
  s.endsAt?.toISOString() ?? null,
];

describe("a booking is one session, however many rows it is stored as", () => {
  it("collapses a four-hour consultation's eight rows into one session", () => {
    // The reported case: 12:30–16:30 IST is 07:00–11:00 UTC.
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: run("s", "2026-08-01T07:00:00.000Z", 8),
      }),
    );

    expect(vm.sessions).toHaveLength(1);
    expect(span(vm.sessions[0])).toEqual([
      "2026-08-01T07:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
    // Keyed to the run's FIRST row — the same anchor the video room uses.
    expect(vm.sessions[0].slotId).toBe("s-0");
  });

  it("collapses the ordinary one-hour consultation too", () => {
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: run("s", "2026-08-01T07:00:00.000Z", 2),
      }),
    );

    expect(vm.sessions).toHaveLength(1);
    expect(span(vm.sessions[0])).toEqual([
      "2026-08-01T07:00:00.000Z",
      "2026-08-01T08:00:00.000Z",
    ]);
  });

  it("leaves a single-row half-hour booking exactly as it was", () => {
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: run("s", "2026-08-01T07:00:00.000Z", 1),
      }),
    );

    expect(vm.sessions).toHaveLength(1);
    expect(span(vm.sessions[0])).toEqual([
      "2026-08-01T07:00:00.000Z",
      "2026-08-01T07:30:00.000Z",
    ]);
  });

  it("keeps two sittings on one appointment as two sessions", () => {
    // A gap must still split: this is the case appointment-keying alone would
    // wrongly merge into one room.
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: [
          ...run("morning", "2026-08-01T07:00:00.000Z", 2),
          ...run("evening", "2026-08-01T13:00:00.000Z", 2),
        ],
      }),
    );

    expect(vm.sessions).toHaveLength(2);
    expect(vm.sessions.map((s) => s.slotId)).toEqual([
      "morning-0",
      "evening-0",
    ]);
  });

  it("counts a four-session subscription as four, not eight", () => {
    // One appointment per session, each an hour: grouping has to happen per
    // appointment BEFORE the siblings are flattened, or two sessions on
    // different days would merge.
    const appointments = [0, 1, 2, 3].map((week) => ({
      id: `appt-${week}`,
      appointmentType: "SUBSCRIPTION",
      slotsOfAppointment: run(
        `w${week}`,
        new Date(
          new Date("2026-08-03T07:00:00.000Z").getTime() +
            week * 7 * 24 * 3_600_000,
        ).toISOString(),
        2,
      ),
    }));

    const vm = map(detail(appointments[0], appointments.slice(1)));

    expect(vm.sessions).toHaveLength(4);
    expect(vm.sessions.map((s) => s.slotId)).toEqual([
      "w0-0",
      "w1-0",
      "w2-0",
      "w3-0",
    ]);
    // Each still names its own appointment, which is what the timeline and
    // the per-session actions key off.
    expect(vm.sessions.map((s) => s.appointmentId)).toEqual([
      "appt-0",
      "appt-1",
      "appt-2",
      "appt-3",
    ]);
  });

  it("splits where a placeholder row meets a confirmed one", () => {
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: [
          ...run("confirmed", "2026-08-01T07:00:00.000Z", 2),
          ...run("tentative", "2026-08-01T08:00:00.000Z", 2, {
            isTentative: true,
          }),
        ],
      }),
    );

    expect(vm.sessions).toHaveLength(2);
    expect(vm.sessions.map((s) => s.isTentative)).toEqual([false, true]);
  });
});

describe("what a run carries from its rows", () => {
  it("reads the host-ended call off the anchor, where it hangs", () => {
    // #1061 writes MeetingSession against the anchor row, so no other row can
    // report that the host closed the call.
    const rows = run("s", "2026-08-01T07:00:00.000Z", 4);
    rows[0].meetingSession = {
      id: "ms-1",
      endedAt: new Date("2026-08-01T07:40:00.000Z"),
      endedReason: null,
      recordings: [],
    };

    const vm = map(detail({ id: "appt-1", slotsOfAppointment: rows }));

    expect(vm.sessions).toHaveLength(1);
    expect(vm.sessions[0].meetingEndedAt).toEqual(
      new Date("2026-08-01T07:40:00.000Z"),
    );
  });

  it("still shows a cancelled session instead of dropping it", () => {
    // `groupSlotsIntoRuns` drops dead rows, which is right for joining and
    // wrong for a timeline that has to say the session was cancelled.
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: [
          ...run("live", "2026-08-01T07:00:00.000Z", 2),
          ...run("gone", "2026-08-01T13:00:00.000Z", 2, {
            completionStatus: "CANCELLED",
          }),
        ],
      }),
    );

    expect(vm.sessions).toHaveLength(2);
    expect(vm.sessions.map((s) => s.completionStatus)).toEqual([
      "SCHEDULED",
      "CANCELLED",
    ]);
  });

  it("does not let a cancelled row bridge two live runs", () => {
    // Without bucketing by deadness first, dropping the middle row would make
    // 07:00–07:30 and 08:00–08:30 look contiguous and merge them.
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: [
          row("a", "2026-08-01T07:00:00.000Z"),
          row("b", "2026-08-01T07:30:00.000Z", {
            completionStatus: "CANCELLED",
          }),
          row("c", "2026-08-01T08:00:00.000Z"),
        ],
      }),
    );

    const live = vm.sessions.filter((s) => s.completionStatus !== "CANCELLED");
    expect(live).toHaveLength(2);
    expect(live.map((s) => s.slotId)).toEqual(["a", "c"]);
  });
});

describe("consumers that read the sessions array", () => {
  it("anchors on the run's start, not the last row of it", () => {
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: run("s", "2026-08-01T07:00:00.000Z", 8),
      }),
    );

    expect(vm.nextAt).toEqual(new Date("2026-08-01T07:00:00.000Z"));
    expect(vm.bucket).toBe("upcoming");
  });

  it("keeps a long booking upcoming until the WHOLE run is over", () => {
    // Per row, the booking fell to "past" the moment its first half hour
    // ended. `now` here is 08:00, one hour into a four-hour session.
    const vm = mapAppointmentDetail(
      detail({
        id: "appt-1",
        slotsOfAppointment: run("s", "2026-08-01T07:00:00.000Z", 8),
      }),
      "consultee",
      new Date("2026-08-01T08:00:00.000Z"),
    ).vm;

    expect(vm.bucket).toBe("upcoming");
  });

  it("counts subscription progress in appointments, not rows", () => {
    // `group.total`/`completed` are per-appointment and must be unmoved by
    // the regrouping: two 1-hour sessions, the first already over.
    const past = {
      id: "appt-0",
      appointmentType: "SUBSCRIPTION",
      slotsOfAppointment: run("w0", "2026-07-25T07:00:00.000Z", 2),
    };
    const upcoming = {
      id: "appt-1",
      appointmentType: "SUBSCRIPTION",
      slotsOfAppointment: run("w1", "2026-08-05T07:00:00.000Z", 2),
    };

    const vm = map(detail(past, [upcoming]));

    expect(vm.group).toEqual({ total: 2, completed: 1 });
    expect(vm.sessions).toHaveLength(2);
  });

  it("leaves the raw slot rows alone for the action hooks", () => {
    // Cancel/reschedule/timings still operate on rows; only the DISPLAY layer
    // moved to runs.
    const vm = map(
      detail({
        id: "appt-1",
        slotsOfAppointment: run("s", "2026-08-01T07:00:00.000Z", 8),
      }),
    );

    expect(vm.raw.rawSlots).toHaveLength(8);
  });
});

describe("the two list mappers agree with the detail page", () => {
  /** The eight rows of the reported 12:30–16:30 booking. */
  const eightRows = () => run("s", "2026-08-01T07:00:00.000Z", 8);

  it("shows the consultee one four-hour session, not eight half-hour ones", () => {
    const [vm] = mapConsulteeEvents(
      {
        consultations: [
          {
            id: "c-1",
            status: "SCHEDULED",
            consultationPlan: {
              title: "Career strategy deep dive",
              consultantProfile: { id: "cp-1", user: { name: "Arjun" } },
            },
            appointment: { id: "appt-1", slotsOfAppointment: eightRows() },
          },
        ],
      } as never,
      NOW,
    );

    expect(vm.sessions).toHaveLength(1);
    expect(span(vm.sessions[0])).toEqual([
      "2026-08-01T07:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
    // The list row renders its end time by matching nextAt back to a session,
    // so the anchor lookup has to keep resolving after the regrouping.
    expect(
      vm.sessions.find((session) => session.startsAt === vm.nextAt)?.endsAt,
    ).toEqual(new Date("2026-08-01T11:00:00.000Z"));
  });

  it("shows the consultant the same one session", () => {
    const [vm] = mapConsultantAppointments(
      {
        consultantId: "cp-1",
        appointments: [
          {
            id: "appt-1",
            appointmentType: "CONSULTATION",
            organizationId: null,
            slotsOfAppointment: eightRows(),
            consultation: {
              status: "SCHEDULED",
              consultationPlan: { title: "Career strategy deep dive" },
              requestedBy: { user: { name: "Priya" } },
            },
          },
        ],
      } as never,
      NOW,
    );

    expect(vm.sessions).toHaveLength(1);
    expect(span(vm.sessions[0])).toEqual([
      "2026-08-01T07:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
  });
});
