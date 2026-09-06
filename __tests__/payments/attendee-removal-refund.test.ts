/**
 * @jest-environment node
 */

/**
 * Removing a paid attendee has to return their fee (#1003).
 *
 * The participant-removal endpoints moved the roster and left the money alone:
 * a consultant could pull a paying attendee out of a class or webinar and keep
 * the fee, with no refund, no earnings reversal and no notice to the attendee.
 * The moderation bulk-cancel has always refunded a removed attendee in full;
 * the interactive endpoints were the outlier.
 *
 * Pinned here:
 *  - the removed attendee's OWN payment is the one refunded, not the first row
 *    on an appointment every attendee's payment hangs off
 *  - the organiser's act settles at the consultant-initiated percentage
 *  - an org-funded seat goes through the rail-aware front door
 *  - a free seat and a failed refund both leave the removal standing
 */

const mockPaymentFindFirst = jest.fn();
const mockSlotFindFirst = jest.fn();
const mockRefundBookingPayment = jest.fn();
const mockNotifyRefundProcessed = jest.fn();
const mockRecordSystemError = jest.fn();
const mockReportSentryError = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: {
      findFirst: (...a: unknown[]) => mockPaymentFindFirst(...a),
      findMany: jest.fn().mockResolvedValue([]),
    },
    slotOfAppointment: {
      findFirst: (...a: unknown[]) => mockSlotFindFirst(...a),
    },
  },
}));

jest.mock("../../lib/payments/operations/booking-refund", () => ({
  isInternalFundedIntent: (i: string) => i.startsWith("org_"),
  refundBookingPayment: (...a: unknown[]) => mockRefundBookingPayment(...a),
}));

jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: jest.fn(),
  RefundValidationError: class extends Error {
    constructor(
      m: string,
      public code: string,
    ) {
      super(m);
    }
  },
}));

jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: jest.fn(),
}));

jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: (...a: unknown[]) => mockNotifyRefundProcessed(...a),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => mockRecordSystemError(...a),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => mockReportSentryError(...a),
  reportSentryMessage: jest.fn(),
}));

import { refundRemovedAttendeeSeat } from "../../lib/payments/operations/event-refunds";

const ATTENDEE = "user-7";

function seat(
  paymentIntent: string,
  extra: Partial<{
    refunds: { amountPaise: number; status: string }[];
    disputes: { amountPaise: number; status: string }[];
    organizationId: string | null;
  }> = {},
) {
  return {
    id: "pay-seat",
    amount: 50_000,
    currency: "INR",
    organizationId: null,
    paymentIntent,
    refunds: [],
    disputes: [],
    appointment: { cancellationPolicy: null },
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPaymentFindFirst.mockResolvedValue(seat("pay_ABC"));
  mockSlotFindFirst.mockResolvedValue({
    startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  });
  mockRefundBookingPayment.mockResolvedValue({
    refundId: "r1",
    amountRefundedPaise: 50_000,
    rail: "GATEWAY",
  });
  mockNotifyRefundProcessed.mockResolvedValue(undefined);
  mockRecordSystemError.mockResolvedValue(undefined);
});

