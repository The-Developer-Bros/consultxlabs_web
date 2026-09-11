/**
 * @jest-environment node
 */

/**
 * #1437 — Razorpay caps an order's `notes` at 15 keys and 256 characters per
 * value, and rejects the order outright past either bound. The buyer's booking
 * note was forwarded verbatim with no length bound anywhere in the path, so a
 * long note did not degrade the payload — it made the order impossible to
 * create, which a buyer experiences as being unable to pay at all.
 *
 * This pin covers both halves of the fix: the schema refuses the note at the
 * request boundary with a message the buyer can act on, and the metadata
 * builder truncates whatever still reaches it so the gateway call survives
 * even if a future caller bypasses the schema. The full note is never lost —
 * it is persisted on the Payment and Appointment rows either way.
 */

// Boundary mocks. `lib/payments/operations/checkout` transitively imports the
// auth stack through the payouts barrel, which is ESM-only under this Jest
// transform; none of it is exercised by a pure metadata builder.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));

jest.mock("../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(),
}));

jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  CHECKOUT_WAIT_RETRY_CONFIG: { retryCount: 5 },
  CHECKOUT_LOCK_TTL_MS: {},
  EventFullError: class extends Error {},
  lockSlotBooking: jest.fn(),
  unlockSlotBooking: jest.fn(),
  lockEventCheckout: jest.fn(),
  unlockEventCheckout: jest.fn(),
  lockConsulteeBooking: jest.fn(),
  unlockConsulteeBooking: jest.fn(),
  extendLock: jest.fn(),
  extendSlotInterval: jest.fn(),
}));

import { checkoutSchema, type CheckoutInput } from "../../schemas/checkout";
import { buildPaymentMetadata } from "../../lib/payments/operations/checkout";

const HOUR_MS = 60 * 60 * 1000;
const LONG_NOTE = "a".repeat(300);

function consultationInput(notes: string): CheckoutInput {
  const startsAt = new Date(Date.now() + 48 * HOUR_MS);
  const endsAt = new Date(startsAt.getTime() + HOUR_MS);
  return {
    appointmentType: "CONSULTATION",
    planId: "plan-1",
    paymentGateway: "RAZORPAY",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    slotOfAvailabilityWeeklyId: "weekly-1",
    notes,
  } as CheckoutInput;
}

describe("#1437 gateway note limits", () => {
  it("refuses a 300-character booking note at the request boundary", () => {
    const parsed = checkoutSchema.safeParse(consultationInput(LONG_NOTE));

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "256 characters or fewer",
    );
  });

  it("accepts a note exactly at the limit", () => {
    expect(
      checkoutSchema.safeParse(consultationInput("a".repeat(256))).success,
    ).toBe(true);
  });

  it("truncates the note in the gateway payload and stays under 15 keys", () => {
    const metadata = buildPaymentMetadata(
      { ...consultationInput(LONG_NOTE), eventId: "event-1" } as CheckoutInput,
      "user-1",
      { organizationId: "org-1", fundingSource: "WALLET" },
    );

    expect(metadata.notes).toHaveLength(256);
    expect(LONG_NOTE.startsWith(metadata.notes)).toBe(true);
    // The org-sponsored event shape is the widest one this builder emits; it
    // sat at exactly Razorpay's 15-key ceiling before `discountCode` was cut.
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(14);
  });

  /**
   * #1462 — the same payload, seen from the webhook's side. A scheduling-period
   * subscription has no slot times, and sending them as `""` failed
   * `z.string().datetime().optional()` on every capture, stranding the sale as
   * REQUIRES_MANUAL_RECOVERY with the buyer already charged.
   */
  it("omits every empty optional field instead of sending it as an empty string", () => {
    const metadata = buildPaymentMetadata(
      {
        appointmentType: "SUBSCRIPTION",
        planId: "plan-1",
        paymentGateway: "RAZORPAY",
        schedulingPeriodStartsAt: "2026-09-01T00:00:00.000Z",
        schedulingPeriodEndsAt: "2026-12-01T00:00:00.000Z",
      } as unknown as CheckoutInput,
      "user-1",
    );

    expect(metadata).not.toHaveProperty("startsAt");
    expect(metadata).not.toHaveProperty("endsAt");
    expect(metadata).not.toHaveProperty("slotOfAvailabilityWeeklyId");
    expect(metadata).not.toHaveProperty("slotOfAvailabilityCustomId");
    expect(metadata).not.toHaveProperty("notes");
    expect(Object.values(metadata)).not.toContain("");
    // What the sale actually needs still travels.
    expect(metadata.schedulingPeriodStartsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(metadata.schedulingPeriodEndsAt).toBe("2026-12-01T00:00:00.000Z");
  });
});
