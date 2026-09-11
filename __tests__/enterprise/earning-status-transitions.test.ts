/**
 * @jest-environment node
 */

/**
 * Issue #700 LED-2: PAID earnings may only transition to REFUNDED, and
 * REFUNDED is terminal. Any other transition silently rewrites history
 * on a row that has already triggered a bank transfer + TDS deduction.
 */

// Import directly from the standalone module so the test does not pull
// in earnings-service.ts' transitive Stream / Razorpay deps.
import {
  assertEarningStatusTransitionLegal,
  IllegalEarningStatusTransitionError,
} from "@/lib/payments/payouts/earning-status";
import { EarningStatus } from "@prisma/client";

describe("EarningStatus transition guard (#700 LED-2)", () => {
  it("PENDING → READY is allowed", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.PENDING, EarningStatus.READY),
    ).not.toThrow();
  });

  it("READY → PAID is allowed", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.READY, EarningStatus.PAID),
    ).not.toThrow();
  });

  it("PAID → REFUNDED is allowed (controlled refund path)", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.PAID, EarningStatus.REFUNDED),
    ).not.toThrow();
  });

  it("PAID → READY is rejected", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.PAID, EarningStatus.READY),
    ).toThrow(IllegalEarningStatusTransitionError);
  });

  it("PAID → PENDING is rejected", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.PAID, EarningStatus.PENDING),
    ).toThrow(IllegalEarningStatusTransitionError);
  });

  it("PAID → HELD is rejected", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.PAID, EarningStatus.HELD),
    ).toThrow(IllegalEarningStatusTransitionError);
  });

  it("REFUNDED is terminal — REFUNDED → anything is rejected", () => {
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.REFUNDED, EarningStatus.PAID),
    ).toThrow(IllegalEarningStatusTransitionError);
    expect(() =>
      assertEarningStatusTransitionLegal("e1", EarningStatus.REFUNDED, EarningStatus.READY),
    ).toThrow(IllegalEarningStatusTransitionError);
  });

  it("error carries from/to/earningsId for debugging", () => {
    try {
      assertEarningStatusTransitionLegal("e123", EarningStatus.PAID, EarningStatus.READY);
      fail("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalEarningStatusTransitionError);
      const typed = err as IllegalEarningStatusTransitionError;
      expect(typed.earningsId).toBe("e123");
      expect(typed.from).toBe(EarningStatus.PAID);
      expect(typed.to).toBe(EarningStatus.READY);
    }
  });
});
