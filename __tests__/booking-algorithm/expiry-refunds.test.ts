/**
 * PR 2c money fix — the expiry sweep must refund SUCCEEDED payments of
 * expired engagements through the booking front door, and drain the immortal
 * APPROVED-unallocated subscription cohort (audit gaps #1 + #3).
 */

import "./setup";

const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) =>
    refundBookingPayment(...(a as [never])),
}));

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    consultation: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    slotOfAppointment: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    appointment: { findMany: jest.fn() },
    $disconnect: jest.fn(),
  };
  // The payment-pending arm now expires each request in its own transaction.
  db.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

import prisma from "../../lib/prisma";
import { expireStaleRequests } from "../../scripts/appointments/expire-stale-requests";
import { AppointmentStatus } from "@prisma/client";

describe("expiry sweep refunds (PR 2c)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.consultation.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.subscription.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.appointment.findMany as jest.Mock).mockResolvedValue([]);
  });

  it("refunds SUCCEEDED payments of expired PENDING subscriptions via the front door", async () => {
    const richRow = {
      id: "sub-1",
      requestedAt: new Date("2026-01-01"),
      requestedBy: { user: { name: "Buyer", email: "" } },
      subscriptionPlan: {
        consultantProfile: { user: { name: "Consultant", email: "" } },
      },
    };
    (prisma.subscription.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([richRow]) // PENDING cohort
      .mockResolvedValueOnce([]); // APPROVED-unallocated cohort: empty
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.appointment.findMany as unknown as jest.Mock).mockResolvedValue([
      {
        id: "apt-1",
        payment: [
          { id: "pay-succeeded", paymentStatus: "SUCCEEDED" },
          { id: "pay-failed", paymentStatus: "FAILED" },
        ],
      },
    ]);
    refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await expireStaleRequests();

    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-succeeded",
        initiatedByUserId: null,
        reason: expect.stringContaining("expired"),
      }),
    );
    expect(result.refundsIssued).toBe(1);
    expect(result.refundFailures).toBe(0);
  });

  it("counts a front-door refusal as a failure without stalling the sweep", async () => {
    (prisma.subscription.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: "sub-1",
          requestedAt: new Date("2026-01-01"),
          requestedBy: { user: { name: "B", email: "" } },
          subscriptionPlan: {
            consultantProfile: { user: { name: "C", email: "" } },
          },
        },
      ])
      .mockResolvedValueOnce([]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.appointment.findMany as unknown as jest.Mock).mockResolvedValue([
      { id: "apt-1", payment: [{ id: "pay1", paymentStatus: "SUCCEEDED" }] },
    ]);
    refundBookingPayment.mockRejectedValue(
      new Error("REFUND_FRONT_DOOR_REFUSAL"),
    );

    const result = await expireStaleRequests();

    expect(result.refundsIssued).toBe(0);
    expect(result.refundFailures).toBe(1);
    expect(result.errors.join("; ")).toContain("Refund failed");
  });

  it("drains the immortal APPROVED-unallocated cohort (zero live confirmed slots)", async () => {
    // First findMany call = PENDING subs (none); second = APPROVED cohort.
    (prisma.subscription.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "sub-immortal" }]);
    (prisma.subscription.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    (prisma.appointment.findMany as unknown as jest.Mock).mockResolvedValue([
      {
        id: "placeholder",
        payment: [{ id: "pay-paid", paymentStatus: "SUCCEEDED" }],
      },
    ]);
    refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await expireStaleRequests();

    // Cohort filter: APPROVED + stale + zero confirmed slots.
    const cohortCall = (prisma.subscription.findMany as jest.Mock).mock
      .calls[1][0];
    expect(cohortCall.where.status).toBe(AppointmentStatus.APPROVED);
    expect(JSON.stringify(cohortCall.where.NOT)).toContain("isTentative");
    // Through the CAS helper now (#1423): the from-set rides the WHERE as a
    // list, and the cohort's own predicate is repeated at write time.
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "sub-immortal",
          status: { in: [AppointmentStatus.APPROVED] },
          NOT: expect.anything(),
        }),
        data: { status: "EXPIRED" },
      }),
    );
    expect(result.subscriptionsExpired).toBe(1);
    expect(result.refundsIssued).toBe(1);
  });

  /**
   * #1423 — the PENDING arm re-ran the 30-day predicate in the write instead
   * of naming the rows it had read, so the expired set and the refunded set
   * could diverge: a subscription that crossed the cutoff between the two
   * statements was expired without a refund and without an audit row, and the
   * next run (which reads PENDING only) never saw it again.
   */
  it("expires only the rows it read, and every expired row gets history and a refund", async () => {
    const readRow = {
      id: "sub-read",
      requestedAt: new Date("2026-01-01"),
      requestedBy: { user: { name: "Buyer", email: "" } },
      subscriptionPlan: {
        consultantProfile: { user: { name: "Consultant", email: "" } },
      },
    };
    (prisma.subscription.findMany as unknown as jest.Mock)
      .mockResolvedValueOnce([readRow]) // PENDING cohort
      .mockResolvedValueOnce([]); // APPROVED-unallocated cohort: empty
    // "sub-latecomer" crosses the 30-day line between the read and the write.
    // A predicate-shaped write would sweep it up; an id-scoped CAS cannot.
    (prisma.subscription.updateMany as jest.Mock).mockImplementation(
      async ({ where }: { where: { id?: string } }) => ({
        count: where.id === "sub-read" ? 1 : 0,
      }),
    );
    (prisma.appointment.findMany as unknown as jest.Mock).mockResolvedValue([
      {
        id: "apt-read",
        payment: [{ id: "pay-read", paymentStatus: "SUCCEEDED" }],
      },
    ]);
    refundBookingPayment.mockResolvedValue({ status: "SUCCEEDED" });

    const result = await expireStaleRequests();

    // Every terminal write names exactly one id from the read set.
    const terminalWrites = (
      prisma.subscription.updateMany as jest.Mock
    ).mock.calls
      .map(([args]) => args)
      .filter((args) => args?.data?.status === AppointmentStatus.EXPIRED);
    expect(terminalWrites).toHaveLength(1);
    expect(terminalWrites[0].where.id).toBe("sub-read");
    expect(terminalWrites[0].where.status).toEqual({
      in: [AppointmentStatus.PENDING],
    });

    // The CAS helper wrote the audit row the bulk update never did.
    expect(prisma.bookingStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity: "SUBSCRIPTION",
          entityId: "sub-read",
          toStatus: AppointmentStatus.EXPIRED,
          reason: expect.stringContaining("PENDING"),
        }),
      }),
    );

    // Refunds are handed the ids the helper transitioned, not the read set.
    expect(prisma.appointment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscriptionId: { in: ["sub-read"] } },
      }),
    );
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(result.subscriptionsExpired).toBe(1);
    expect(result.refundsIssued).toBe(1);
  });
});
