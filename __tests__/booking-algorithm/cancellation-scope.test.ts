/**
 * @jest-environment node
 */

/**
 * Cancellation is a whole-booking act; a booking is not one Appointment row.
 *
 * A subscription is a slot-less placeholder created at checkout — the row that
 * carries the Payment — plus one further Appointment per allocated session,
 * none of which carry money. The dashboards always target a SESSION row, so
 * reading the payment off "the appointment we were handed" found nothing and
 * cancelling a paid subscription refunded NOTHING while still cancelling every
 * slot and the subscription itself.
 *
 * The refund tier had the matching defect: it read the earliest slot of that
 * one appointment, COMPLETED sessions included, so the tier depended on which
 * session you cancelled from and a live plan whose first session had already
 * been held always scored 0%.
 *
 * Pinned here:
 *  - the payment is found from ANY appointment of the booking
 *  - the tier reads the earliest UNDELIVERED session of the whole booking
 *  - already-delivered sessions are counted, so the caller can refuse to guess
 *    a proration rule (#1006)
 *  - a consultation still resolves exactly as it always did
 */

const mockAppointmentFindMany = jest.fn();
const mockRecordSystemError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: {
      findMany: (...a: unknown[]) => mockAppointmentFindMany(...a),
    },
  },
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

import { PLATFORM_DEFAULT_TERMS } from "@/lib/payments/operations/cancellation-policy";
import {
  bookingAppointmentFilter,
  resolveBookingRefundContext,
} from "../../lib/booking/cancellation-scope";

const HOUR = 3_600_000;
const PLACEHOLDER = "appt-placeholder";
const SESSION_1 = "appt-s1";
const SESSION_2 = "appt-s2";

function hoursFromNow(h: number) {
  return new Date(Date.now() + h * HOUR);
}

/** A stored policy version, in the shape `POLICY_TERMS_INCLUDE` selects. */
function policyRow(
  id: string,
  tiers: { hoursBefore: number; refundBps: number }[],
) {
  return {
    id,
    organizationId: null,
    version: 1,
    consultantInitiatedBps: 10_000,
    tiers,
  };
}

/**
 * A subscription mid-plan: session 1 delivered, sessions 2 and 3 still owed,
 * and the money sitting on the slot-less placeholder.
 */
