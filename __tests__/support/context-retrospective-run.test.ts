/**
 * @jest-environment node
 */

/**
 * #appt-support — the retrospective subject has to be FINDABLE.
 *
 * `buildSupportContext` picked the thread's subject session out of the
 * appointment's slot rows, but selected them with `completionStatus:
 * "SCHEDULED"`. A session that has happened is COMPLETED or UNVERIFIED (there
 * is no NO_SHOW slot status), so the only rows a retrospective intent could
 * ever be about were filtered out before `groupSlotsIntoRuns` saw them:
 * `lastEndedRun` was always null, NO_SHOW / RECORDING_ACCESS / TECHNICAL /
 * QUALITY_COMPLAINT fell back to the upcoming session, and on a booking with
 * nothing upcoming `endsAt` was null — which is the clock the server's 48-hour
 * recording-window override reads, so it silently could not run.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    recording: { findFirst: jest.fn() },
    membership: { findFirst: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { buildSupportContext } from "@/lib/support/context";

const mockPrisma = prisma as unknown as {
  appointment: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  recording: { findFirst: jest.Mock };
  membership: { findFirst: jest.Mock };
};

interface SlotRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  completionStatus: string;
  deletedAt?: Date | null;
}

/**
 * The nested `where` is the thing under test, so the mock APPLIES it rather
 * than handing every row back regardless. Without this the suite passes on the
 * SCHEDULED-only query too, and pins nothing.
 */
function appointmentRow(slots: SlotRow[]) {
  return (args: {
    select: {
      slotsOfAppointment: {
        where: {
          deletedAt?: null;
          completionStatus?: string | { notIn: string[] };
        };
      };
    };
  }) => {
    const where = args.select.slotsOfAppointment.where;
    const status = where.completionStatus;
    const visible = slots.filter((slot) => {
      if (where.deletedAt === null && slot.deletedAt) return false;
      if (typeof status === "string") return slot.completionStatus === status;
      if (status) return !status.notIn.includes(slot.completionStatus);
      return true;
    });
    return Promise.resolve({
      id: "appt1",
      appointmentType: "CONSULTATION",
      organizationId: null,
      cancellationPolicy: null,
      slotsOfAppointment: visible,
      payment: [],
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
    });
  };
}

/** Two contiguous 30-minute rows — one 60-minute session that already ran. */
const PAST_START = new Date(Date.now() - 3 * 3_600_000);
const PAST_MID = new Date(PAST_START.getTime() + 30 * 60_000);
const PAST_END = new Date(PAST_START.getTime() + 60 * 60_000);

function unverifiedRun(): SlotRow[] {
  return [
    // Called off, and it must not bridge or lengthen the run below.
    {
      id: "slot-x",
      startsAt: new Date(PAST_START.getTime() - 30 * 60_000),
      endsAt: PAST_START,
      isTentative: false,
      completionStatus: "CANCELLED",
    },
    {
      id: "slot-a",
      startsAt: PAST_START,
      endsAt: PAST_MID,
      isTentative: false,
      completionStatus: "UNVERIFIED",
    },
    {
      id: "slot-b",
      startsAt: PAST_MID,
      endsAt: PAST_END,
      isTentative: false,
      completionStatus: "UNVERIFIED",
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.appointment.findUnique.mockImplementation(
    appointmentRow(unverifiedRun()),
  );
  mockPrisma.user.findUnique.mockResolvedValue({ consultantProfileId: null });
  mockPrisma.recording.findFirst.mockResolvedValue(null);
  mockPrisma.membership.findFirst.mockResolvedValue(null);
});

describe("buildSupportContext — retrospective subject on a finished session", () => {
  it("resolves the UNVERIFIED past run as the subject of a NO_SHOW thread", async () => {
    const ctx = await buildSupportContext(
      "thread1",
      "appt1",
      "user1",
      "NO_SHOW",
    );

    expect(ctx?.stage).toBe("COMPLETED");
    // The whole run, not its first row: the window a retrospective answer
    // quotes has to be the session's, not half an hour of it (#1061).
    expect(ctx?.startsAt?.toISOString()).toBe(PAST_START.toISOString());
    expect(ctx?.endsAt?.toISOString()).toBe(PAST_END.toISOString());
  });

  it("still gives RECORDING_ACCESS an `endsAt` when nothing is upcoming", async () => {
    // This is the value the 48-hour window override measures against. Null
    // meant the server accepted whatever the client claimed about elapsed time.
    const ctx = await buildSupportContext(
      "thread1",
      "appt1",
      "user1",
      "RECORDING_ACCESS",
    );

    expect(ctx?.endsAt).not.toBeNull();
    expect(ctx?.endsAt?.toISOString()).toBe(PAST_END.toISOString());
  });

  it("selects live rows by exclusion, not by SCHEDULED equality", async () => {
    await buildSupportContext("thread1", "appt1", "user1", "NO_SHOW");

    const select = mockPrisma.appointment.findUnique.mock.calls[0][0].select;
    expect(select.slotsOfAppointment.where).toEqual({
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
    });
  });

  it("keeps a forward-looking intent on the upcoming session", async () => {
    // The widened query must not hand RESCHEDULE a session that already ran.
    const futureStart = new Date(Date.now() + 2 * 3_600_000);
    const futureEnd = new Date(futureStart.getTime() + 30 * 60_000);
    mockPrisma.appointment.findUnique.mockImplementation(
      appointmentRow([
        ...unverifiedRun(),
        {
          id: "slot-c",
          startsAt: futureStart,
          endsAt: futureEnd,
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ]),
    );

    const ctx = await buildSupportContext(
      "thread1",
      "appt1",
      "user1",
      "RESCHEDULE",
    );

    expect(ctx?.stage).toBe("UPCOMING");
    expect(ctx?.startsAt?.toISOString()).toBe(futureStart.toISOString());
  });

  it("does not bridge the past run and the future one into a single session", async () => {
    // A non-contiguous row must start a new run. If the widened query let the
    // past rows merge with the upcoming one, a no-show thread would quote an
    // `endsAt` in the future and read as UPCOMING.
    const futureStart = new Date(Date.now() + 2 * 3_600_000);
    mockPrisma.appointment.findUnique.mockImplementation(
      appointmentRow([
        ...unverifiedRun(),
        {
          id: "slot-c",
          startsAt: futureStart,
          endsAt: new Date(futureStart.getTime() + 30 * 60_000),
          isTentative: false,
          completionStatus: "SCHEDULED",
        },
      ]),
    );

    const ctx = await buildSupportContext(
      "thread1",
      "appt1",
      "user1",
      "NO_SHOW",
    );

    expect(ctx?.stage).toBe("COMPLETED");
    expect(ctx?.endsAt?.toISOString()).toBe(PAST_END.toISOString());
  });
});
