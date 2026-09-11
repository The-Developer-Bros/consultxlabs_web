/**
 * @jest-environment node
 */

/**
 * Unified reversal engine dispatch (#776 §C / ARCH #4). Asserts the front door
 * routes each source kind correctly and that CLASS_MULTI fans a single logical
 * refund across child payments proportionally (the genuinely-new capability —
 * consolidated CLASS purchases have no single paymentId). The deep booking
 * cascade is mocked; it's tested in its own suite.
 */

import { applyReversal } from "@/lib/payments/operations/reversal-engine";
import { applyRefundCascade } from "../../lib/payments/operations/refund";

jest.mock("../../lib/payments/operations/refund", () => ({
  applyRefundCascade: jest.fn().mockResolvedValue({
    legsReversed: 1,
    consultantEarningsReversed: 1,
    organizationEarningsReversed: 0,
    clawbackInitiated: false,
  }),
}));

const mockedCascade = applyRefundCascade as jest.MockedFunction<
  typeof applyRefundCascade
>;

beforeEach(() => mockedCascade.mockClear());

describe("applyReversal — BOOKING", () => {
  it("delegates to applyRefundCascade with the payment id", async () => {
    const tx = {} as never;
    const res = await applyReversal(tx, {
      source: { kind: "BOOKING", paymentId: "pay-1" },
      amountPaise: 5000,
      reason: "test",
      refundId: "ref-1",
    });
    expect(res.kind).toBe("BOOKING");
    expect(res.cascades).toHaveLength(1);
    expect(mockedCascade).toHaveBeenCalledTimes(1);
    expect(mockedCascade).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ paymentId: "pay-1", amountPaise: 5000 }),
    );
  });
});

describe("applyReversal — CLASS_MULTI", () => {
  function mockTx(payments: Array<{ id: string; amount: number }>) {
    return {
      payment: {
        findMany: jest.fn().mockResolvedValue(
          payments.map((p) => ({
            id: p.id,
            amount: p.amount,
            currency: "INR",
            paymentGateway: "RAZORPAY",
            // #781 §C — the reversal must copy these onto each child refund.
            displayCurrencyAtCheckout: "USD",
            exchangeRateAtCheckout: 83,
          })),
        ),
      },
      refund: {
        create: jest
          .fn()
          .mockImplementation(async ({ data }) => ({ id: `cn-${data.paymentId}` })),
        update: jest.fn().mockResolvedValue({}),
      },
    };
  }

  it("fans the refund across children proportionally; last absorbs remainder", async () => {
    // Two equal payments, total 100, refund 51 → 25 + 26 (last absorbs +1).
    const tx = mockTx([
      { id: "p1", amount: 50 },
      { id: "p2", amount: 50 },
    ]);
    const res = await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
      amountPaise: 51,
      reason: "class refund",
      refundId: "parent-ref",
    });

    expect(res.kind).toBe("CLASS_MULTI");
    expect(mockedCascade).toHaveBeenCalledTimes(2);
    const shares = mockedCascade.mock.calls.map((c) => c[1].amountPaise).sort();
    expect(shares).toEqual([25, 26]);
    // Each child got its own Refund row created + marked SUCCEEDED.
    expect(tx.refund.create).toHaveBeenCalledTimes(2);
    expect(tx.refund.update).toHaveBeenCalledTimes(2);
    // #781 §C — each child refund carries the parent payment's FX snapshot.
    expect(tx.refund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          displayCurrency: "USD",
          exchangeRateAtRefund: 83,
        }),
      }),
    );
  });

  it("never lets a child's share exceed its own amount (remainder distribution)", async () => {
    // Pathological: three ₹0.01 children, refund 2 paise. A naive
    // "last absorbs remainder" would push the last child to 2 > its amount 1
    // and crash applyRefundCascade's refundable guard. The distribution caps
    // each child at its own amount.
    const tx = mockTx([
      { id: "p1", amount: 1 },
      { id: "p2", amount: 1 },
      { id: "p3", amount: 1 },
    ]);
    await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2", "p3"] },
      amountPaise: 2,
      reason: "r",
      refundId: "ref",
    });
    const shares = mockedCascade.mock.calls.map((c) => c[1].amountPaise);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(2);
    expect(Math.max(...shares)).toBeLessThanOrEqual(1);
    // Third child's share nets to 0 → skipped.
    expect(mockedCascade).toHaveBeenCalledTimes(2);
  });

  it("throws fast on an over-refund (amount > class total) without touching children", async () => {
    const tx = mockTx([
      { id: "p1", amount: 100 },
      { id: "p2", amount: 100 },
    ]);
    await expect(
      applyReversal(tx as never, {
        source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
        amountPaise: 250,
        reason: "r",
        refundId: "ref",
      }),
    ).rejects.toThrow(/exceeds class total/);
    expect(mockedCascade).not.toHaveBeenCalled();
    expect(tx.refund.create).not.toHaveBeenCalled();
  });

  it("skips zero-share children", async () => {
    const tx = mockTx([
      { id: "p1", amount: 100 },
      { id: "p2", amount: 0 },
    ]);
    await applyReversal(tx as never, {
      source: { kind: "CLASS_MULTI", paymentIds: ["p1", "p2"] },
      amountPaise: 100,
      reason: "r",
      refundId: "ref",
    });
    // p2 (amount 0) gets share 0 → no cascade for it.
    expect(mockedCascade).toHaveBeenCalledTimes(1);
    expect(mockedCascade.mock.calls[0][1].amountPaise).toBe(100);
  });
});
