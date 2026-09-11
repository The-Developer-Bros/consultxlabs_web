/**
 * @jest-environment node
 */

/**
 * #776 §C — whole-event refund partition. Gateway/card seats MUST credit the
 * gateway (refundPayment); internal org-funded seats MUST reverse in-ledger
 * (one CLASS_MULTI reversal) — a card seat routed through the engine would
 * strand the customer's money. This asserts the partition + the member-overage
 * follow-up, with prisma / reversal-engine / refund mocked.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn() },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
  },
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("../../lib/payments/operations/reversal-engine", () => ({
  applyReversal: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: jest.fn(),
  RefundValidationError: class extends Error {
    code: string;
    constructor(m: string, c: string) {
      super(m);
      this.code = c;
    }
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: jest.fn().mockResolvedValue(undefined),
}));

import prisma from "../../lib/prisma";
import { applyReversal } from "../../lib/payments/operations/reversal-engine";
import { refundPayment } from "../../lib/payments/operations/refund";
import { refundWholeEventPayments } from "@/lib/payments/operations/event-refunds";

const findMany = (prisma as unknown as { payment: { findMany: jest.Mock } })
  .payment.findMany;
const applyReversalMock = applyReversal as jest.Mock;
const refundPayment_ = refundPayment as jest.Mock;

beforeEach(() => {
  findMany.mockReset();
  applyReversalMock.mockReset();
  refundPayment_.mockReset();
  refundPayment_.mockResolvedValue({
    refundId: "r1",
    amountRefundedPaise: 1000,
  });
  applyReversalMock.mockResolvedValue({
    kind: "CLASS_MULTI",
    cascades: [],
    childRefundIds: [],
    clawbackPosted: false,
  });
});

describe("refundWholeEventPayments — funding partition", () => {
  it("routes card/mock seats to refundPayment and org seats to CLASS_MULTI", async () => {
    findMany.mockResolvedValue([
      { id: "pay_card", amount: 1000, paymentIntent: "pay_abc" },
      { id: "p_mock", amount: 2000, paymentIntent: "cs_mock_1" },
      { id: "p_org1", amount: 3000, paymentIntent: "org_wallet_1" },
      { id: "p_org2", amount: 4000, paymentIntent: "org_invoice_2" },
    ]);

    const summary = await refundWholeEventPayments("class", "cls1", "cancel", "admin1");

    // Two gateway seats → two refundPayment calls; NEVER the org seats.
    const refundedIds = refundPayment_.mock.calls.map((c) => c[0].paymentId);
    expect(refundedIds).toEqual(expect.arrayContaining(["pay_card", "p_mock"]));
    expect(refundedIds).not.toContain("p_org1");
    expect(refundedIds).not.toContain("p_org2");

    // One CLASS_MULTI reversal covering EXACTLY the two org seats, full total.
    expect(applyReversalMock).toHaveBeenCalledTimes(1);
    const arg = applyReversalMock.mock.calls[0][1];
    expect(arg.source.kind).toBe("CLASS_MULTI");
    expect(arg.source.paymentIds).toEqual(["p_org1", "p_org2"]);
    expect(arg.amountPaise).toBe(7000);

    expect(summary.refundsIssued).toBe(2); // 2 gateway; org childRefundIds empty here
    expect(summary.failures).toHaveLength(0);
  });

  it("all-internal event never calls refundPayment for the seats", async () => {
    findMany.mockResolvedValue([
      { id: "p_org1", amount: 3000, paymentIntent: "org_license_1" },
    ]);
    applyReversalMock.mockResolvedValue({
      kind: "CLASS_MULTI",
      cascades: [{ memberOverageRefundDue: null }],
      childRefundIds: ["child1"],
      clawbackPosted: false,
    });

    const summary = await refundWholeEventPayments("webinar", "web1", "cancel", null);

    expect(refundPayment_).not.toHaveBeenCalled();
    expect(applyReversalMock).toHaveBeenCalledTimes(1);
    expect(summary.refundedPaise).toBe(3000);
    expect(summary.childRefundIds).toContain("child1");
  });

  it("issues a member-overage credit-back refund surfaced by the internal cascade", async () => {
    findMany.mockResolvedValue([
      { id: "p_org1", amount: 3000, paymentIntent: "org_wallet_1" },
    ]);
    applyReversalMock.mockResolvedValue({
      kind: "CLASS_MULTI",
      cascades: [{ memberOverageRefundDue: { overagePaymentId: "pay_side" } }],
      childRefundIds: ["child1"],
      clawbackPosted: false,
    });

    await refundWholeEventPayments("class", "cls1", "cancel", "admin1");

    // The side-payment (a gateway charge) is credited back via refundPayment.
    expect(refundPayment_).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay_side" }),
    );
  });

  it("captures a gateway refund failure without throwing", async () => {
    findMany.mockResolvedValue([
      { id: "pay_card", amount: 1000, paymentIntent: "pay_abc" },
    ]);
    refundPayment_.mockRejectedValueOnce(new Error("gateway down"));

    const summary = await refundWholeEventPayments("class", "cls1", "cancel", "a");
    expect(summary.failures).toEqual([
      { paymentId: "pay_card", error: "gateway down" },
    ]);
    expect(summary.refundsIssued).toBe(0);
  });

  it("no-ops on an event with no paid seats", async () => {
    findMany.mockResolvedValue([]);
    const summary = await refundWholeEventPayments("class", "cls1", "cancel", "a");
    expect(refundPayment_).not.toHaveBeenCalled();
    expect(applyReversalMock).not.toHaveBeenCalled();
    expect(summary.refundsIssued).toBe(0);
  });
});
