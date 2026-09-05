/**
 * @jest-environment node
 */

/**
 * #1504 — the consultant no-show refund was structurally unreachable.
 *
 * `auto-complete-appointments` runs at :07 and claims every APPROVED/SCHEDULED
 * consultation whose slots ended more than an hour ago;
 * `detect-consultant-no-shows` runs at :57, reads the same two statuses, and
 * only considers a booking whose slots ended more than two hours ago. The
 * completing job therefore always got there first, the booking was COMPLETED
 * before the detector could look at it, and the promised full refund for a
 * consultant who never joined could not fire in production.
 *
 * These pins hold the partition: an unattended consultation belongs to the
 * detector, an attended one belongs to auto-complete, and no consultation
 * belongs to neither.
 */

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: jest.fn(async () => undefined),
}));

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyAppointmentCompleted: jest.fn(async () => undefined),
  notifyAppointmentCancelled: jest.fn(async () => undefined),
  notifyRefundProcessed: jest.fn(async () => undefined),
}));

jest.mock("../../lib/support/create-ticket", () => ({
  __esModule: true,
  createSupportTicket: jest.fn(async () => ({ id: "ticket-1" })),
}));

// The detector corroborates against Stream before moving money; one distinct
// participant is Stream agreeing that only the consultee was there.
jest.mock("../../lib/stream/call-presence", () => ({
  __esModule: true,
  getCallPresenceEvidence: jest.fn(async () => ({
    unique: 1,
    maxConcurrent: 1,
  })),
}));

// The slot-level pass is not what these pins are about.
jest.mock("../../lib/booking/slot-release", () => ({
  __esModule: true,
  transitionSlotsInChunks: jest.fn(async () => 0),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
}));

// #1493 — the no-show detector's claim now runs through
// transitionConsultationRequest inside prisma.$transaction, which needs
// consultation.findUnique (the helper's pre-read) and bookingStatusHistory
// (the audit row it appends) alongside $transaction itself.
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    webinar: { findMany: jest.fn(), updateMany: jest.fn() },
    class: { findMany: jest.fn(), updateMany: jest.fn() },
    subscription: { findMany: jest.fn(), updateMany: jest.fn() },
    trialSession: { findMany: jest.fn() },
    slotOfAppointment: { findMany: jest.fn(), updateMany: jest.fn() },
    supportTicket: { findFirst: jest.fn() },
    bookingStatusHistory: { create: jest.fn() },
    $disconnect: jest.fn(),
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

import prisma from "../../lib/prisma";
import { autoCompleteAppointments } from "../../scripts/appointments/auto-complete-appointments";
import { detectConsultantNoShows } from "../../scripts/appointments/detect-consultant-no-shows";
import {
  NO_SHOW_GRACE_MINUTES,
  NO_SHOW_HANDOFF_MINUTES,
  classifyConsultantAttendance,
} from "../../lib/booking/attendance";

const CONSULTANT = "user-consultant";
const CONSULTEE = "user-consultee";
const HOURLY_MINUTES = 60;

const db = prisma as unknown as Record<string, Record<string, jest.Mock>> & {
  $disconnect: jest.Mock;
};

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

/** A past, paid consultation; `attendees` is who has a MeetingAttendance row. */
function consultation(endedMinutesAgo: number, attendees: string[]) {
  return {
    id: "cons-1",
    status: "APPROVED",
    consultationPlan: {
      title: "Career strategy",
      consultantProfile: { userId: CONSULTANT, user: { name: "Consultant" } },
    },
    requestedBy: { userId: CONSULTEE, user: { name: "Consultee" } },
    appointment: {
      id: "apt-1",
      organizationId: null,
      payment: [
        {
          id: "pay-1",
          amount: 150000,
          currency: "INR",
          paymentStatus: "SUCCEEDED",
        },
      ],
      slotsOfAppointment: [
        {
          endsAt: minutesAgo(endedMinutesAgo),
          meetingSession: {
            streamCallId: "call-1",
            attendances: attendees.map((userId) => ({ userId })),
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of [
    "consultation",
    "webinar",
    "class",
    "subscription",
    "trialSession",
    "slotOfAppointment",
  ]) {
    db[model].findMany.mockResolvedValue([]);
    db[model].updateMany?.mockResolvedValue({ count: 1 });
  }
  db.supportTicket.findFirst.mockResolvedValue(null);
  db.consultation.findUnique.mockResolvedValue({
    status: "APPROVED",
    appointment: { id: "appt-1" },
  });
  db.bookingStatusHistory.create.mockResolvedValue({});
  refundBookingPayment.mockResolvedValue({
    amountRefundedPaise: 150000,
    rail: "GATEWAY",
  });
});

describe("#1504 the two hourly jobs partition past consultations", () => {
  it("auto-complete leaves an unattended consultation inside the grace window to the detector", async () => {
    db.consultation.findMany.mockResolvedValue([consultation(90, [CONSULTEE])]);

    const result = await autoCompleteAppointments();

    expect(result.consultationsCompleted).toBe(0);
    expect(db.consultation.updateMany).not.toHaveBeenCalled();
  });

  it("the detector then cancels and refunds it once it is past the grace window", async () => {
    db.consultation.findMany.mockResolvedValue([
      consultation(NO_SHOW_GRACE_MINUTES + 30, [CONSULTEE]),
    ]);

    const result = await detectConsultantNoShows();

    expect(result.detected).toBe(1);
    expect(result.refunded).toBe(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    expect(db.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
  });

  it("auto-complete still completes a consultation the consultant attended", async () => {
    db.consultation.findMany.mockResolvedValue([
      consultation(90, [CONSULTEE, CONSULTANT]),
    ]);

    const result = await autoCompleteAppointments();

    expect(result.consultationsCompleted).toBe(1);
    expect(db.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("completes an unattended consultation the detector declined, so none is stranded", async () => {
    // Past the handoff deadline the detector has had its runs: it either
    // cancelled the booking (which removes it from this cohort) or decided not
    // to, and a booking neither job will claim must not exist.
    db.consultation.findMany.mockResolvedValue([
      consultation(NO_SHOW_HANDOFF_MINUTES + 10, [CONSULTEE]),
    ]);

    const result = await autoCompleteAppointments();

    expect(result.consultationsCompleted).toBe(1);
  });

  it("hands over only after the hourly detector has seen the booking past its grace window", () => {
    expect(
      NO_SHOW_HANDOFF_MINUTES - NO_SHOW_GRACE_MINUTES,
    ).toBeGreaterThanOrEqual(HOURLY_MINUTES);
  });

  it("classifies the three shapes the two jobs divide the world into", () => {
    const parties = {
      consultantUserId: CONSULTANT,
      consulteeUserId: CONSULTEE,
    };
    const slots = (attendees: string[]) => [
      {
        meetingSession: {
          attendances: attendees.map((userId) => ({ userId })),
        },
      },
    ];

    expect(classifyConsultantAttendance(slots([CONSULTANT]), parties)).toBe(
      "consultant-attended",
    );
    expect(classifyConsultantAttendance(slots([CONSULTEE]), parties)).toBe(
      "consultant-absent",
    );
    // Nobody joined, and no session at all: the detector raises a ticket for the
    // first and cannot see the second, so auto-complete keeps both.
    expect(classifyConsultantAttendance(slots([]), parties)).toBe(
      "inconclusive",
    );
    expect(
      classifyConsultantAttendance([{ meetingSession: null }], parties),
    ).toBe("inconclusive");
  });
});
