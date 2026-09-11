/**
 * @jest-environment node
 */

/**
 * #689 — recording/resource access keys off SUCCEEDED payments, but a refund
 * never flips paymentStatus (the enum has no REFUNDED). These pin the shared
 * refund-aware entitlement: a fully-refunded buyer loses access, a partially
 * refunded one keeps it, and FAILED/CANCELLED refunds don't count.
 */

import { RefundStatus } from "@prisma/client";
import {
  isPaymentEntitled,
  refundedPaise,
} from "@/lib/payments/utils/refund-balance";

describe("refundedPaise", () => {
  it("counts SUCCEEDED and PENDING refunds, ignores FAILED/CANCELLED", () => {
    expect(
      refundedPaise([
        { amountPaise: 300, status: RefundStatus.SUCCEEDED },
        { amountPaise: 200, status: RefundStatus.PENDING },
        { amountPaise: 999, status: RefundStatus.FAILED },
        { amountPaise: 999, status: RefundStatus.CANCELLED },
      ]),
    ).toBe(500);
  });

  it("is zero with no refunds", () => {
    expect(refundedPaise([])).toBe(0);
  });
});

describe("isPaymentEntitled", () => {
  it("keeps access with no refunds", () => {
    expect(isPaymentEntitled({ amount: 1000, refunds: [] })).toBe(true);
  });

  it("keeps access on a partial refund", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 400, status: RefundStatus.SUCCEEDED }],
      }),
    ).toBe(true);
  });

  it("revokes access once refunds cover the full amount", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 1000, status: RefundStatus.SUCCEEDED }],
      }),
    ).toBe(false);
  });

  it("revokes access when a refund is still PENDING but covers the amount", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 1000, status: RefundStatus.PENDING }],
      }),
    ).toBe(false);
  });

  it("keeps access when the only refund covering the amount FAILED", () => {
    expect(
      isPaymentEntitled({
        amount: 1000,
        refunds: [{ amountPaise: 1000, status: RefundStatus.FAILED }],
      }),
    ).toBe(true);
  });
});