describe("refundRemovedAttendeeSeat", () => {
  it("refunds the removed attendee's seat in full", async () => {
    const result = await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    // Organiser-initiated, so the consultant-initiated tier applies whatever
    // the clock says — the attendee did not choose to leave. The rail rides
    // along so the caller's toast can name where the money went (defect 1).
    expect(result).toEqual({
      amountRefundedPaise: 50_000,
      refundPct: 100,
      rail: "GATEWAY",
    });
  });

  it("targets the removed attendee's own payment", async () => {
    await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    // Every attendee's Payment hangs off the same appointment, so an unscoped
    // lookup would have refunded whoever the DB returned first.
    expect(mockPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: ATTENDEE,
          appointment: { classId: "class-1" },
          paymentStatus: "SUCCEEDED",
        }),
      }),
    );
  });

  it("routes an org-funded seat through the rail-aware front door", async () => {
    mockPaymentFindFirst.mockResolvedValue(seat("org_wallet_1_a"));
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 50_000,
      rail: "INTERNAL",
    });

    const result = await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-seat" }),
    );
    expect(result?.amountRefundedPaise).toBe(50_000);
    // The rail rides out to the organiser's toast, which must not claim a
    // gateway refund for a seat the sponsor paid for.
    expect(result?.rail).toBe("INTERNAL");
    // And the attendee is told nothing: the value went back to the org's
    // wallet/accrual/licence, which they never held. Notifying on every rail
    // promises this person money that is never coming.
    expect(mockNotifyRefundProcessed).not.toHaveBeenCalled();
  });

  it("mints nothing for a free seat", async () => {
    mockPaymentFindFirst.mockResolvedValue(null);

    const result = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(result).toBeNull();
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
  });

  it("tells the attendee their money is coming back", async () => {
    await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockNotifyRefundProcessed).toHaveBeenCalledWith(
      ATTENDEE,
      expect.objectContaining({ amount: 50_000 }),
    );
  });

  it("stays quiet when the money went to the org, not the member", async () => {
    // On the internal rail the value returned to the org's wallet, accrual or
    // licence. The member never paid, so promising them a refund is false.
    mockPaymentFindFirst.mockResolvedValue(seat("org_wallet_1_a"));
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 50_000,
      rail: "INTERNAL",
    });

    await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockNotifyRefundProcessed).not.toHaveBeenCalled();
  });

  it("clamps the seat refund to what is still refundable", async () => {
    // Without the clamp the full 100% overshoots the remaining balance,
    // refundPayment rejects the WHOLE request, and the attendee receives
    // nothing of the remainder they are owed. Same bug the cancel route had.
    mockPaymentFindFirst.mockResolvedValue(
      seat("pay_ABC", {
        refunds: [{ amountPaise: 20_000, status: "SUCCEEDED" }],
        disputes: [{ amountPaise: 5_000, status: "CHARGE_REFUNDED" }],
      }),
    );
    mockRefundBookingPayment.mockResolvedValue({
      refundId: "r1",
      amountRefundedPaise: 25_000,
      rail: "GATEWAY",
    });

    await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 25_000 }),
    );
  });

  it("reports a seat failure to the funding organisation", async () => {
    // Hard-coded null meant an org-funded seat's failure never reached the
    // ops surface of the org that is actually owed the money.
    mockPaymentFindFirst.mockResolvedValue(
      seat("org_wallet_1_a", { organizationId: "org-9" }),
    );
    mockRefundBookingPayment.mockRejectedValue(new Error("ledger down"));

    await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(mockRecordSystemError).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-9" }),
    );
  });

  it("does not page ops for an idempotent re-drive", async () => {
    // A repeat click or a stale tab is not an incident.
    const { RefundValidationError } = jest.requireMock(
      "../../lib/payments/operations/refund",
    ) as { RefundValidationError: new (m: string, c: string) => Error };
    mockRefundBookingPayment.mockRejectedValue(
      new RefundValidationError("already done", "ALREADY_FULLY_REFUNDED"),
    );

    const result = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    // Nothing moved, so there is no rail to name.
    expect(result).toEqual({
      amountRefundedPaise: 0,
      refundPct: 0,
      rail: null,
    });
    expect(mockRecordSystemError).not.toHaveBeenCalled();
    expect(mockReportSentryError).not.toHaveBeenCalled();
  });

  it("leaves the removal standing and pages ops when the refund fails", async () => {
    mockRefundBookingPayment.mockRejectedValue(new Error("gateway down"));

    // Must not throw — the roster change has already committed.
    const result = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: "consultant-1",
    });

    expect(result).toEqual({
      amountRefundedPaise: 0,
      refundPct: 0,
      rail: null,
    });
    expect(mockReportSentryError).toHaveBeenCalled();
    expect(mockRecordSystemError).toHaveBeenCalled();
  });

  it("self-leave after start refunds 0% under attendee notice tiers (#1005)", async () => {
    // No upcoming live slot (startsAt >= now) → hoursUntilStart stays -1 → 0%.
    mockSlotFindFirst.mockResolvedValue(null);

    const result = await refundRemovedAttendeeSeat({
      kind: "webinar",
      eventId: "web-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: ATTENDEE,
      initiatedBy: "attendee",
    });

    expect(result).toEqual({
      amountRefundedPaise: 0,
      refundPct: 0,
      rail: null,
    });
    expect(mockRefundBookingPayment).not.toHaveBeenCalled();
    expect(mockSlotFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startsAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });

  it("mid-program class self-leave uses the next future session for notice", async () => {
    const nextStart = new Date(Date.now() + 72 * 60 * 60 * 1000);
    mockSlotFindFirst.mockResolvedValue({ startsAt: nextStart });

    const result = await refundRemovedAttendeeSeat({
      kind: "class",
      eventId: "class-1",
      attendeeUserId: ATTENDEE,
      initiatedByUserId: ATTENDEE,
      initiatedBy: "attendee",
    });

    // Default policy: ≥48h notice → full attendee tier (100% under platform defaults).
    expect(result).toEqual({
      amountRefundedPaise: 50_000,
      refundPct: 100,
      rail: "GATEWAY",
    });
    expect(mockRefundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining("by the attendee"),
      }),
    );
  });
});
