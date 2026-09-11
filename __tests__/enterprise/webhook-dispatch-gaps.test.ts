/**
 * @jest-environment node
 */

/**
 * Regression coverage for the webhook dispatch gaps found in the #789 audit.
 *
 * Each block asserts the CORRECT routing. Before the dispatch-switch fixes in
 * razorpay-dispatch.ts these assertions fail (the events fall through to the
 * `default` "unhandled" branch and the handler is never called); after the fix
 * they pass. The handlers themselves are mocked so we are testing routing only.
 */

import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

const handleRazorpayPayoutWebhook = jest.fn().mockResolvedValue(undefined);
const handleDisputeUpdated = jest.fn().mockResolvedValue(undefined);

jest.mock("../../app/api/webhooks/utils", () => ({
  __esModule: true,
  handlePaymentFailure: jest.fn(),
  handlePaymentSuccess: jest.fn(),
  handleOrgPaymentSuccess: jest.fn(),
  handleOrgPaymentFailure: jest.fn(),
  handleRefundCreated: jest.fn(),
  handleDisputeCreated: jest.fn(),
  handleDisputeUpdated: (...args: unknown[]) => handleDisputeUpdated(...args),
  markWebhookEventProcessed: jest.fn().mockResolvedValue(undefined),
  handleRazorpayPayoutWebhook: (...args: unknown[]) =>
    handleRazorpayPayoutWebhook(...args),
}));

jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  __esModule: true,
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

function payoutEnvelope(status: string) {
  return {
    event: `payout.${status}`,
    payload: { payout: { entity: { id: "pout_test_1", status } } },
  };
}

function disputeEnvelope(suffix: string, status: string) {
  return {
    event: `payment.dispute.${suffix}`,
    payload: { dispute: { entity: { id: "disp_test_1", status } } },
  };
}

describe("RazorpayX payout.failed routing", () => {
  it("routes payout.failed to the payout reconciler (not the default drop)", async () => {
    await processRazorpayWebhookEvent(
      payoutEnvelope("failed") as never,
      "payout.failed",
      "payout.failed:pout_test_1",
    );
    expect(handleRazorpayPayoutWebhook).toHaveBeenCalledWith(
      "payout.failed",
      expect.objectContaining({ id: "pout_test_1", status: "failed" }),
    );
  });
});

describe("dispute lifecycle event routing", () => {
  it("routes payment.dispute.under_review to handleDisputeUpdated", async () => {
    await processRazorpayWebhookEvent(
      disputeEnvelope("under_review", "under_review") as never,
      "payment.dispute.under_review",
      "payment.dispute.under_review:disp_test_1",
    );
    expect(handleDisputeUpdated).toHaveBeenCalledWith(
      "disp_test_1",
      "under_review",
      null,
    );
  });

  it("routes payment.dispute.action_required to handleDisputeUpdated", async () => {
    await processRazorpayWebhookEvent(
      disputeEnvelope("action_required", "action_required") as never,
      "payment.dispute.action_required",
      "payment.dispute.action_required:disp_test_1",
    );
    expect(handleDisputeUpdated).toHaveBeenCalledWith(
      "disp_test_1",
      "action_required",
      null,
    );
  });
});
