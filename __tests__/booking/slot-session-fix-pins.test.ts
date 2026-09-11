/**
 * @jest-environment node
 */

/**
 * Regression pins for the slot/session fixes that landed via PRs #825/#838
 * but whose issues stayed open (#788, #827, #828) plus the #829 cleanup
 * guard. These tests exist so a future refactor that reintroduces any of the
 * four bugs fails CI instead of resurfacing in production:
 *
 *  #788 — mergeConsecutiveSlots fused adjacent availability ROWS, mis-binding
 *         sliced sub-windows to the first row's id while checkout validated
 *         against that one row. #1320 moved checkout to a union-of-rows rule,
 *         so the cross-row merge is now REQUIRED and the pin below asserts the
 *         new invariant: every covering row id rides the merged slot.
 *  #827 — confirmExistingAppointment flipped slots confirmed without checking
 *         for an already-confirmed overlapping slot (cross-user double-book).
 *  #828 — checkout had no request-level idempotency; the replay helper must
 *         return the original attempt instead of minting a duplicate.
 *  #829 — cleanup-tentative-slots deleted by id only, destroying slots whose
 *         capture webhook confirmed them between the scan and the delete.
 */

import { mergeConsecutiveSlots } from "@/utils/timeSlotsProcessing";
import { confirmExistingAppointment } from "@/lib/payments/webhooks/handlers";
import { replayByIdempotencyKey } from "@/lib/payments/operations/checkout-replay";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { payment: { findFirst: jest.fn() } },
}));
// handlers.ts pulls heavy transitive deps; stub everything the confirm path
// doesn't exercise.
jest.mock("../../lib/email", () => ({
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  processConsultantBookingReferral: jest.fn(),
  reverseCreditsForPayment: jest.fn(),
  qualifyReferralOnFirstBooking: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../../lib/prisma";
import { recordSystemError } from "../../lib/enterprise/system-events";

const mockPaymentFindFirst = (
  prisma as unknown as { payment: { findFirst: jest.Mock } }
).payment.findFirst;
const mockSystemError = recordSystemError as jest.Mock;

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// #788 — same-source merge guard
// ---------------------------------------------------------------------------
describe("#788 → #1320 — mergeConsecutiveSlots merges across rows and keeps every covering id", () => {
  const base = {
    isAllocated: false,
    localStartTime: "x",
    localEndTime: "x",
    slotId: "s",
  };
  const rowA = {
    ...base,
    slotOfAvailabilityId: "row-A",
    startsAt: "2026-06-26T14:00:00.000Z",
    endsAt: "2026-06-26T15:00:00.000Z",
  };
  const rowB = {
    ...base,
    slotOfAvailabilityId: "row-B",
    startsAt: "2026-06-26T15:00:00.000Z",
    endsAt: "2026-06-26T16:00:00.000Z",
  };

  it("merges adjacent slots from DIFFERENT rows and carries both ids (#1320)", () => {
    const merged = mergeConsecutiveSlots([rowA, rowB] as never);
    expect(merged).toHaveLength(1);
    expect(merged[0].endsAt).toBe("2026-06-26T16:00:00.000Z");
    // The first row's id stays for compatibility; the mis-bind #788 feared is
    // harmless now that checkout validates the window against the union of
    // the consultant's rows, and the full set is available to any reader.
    expect(merged[0].slotOfAvailabilityId).toBe("row-A");
    expect(merged[0].slotOfAvailabilityIds).toEqual(["row-A", "row-B"]);
  });

  it("still merges adjacent sub-windows of the SAME row (the trial use case)", () => {
    const sameRowB = { ...rowB, slotOfAvailabilityId: "row-A" };
    const merged = mergeConsecutiveSlots([rowA, sameRowB] as never);
    expect(merged).toHaveLength(1);
    expect(merged[0].endsAt).toBe("2026-06-26T16:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// #827 — confirm-time double-booking guard
// ---------------------------------------------------------------------------
describe("#827 — confirmExistingAppointment first-confirmed-wins", () => {
  function mockTx(opts: { conflict: boolean }) {
    const slotUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    return {
      slotUpdateMany,
      tx: {
        appointmentParticipant: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        appointment: {
          findUnique: jest.fn().mockResolvedValue({
            id: "appt-1",
            consultation: { id: "c1" },
            subscription: null,
            webinar: null,
            class: null,
          }),
        },
        slotOfAppointment: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "slot-1",
              startsAt: new Date("2026-06-26T15:00:00Z"),
              endsAt: new Date("2026-06-26T16:00:00Z"),
              user: [{ id: "booker" }, { id: "consultant" }],
            },
          ]),
          findFirst: jest
            .fn()
            .mockResolvedValue(
              opts.conflict
                ? { id: "slot-other", appointmentId: "appt-2" }
                : null,
            ),
          updateMany: slotUpdateMany,
        },
        consultation: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            id: "c1",
            status: "APPROVED_PENDING_PAYMENT",
          }),
        },
      } as never,
    };
  }

  it("blocks confirmation (slots stay tentative) when an overlapping confirmed slot exists", async () => {
    const m = mockTx({ conflict: true });
    await confirmExistingAppointment(m.tx, "appt-1", "booker");
    expect(m.slotUpdateMany).not.toHaveBeenCalled();
    expect(mockSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        context: expect.objectContaining({
          conflictingAppointmentId: "appt-2",
        }),
      }),
    );
  });

  it("confirms normally when no overlap exists", async () => {
    const m = mockTx({ conflict: false });
    await confirmExistingAppointment(m.tx, "appt-1", "booker");
    expect(m.slotUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isTentative: false } }),
    );
    expect(mockSystemError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #855 — capture-after-cancel signals Phase 2 to auto-refund
// ---------------------------------------------------------------------------
describe("#855 — capturedAfterTerminal signal on a cancelled booking", () => {
  function mockTx(consultationStatus: string, casCount: number) {
    return {
      appointmentParticipant: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      appointment: {
        findUnique: jest.fn().mockResolvedValue({
          id: "appt-1",
          consultation: { id: "c1" },
          subscription: null,
          webinar: null,
          class: null,
        }),
      },
      slotOfAppointment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "slot-1",
            startsAt: new Date("2026-06-26T15:00:00Z"),
            endsAt: new Date("2026-06-26T16:00:00Z"),
            user: [{ id: "booker" }, { id: "consultant" }],
          },
        ]),
        findFirst: jest.fn().mockResolvedValue(null), // no #827 overlap
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      consultation: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: casCount }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "c1", status: consultationStatus }),
      },
    } as never;
  }

  it("flags capturedAfterTerminal + records refund-needed when the consultation is CANCELLED", async () => {
    const tx = mockTx("CANCELLED", 0);
    const result = await confirmExistingAppointment(tx, "appt-1", "booker");
    expect(result.capturedAfterTerminal).toBe(true);
    expect(mockSystemError).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        err: expect.objectContaining({
          message: "CAPTURE_AFTER_TERMINAL_STATE",
        }),
      }),
    );
  });

  it("does not flag a normal APPROVED_PENDING_PAYMENT → APPROVED confirmation", async () => {
    const tx = mockTx("APPROVED_PENDING_PAYMENT", 1);
    const result = await confirmExistingAppointment(tx, "appt-1", "booker");
    expect(result.capturedAfterTerminal).toBe(false);
    expect(mockSystemError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #828 — idempotent checkout replay
// ---------------------------------------------------------------------------
describe("#828 — replayByIdempotencyKey returns the original attempt", () => {
  it("replays a PENDING Razorpay attempt with the original order id", async () => {
    mockPaymentFindFirst.mockResolvedValue({
      paymentIntent: "order_original",
      paymentStatus: "PENDING",
      paymentGateway: "RAZORPAY",
      amount: BigInt(50000),
      currency: "INR",
      appointmentId: "appt-1",
      isMockPayment: false,
    });
    const res = await replayByIdempotencyKey("user-1", "ck_abc12345");
    const body = await res!.json();
    expect(body.reused).toBe(true);
    expect(body.orderId).toBe("order_original");
    // scoped to the caller — a guessed key can't read another user's payment
    expect(mockPaymentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientIdempotencyKey: "ck_abc12345", userId: "user-1" },
      }),
    );
  });

  it("replays a SUCCEEDED attempt as already-completed", async () => {
    mockPaymentFindFirst.mockResolvedValue({
      paymentIntent: "order_x",
      paymentStatus: "SUCCEEDED",
      paymentGateway: "RAZORPAY",
      amount: BigInt(50000),
      currency: "INR",
      appointmentId: "appt-1",
      isMockPayment: false,
    });
    const res = await replayByIdempotencyKey("user-1", "ck_abc12345");
    const body = await res!.json();
    expect(body.reused).toBe(true);
    expect(body.skipPayment).toBe(true);
  });

  it("409s a terminal attempt so the client mints a fresh key", async () => {
    mockPaymentFindFirst.mockResolvedValue({
      paymentIntent: "order_x",
      paymentStatus: "FAILED",
      paymentGateway: "RAZORPAY",
      amount: BigInt(50000),
      currency: "INR",
      appointmentId: null,
      isMockPayment: false,
    });
    const res = await replayByIdempotencyKey("user-1", "ck_abc12345");
    expect(res!.status).toBe(409);
  });

  it("does not resume a Stripe PENDING attempt (hosted URL is not persisted)", async () => {
    mockPaymentFindFirst.mockResolvedValue({
      paymentIntent: "cs_test_x",
      paymentStatus: "PENDING",
      paymentGateway: "STRIPE",
      amount: BigInt(50000),
      currency: "INR",
      appointmentId: null,
      isMockPayment: false,
    });
    const res = await replayByIdempotencyKey("user-1", "ck_abc12345");
    expect(res!.status).toBe(409);
  });

  it("returns null for an unknown key (fresh attempt proceeds)", async () => {
    mockPaymentFindFirst.mockResolvedValue(null);
    await expect(
      replayByIdempotencyKey("user-1", "ck_unknown"),
    ).resolves.toBeNull();
  });
});
