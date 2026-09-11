/**
 * Anti-scalper cap for request-for-approval holds (booking-journey audit B1)
 * and the 48h PENDING-consultation expiry that keeps it honest.
 *
 * A PENDING request pins a tentative slot that blocks the consultant's
 * calendar; nothing used to bound how many one account could accumulate or
 * how long a hold could live (30 days, swept daily). These tests pin the cap
 * constant, the count query shape, and the expiry's slot release.
 */

import "./setup";

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    subscription: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(),
    },
    slotOfAppointment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn(),
  };
  // The payment-pending arm now expires each request in its own transaction.
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

// B1's sweep now routes refunds through booking-refund, whose module graph
// constructs a Stripe client (needs global fetch — absent in this env).
const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  // Pass-through so tests drive the unlocked core directly.
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import {
  MAX_ACTIVE_REQUESTS_PER_USER,
  countActiveConsultationRequests,
} from "../../lib/booking/request-caps";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";

// Source-text pin (same style as approval-path-correctness.test.ts): the RFA
// route must acquire the CONSULTEE lock before the slot atoms — direct
// checkout uses consultee → atoms, and the reverse order here would be a
// classic ABBA deadlock against it (audit B8a).
const rfaRoute = require("fs").readFileSync(
  require("path").resolve(
    __dirname,
    "../../app/api/slots/request-for-approval/route.ts",
  ),
  "utf8",
);

describe("RFA route lock order", () => {
  it("takes the consultee lock before the slot atoms", () => {
    const consulteeAt = rfaRoute.indexOf(
      "lockConsulteeBooking(session.user.id)",
    );
    const atomsAt = rfaRoute.indexOf(
      "lockSlotBooking(consultantProfileId, startsAt, endsAt)",
    );
    expect(consulteeAt).toBeGreaterThan(-1);
    expect(atomsAt).toBeGreaterThan(consulteeAt);
  });

  it("enforces the active-request cap before creating the hold", () => {
    expect(rfaRoute).toContain("countActiveConsultationRequests");
    expect(rfaRoute).toContain("MAX_ACTIVE_REQUESTS_PER_USER");
  });
});

describe("RFA active-request cap", () => {
  it("caps at 3 active pending requests per user", () => {
    expect(MAX_ACTIVE_REQUESTS_PER_USER).toBe(3);
  });

  it("counts only PENDING consultations of this consultee", async () => {
    (prisma.consultation.count as jest.Mock).mockResolvedValue(2);
    const n = await countActiveConsultationRequests(
      prisma as never,
      "consultee-profile-1",
    );
    expect(n).toBe(2);
    expect(prisma.consultation.count).toHaveBeenCalledWith({
      where: {
        requestedById: "consultee-profile-1",
        status: "PENDING",
      },
    });
  });
});

describe("48h PENDING consultation expiry releases pinned slots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
      count: 0,
    });
  });

  it("expires stale consultations by id and soft-cancels their tentative slots", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([
      { id: "c1", appointment: { id: "apt-1" } },
      { id: "c2", appointment: { id: "apt-2" } },
      { id: "c3", appointment: null }, // slot-less placeholder
    ]);
    // PR 2c — the sweep now refunds SUCCEEDED payments of expired rows.
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);
    (refundBookingPayment as jest.Mock).mockResolvedValue({
      status: "SUCCEEDED",
    });
    (prisma.consultation.updateMany as jest.Mock).mockResolvedValue({
      count: 3,
    });
    (
      prisma.slotOfAppointment.updateManyAndReturn as jest.Mock
    ).mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `slot-${i}` })),
    );

    const result = await expireStaleRequests();

    expect(result.success).toBe(true);
    expect(result.consultationsExpired).toBe(3);
    expect(result.consultationSlotsReleased).toBe(5);

    // One transaction per consultation: the CAS guard rides the WHERE (only a
    // row still PENDING flips), and the release of its tentative holds commits
    // with it, so a failed release can never leave an EXPIRED request holding
    // the calendar. Freed by status: the row is CANCELLED and tombstoned,
    // never deleted (doctrine rule 2).
    for (const id of ["c1", "c2", "c3"]) {
      expect(prisma.consultation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id, status: { in: ["PENDING"] } }),
          data: expect.objectContaining({ status: "EXPIRED" }),
        }),
      );
    }
    // c3 is a slot-less placeholder, so only two releases run.
    expect(prisma.slotOfAppointment.updateManyAndReturn).toHaveBeenCalledTimes(
      2,
    );
    expect(prisma.slotOfAppointment.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          appointmentId: "apt-1",
          isTentative: true,
          deletedAt: null,
          completionStatus: { in: ["SCHEDULED", "UNVERIFIED", "RESCHEDULED"] },
        },
        data: expect.objectContaining({ completionStatus: "CANCELLED" }),
      }),
    );
  });

  it("is a no-op when nothing is stale", async () => {
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);

    const result = await expireStaleRequests();

    expect(result.consultationsExpired).toBe(0);
    expect(result.consultationSlotsReleased).toBe(0);
    // The stale-rescheduled-slot release (PR 2e) may fire independently —
    // assert the CONSULTATION-expiry release was NOT the one that ran. Both
    // arms now carry a completionStatus from-set, so the consultation arm is
    // identified by its appointmentId scope instead.
    const calls = (prisma.slotOfAppointment.updateManyAndReturn as jest.Mock)
      .mock.calls;
    const consultationRelease = calls.find(
      ([args]) =>
        (args as { where?: { appointmentId?: unknown } })?.where
          ?.appointmentId !== undefined,
    );
    expect(consultationRelease).toBeUndefined();
  });
});
