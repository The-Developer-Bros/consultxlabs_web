// #1073 — the two reads widened to carry sessions to the slot picker, pinned
// to the five scheduling fields they are allowed to carry.
//
// `readAppointmentDetail`'s slots come from an `include`, so each row also
// holds the attendee list (`user[]`: id, name, image) and the session's
// recording URLs. On a class or webinar every enrolled user is connected to
// every slot, so spreading a term of sessions into an RSC payload ships the
// whole roster several hundred times over. Same shape as the consultant-PII
// leak #946 fixed with a select-allowlist.

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
  },
}));

jest.mock("../../lib/data/appointment-detail", () => ({
  readAppointmentDetail: jest.fn(),
}));

jest.mock("../../lib/booking/plan-owners", () => ({
  resolvePlanOwnerIds: jest.fn(() => ["consultant-1"]),
}));

import prisma from "../../lib/prisma";
import { readAppointmentDetail } from "../../lib/data/appointment-detail";
import { readAllocationRequest } from "../../lib/data/allocation-request";
import { readManageTimingsTarget } from "../../lib/data/manage-timings-target";

const ALLOWED_SLOT_KEYS = [
  "appointmentId",
  "completionStatus",
  "deletedAt",
  "endsAt",
  "id",
  "isTentative",
  "startsAt",
];

const ATTENDEE_NAME = "Priya Attendee";
const RECORDING_URL = "https://recordings.example/private/session-1.mp4";

/** A slot exactly as `readAppointmentDetail` hands it over: relations and all. */
function pollutedSlot(id: string, startsAt: string) {
  return {
    id,
    appointmentId: `appt-${id}`,
    startsAt: new Date(startsAt),
    endsAt: new Date(new Date(startsAt).getTime() + 60 * 60 * 1000),
    isTentative: false,
    completionStatus: "SCHEDULED",
    completedAt: null,
    consultantProfileId: "consultant-1",
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    user: [
      { id: "user-1", name: ATTENDEE_NAME, image: "https://img.example/p.png" },
    ],
    meetingSession: {
      id: "session-1",
      endedAt: null,
      recordings: [
        {
          id: "rec-1",
          recordingUrl: RECORDING_URL,
          storageUrl: "https://supabase.example/rec-1",
          thumbnailUrl: "https://img.example/thumb.png",
        },
      ],
    },
  };
}

const mockReadAppointmentDetail = readAppointmentDetail as jest.MockedFunction<
  typeof readAppointmentDetail
>;

describe("readManageTimingsTarget slot payload", () => {
  beforeEach(() => {
    mockReadAppointmentDetail.mockResolvedValue({
      appointment: {
        id: "appt-1",
        appointmentType: "CLASS",
        class: {
          id: "class-1",
          schedulingPeriodStartsAt: new Date("2026-08-01T00:00:00Z"),
          schedulingPeriodEndsAt: new Date("2026-11-01T00:00:00Z"),
          classPlan: { title: "Pottery", totalSessions: 24 },
        },
        slotsOfAppointment: [pollutedSlot("s1", "2026-08-03T05:00:00Z")],
      },
      siblings: [
        {
          id: "appt-2",
          slotsOfAppointment: [pollutedSlot("s2", "2026-08-10T05:00:00Z")],
        },
      ],
      // The read only ever touches the fields above; the real payload is far
      // wider and irrelevant to what this asserts.
    } as unknown as Awaited<ReturnType<typeof readAppointmentDetail>>);
  });

  it("carries the whole program's sessions through to the picker", async () => {
    const target = await readManageTimingsTarget("appt-1");

    expect(target?.appointment.slots?.map((slot) => slot.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("ships the five scheduling fields and nothing else", async () => {
    const target = await readManageTimingsTarget("appt-1");

    for (const slot of target?.appointment.slots ?? []) {
      expect(Object.keys(slot).sort()).toEqual(ALLOWED_SLOT_KEYS);
    }
  });

  it("leaks neither attendee PII nor recording URLs into the payload", async () => {
    const target = await readManageTimingsTarget("appt-1");

    // Whole-payload, not per-field: the point is that nothing anywhere in
    // what crosses the RSC boundary carries this.
    const serialized = JSON.stringify(target);
    expect(serialized).not.toContain(ATTENDEE_NAME);
    expect(serialized).not.toContain(RECORDING_URL);
    expect(serialized).not.toContain("thumbnailUrl");
  });
});

describe("readAllocationRequest slot payload", () => {
  const findUnique = prisma.consultation.findUnique as jest.Mock;

  beforeEach(() => {
    findUnique.mockResolvedValue({
      id: "consultation-1",
      status: "PENDING",
      requestedBy: { userId: "user-1", user: { name: "Buyer" } },
      consultationPlan: {
        title: "Intro call",
        consultantProfileId: "consultant-1",
        durationInHours: 1,
      },
      appointment: {
        slotsOfAppointment: [
          {
            id: "s1",
            appointmentId: "appt-1",
            startsAt: new Date("2026-08-03T05:00:00Z"),
            endsAt: new Date("2026-08-03T06:00:00Z"),
            isTentative: true,
            completionStatus: "SCHEDULED",
            deletedAt: null,
          },
        ],
      },
    });
  });

  it("carries the request's requested times", async () => {
    const request = await readAllocationRequest("consultation-1", "consultation");

    expect(request?.slots).toHaveLength(1);
    expect(Object.keys(request!.slots[0]).sort()).toEqual(ALLOWED_SLOT_KEYS);
  });

  it("asks the database for those fields only, never the relations", async () => {
    await readAllocationRequest("consultation-1", "consultation");

    const { select } = findUnique.mock.calls[0][0];
    const slotArgs = select.appointment.select.slotsOfAppointment;

    expect(Object.keys(slotArgs.select).sort()).toEqual(ALLOWED_SLOT_KEYS);
    expect(slotArgs.include).toBeUndefined();
  });
});