function subscriptionRows() {
  return [
    {
      id: PLACEHOLDER,
      cancellationPolicy: null,
      payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
      slotsOfAppointment: [],
    },
    {
      id: SESSION_1,
      cancellationPolicy: null,
      payment: [],
      slotsOfAppointment: [
        { startsAt: hoursFromNow(-48), completionStatus: "COMPLETED" },
      ],
    },
    {
      id: SESSION_2,
      cancellationPolicy: null,
      payment: [],
      slotsOfAppointment: [
        { startsAt: hoursFromNow(72), completionStatus: "SCHEDULED" },
        { startsAt: hoursFromNow(96), completionStatus: "SCHEDULED" },
      ],
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordSystemError.mockResolvedValue(undefined);
});

describe("bookingAppointmentFilter", () => {
  it("selects the whole subscription, not the one appointment handed in", () => {
    expect(
      bookingAppointmentFilter({
        appointmentId: SESSION_2,
        subscriptionId: "sub-1",
      }),
    ).toEqual({ subscriptionId: "sub-1" });
  });

  it("selects every session of a class", () => {
    expect(bookingAppointmentFilter({ classId: "class-1" })).toEqual({
      classId: "class-1",
    });
  });

  it("falls back to the lone appointment for trials and unlinked rows", () => {
    expect(bookingAppointmentFilter({ appointmentId: "appt-trial" })).toEqual({
      id: "appt-trial",
    });
  });

  it("refuses to select everything when nothing identifies the booking", () => {
    // An empty filter would have matched every appointment in the table.
    expect(() => bookingAppointmentFilter({})).toThrow(/no booking identifier/);
  });
});

describe("resolveBookingRefundContext", () => {
  it("finds the subscription's payment even when handed a session row", async () => {
    mockAppointmentFindMany.mockResolvedValue(subscriptionRows());

    const ctx = await resolveBookingRefundContext({
      appointmentId: SESSION_2,
      subscriptionId: "sub-1",
    });

    // This is the bug: the money lives on the placeholder the UI never targets.
    expect(ctx.paidPayment).toEqual({
      id: "pay-1",
      amountPaise: 100_000,
      refundablePaise: 100_000,
    });
  });

  it("times the tier off the next UNDELIVERED session of the booking", async () => {
    mockAppointmentFindMany.mockResolvedValue(subscriptionRows());

    const ctx = await resolveBookingRefundContext({
      subscriptionId: "sub-1",
    });

    // Session 1 is 48h in the past. Reading the earliest slot outright gave a
    // negative value and therefore a 0% tier on a plan with sessions still owed.
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(71);
    expect(ctx.hoursUntilNextSession).toBeLessThan(73);
  });

  it("counts what has been delivered and what is still owed", async () => {
    mockAppointmentFindMany.mockResolvedValue(subscriptionRows());

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    // The caller refuses to auto-refund a partly-consumed plan on this (#1006).
    expect(ctx.sessionsCompleted).toBe(1);
    expect(ctx.sessionsRemaining).toBe(2);
  });

  it("treats a RESCHEDULED slot as still owed, not as delivered", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: SESSION_1,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [
          { startsAt: hoursFromNow(30), completionStatus: "RESCHEDULED" },
        ],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.sessionsRemaining).toBe(1);
    expect(ctx.sessionsCompleted).toBe(0);
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(29);
  });

  it("reports no live session for a paid but unallocated subscription", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    // null, not a negative number: "never scheduled" and "already started" are
    // different facts and only the caller can decide what each is worth.
    expect(ctx.hoursUntilNextSession).toBeNull();
    expect(ctx.paidPayment).not.toBeNull();
  });

  it("takes the terms stamped on the row the buyer actually paid for", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: SESSION_1,
        cancellationPolicy: policyRow("policy-session", [
          { hoursBefore: 0, refundBps: 0 },
        ]),
        payment: [],
        slotsOfAppointment: [],
      },
      {
        id: PLACEHOLDER,
        cancellationPolicy: policyRow("policy-paid", [
          { hoursBefore: 48, refundBps: 9_000 },
        ]),
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.policy.policyId).toBe("policy-paid");
    expect(ctx.policy.tiers).toEqual([{ hoursBefore: 48, refundPct: 90 }]);
  });

  it("falls back to a session's policy when the paid row carries none", async () => {
    // Bookings sold before #1499 stamped the FK on the subscription placeholder;
    // without this fallback every one of them silently dropped to the defaults.
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [],
      },
      {
        id: SESSION_1,
        cancellationPolicy: policyRow("policy-session", [
          { hoursBefore: 12, refundBps: 2_500 },
        ]),
        payment: [],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.policy.policyId).toBe("policy-session");
    expect(ctx.policy.tiers).toEqual([{ hoursBefore: 12, refundPct: 25 }]);
  });

  it("reads a booking with no policy row at all as the platform ladder", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.policy).toEqual(PLATFORM_DEFAULT_TERMS);
  });

  it("scopes the payment lookup to one buyer for group events", async () => {
    mockAppointmentFindMany.mockResolvedValue([]);

    await resolveBookingRefundContext({ classId: "class-1" }, "user-7");

    // Every attendee's Payment hangs off the same appointment, so an unscoped
    // lookup would refund whoever the DB returned first.
    expect(mockAppointmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          payment: expect.objectContaining({
            where: expect.objectContaining({ userId: "user-7" }),
          }),
        }),
      }),
    );
  });

  it("scopes the SLOT counts to the same buyer", async () => {
    mockAppointmentFindMany.mockResolvedValue([]);

    await resolveBookingRefundContext({ classId: "class-1" }, "user-7");

    // Scoping only the payment left sessionsCompleted, sessionsRemaining,
    // slotsTotal and the tier itself derived from OTHER attendees' seats — so
    // one buyer's refund was timed off a session another attendee had booked.
    expect(mockAppointmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          slotsOfAppointment: expect.objectContaining({
            where: expect.objectContaining({
              user: { some: { id: "user-7" } },
            }),
          }),
        }),
      }),
    );
  });

  it("leaves the slot lookup unscoped for a 1:1 booking", async () => {
    mockAppointmentFindMany.mockResolvedValue([]);

    await resolveBookingRefundContext({ consultationId: "cons-1" });

    const where =
      mockAppointmentFindMany.mock.calls[0][0].select.slotsOfAppointment.where;
    expect(where).toEqual({ deletedAt: null });
  });

  it("escalates rather than silently refunding one of several payments", async () => {
    // Unreachable today — @@unique([userId, appointmentId]) allows one payment
    // per payer per appointment, and the CHARGE_MEMBER overage side-charge is
    // created with appointmentId: null precisely to avoid that clash. Which is
    // why it must be loud if it ever happens: the buyer would be refunded less
    // than they paid, and nothing else would say so.
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [
          { id: "pay-1", amount: 100_000, refunds: [], disputes: [] },
          { id: "pay-2", amount: 40_000, refunds: [], disputes: [] },
        ],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.paidPayment?.id).toBe("pay-1");
    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        context: expect.objectContaining({
          paymentIds: ["pay-1", "pay-2"],
        }),
      }),
    );
  });

  it("stays quiet for the ordinary single-payment booking", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [],
      },
    ]);

    await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });

  it("resolves a consultation exactly as before — one row, one payment", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: "appt-c1",
        cancellationPolicy: null,
        payment: [{ id: "pay-c", amount: 250_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [
          { startsAt: hoursFromNow(5), completionStatus: "SCHEDULED" },
        ],
      },
    ]);

    const ctx = await resolveBookingRefundContext({
      appointmentId: "appt-c1",
      consultationId: "cons-1",
    });

    expect(ctx.paidPayment).toEqual({
      id: "pay-c",
      amountPaise: 250_000,
      refundablePaise: 250_000,
    });
    expect(ctx.sessionsCompleted).toBe(0);
    expect(ctx.hoursUntilNextSession).toBeGreaterThan(4);
  });

  it("nets prior refunds and lost chargebacks out of the refundable balance", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [
          {
            id: "pay-1",
            amount: 100_000,
            refunds: [
              { amountPaise: 20_000, status: "SUCCEEDED" },
              { amountPaise: 5_000, status: "PENDING" },
              // Moved no money, so it must not reduce the balance.
              { amountPaise: 40_000, status: "FAILED" },
            ],
            disputes: [
              { amountPaise: 10_000, status: "LOST" },
              // The bank already returned this one, so it reduces the balance
              // exactly as a LOST verdict does.
              { amountPaise: 5_000, status: "CHARGE_REFUNDED" },
              // Still contested — nothing has been pulled yet.
              { amountPaise: 30_000, status: "UNDER_REVIEW" },
            ],
          },
        ],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    // Callers tier the gross but must clamp to this, or the refund operation
    // rejects the whole request instead of paying the remainder.
    expect(ctx.paidPayment?.amountPaise).toBe(100_000);
    expect(ctx.paidPayment?.refundablePaise).toBe(60_000);
  });

  it("never reports a negative refundable balance", async () => {
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [
          {
            id: "pay-1",
            amount: 100_000,
            refunds: [{ amountPaise: 100_000, status: "SUCCEEDED" }],
            disputes: [{ amountPaise: 100_000, status: "LOST" }],
          },
        ],
        slotsOfAppointment: [],
      },
    ]);

    const ctx = await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(ctx.paidPayment?.refundablePaise).toBe(0);
  });

  it("distinguishes never-scheduled from all-slots-terminal", async () => {
    // These two look identical through sessionsCompleted/sessionsRemaining —
    // both zero — but only the first means the consultant never held time.
    // Conflating them hands a full refund to anyone reading the booking after
    // a cancel has already terminalised its slots.
    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [],
      },
    ]);
    expect(
      (await resolveBookingRefundContext({ subscriptionId: "s" })).slotsTotal,
    ).toBe(0);

    mockAppointmentFindMany.mockResolvedValue([
      {
        id: PLACEHOLDER,
        cancellationPolicy: null,
        payment: [{ id: "pay-1", amount: 100_000, refunds: [], disputes: [] }],
        slotsOfAppointment: [
          { startsAt: hoursFromNow(48), completionStatus: "CANCELLED" },
        ],
      },
    ]);
    const cancelled = await resolveBookingRefundContext({
      subscriptionId: "s",
    });
    expect(cancelled.slotsTotal).toBe(1);
    expect(cancelled.sessionsRemaining).toBe(0);
    expect(cancelled.sessionsCompleted).toBe(0);
  });

  it("skips soft-deleted appointments", async () => {
    mockAppointmentFindMany.mockResolvedValue([]);

    await resolveBookingRefundContext({ subscriptionId: "sub-1" });

    expect(mockAppointmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscriptionId: "sub-1", deletedAt: null },
      }),
    );
  });
});
