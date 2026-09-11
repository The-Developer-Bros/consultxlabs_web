/**
 * @jest-environment node
 */

/**
 * PR-3 (live payout submission) — RazorpayX webhook reconciler.
 *
 * Covers the dispatch logic in `handleRazorpayPayoutWebhook`
 * (app/api/webhooks/utils.ts):
 *
 *   - payout.processed → looks up OrganizationPayout by gatewayPayoutId,
 *     persists gatewayUtr, calls markOrgPayoutCompleted.
 *   - payout.failed   → calls markOrgPayoutFailed.
 *   - payout.reversed → calls markOrgPayoutReversed.
 *   - Orphan event (no OrganizationPayout AND no consultant Payout)
 *     → soft-skip (logged, no throw, no side effects).
 *
 * Webhook-level concerns we keep separate (covered by the route-level
 * integration test where the request crosses the HTTP boundary):
 *   - Signature verification (HMAC compare in route.ts).
 *   - WebhookEvent dedup (logWebhookEvent in route.ts).
 * The duplicate-skip and invalid-signature behaviours are exercised
 * end-to-end against the route in `__tests__/payments/razorpay-webhook
 * -duplicate-skip.test.ts` etc.; here we focus on the reconciler unit.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organizationPayout: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  handlePayoutWebhook: jest.fn().mockResolvedValue(undefined),
  refundEarnings: jest.fn(),
  markOrgPayoutCompleted: jest.fn().mockResolvedValue({
    wasNoOp: false,
    status: "COMPLETED",
  }),
  markOrgPayoutFailed: jest.fn().mockResolvedValue({
    wasNoOp: false,
    status: "FAILED",
  }),
  markOrgPayoutReversed: jest.fn().mockResolvedValue({
    wasNoOp: false,
    status: "FAILED",
  }),
}));

// Other utils.ts imports we don't exercise — stub minimally so the
// module load doesn't blow up.
jest.mock("../../lib/payments/core/stripe", () => ({ stripeClient: null }));
jest.mock("../../lib/payments/core/razorpay", () => ({ razorpayClient: null }));
jest.mock("../../lib/novu", () => ({
  notifyRefundProcessed: jest.fn(),
  notifyDisputeCreated: jest.fn(),
  notifyDisputeResolved: jest.fn(),
}));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgInvoicePaid: jest.fn(),
  notifyOrgWalletTopupConfirmed: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(),
}));
jest.mock("../../lib/api/organizations/wallet", () => ({
  confirmTopUp: jest.fn(),
  walletCredit: jest.fn(),
}));
jest.mock("../../lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/handlers", () => ({
  handlePaymentSuccess: jest.fn(),
  handlePaymentFailure: jest.fn(),
}));

import prisma from "@/lib/prisma";
import {
  handlePayoutWebhook,
  markOrgPayoutCompleted,
  markOrgPayoutFailed,
  markOrgPayoutReversed,
} from "@/lib/payments/payouts";
import { handleRazorpayPayoutWebhook } from "@/app/api/webhooks/utils";

const mockedPrisma = prisma as unknown as {
  organizationPayout: { findUnique: jest.Mock; update: jest.Mock };
};
const mockedHandlePayoutWebhook = handlePayoutWebhook as jest.Mock;
const mockedMarkCompleted = markOrgPayoutCompleted as jest.Mock;
const mockedMarkFailed = markOrgPayoutFailed as jest.Mock;
const mockedMarkReversed = markOrgPayoutReversed as jest.Mock;

const ORG_PAYOUT_ID = "op_internal_123";
const GATEWAY_PAYOUT_ID = "pout_NXXXX";
const ORG_ID = "org-1";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("handleRazorpayPayoutWebhook — OrganizationPayout reconciliation", () => {
  it("payout.processed → looks up by gatewayPayoutId, persists UTR, calls markOrgPayoutCompleted", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.processed", {
      id: GATEWAY_PAYOUT_ID,
      status: "processed",
      utr: "ABCDEF1234567890",
    });

    // Lookup uses the gateway id, not the internal id.
    expect(mockedPrisma.organizationPayout.findUnique).toHaveBeenCalledWith({
      where: { gatewayPayoutId: GATEWAY_PAYOUT_ID },
      select: { id: true, status: true, organizationId: true },
    });
    // UTR persisted before the state flip.
    expect(mockedPrisma.organizationPayout.update).toHaveBeenCalledWith({
      where: { id: ORG_PAYOUT_ID },
      data: { gatewayUtr: "ABCDEF1234567890" },
    });
    // markOrgPayoutCompleted called with the INTERNAL id, not the
    // gateway id (regression guard — the helper only knows internal ids).
    expect(mockedMarkCompleted).toHaveBeenCalledWith(ORG_PAYOUT_ID);
    // The B2C consultant path must NOT have been invoked.
    expect(mockedHandlePayoutWebhook).not.toHaveBeenCalled();
  });

  it("payout.processed without UTR → no gatewayUtr update, but still completes", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.processed", {
      id: GATEWAY_PAYOUT_ID,
      status: "processed",
      // No utr field
    });

    expect(mockedPrisma.organizationPayout.update).not.toHaveBeenCalled();
    expect(mockedMarkCompleted).toHaveBeenCalledWith(ORG_PAYOUT_ID);
  });

  it("payout.failed → calls markOrgPayoutFailed with failure reason", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.failed", {
      id: GATEWAY_PAYOUT_ID,
      status: "failed",
      failure_reason: "Insufficient bank balance",
    });

    expect(mockedMarkFailed).toHaveBeenCalledWith(
      ORG_PAYOUT_ID,
      "Insufficient bank balance",
    );
    expect(mockedMarkCompleted).not.toHaveBeenCalled();
    expect(mockedMarkReversed).not.toHaveBeenCalled();
    expect(mockedHandlePayoutWebhook).not.toHaveBeenCalled();
  });

  it("payout.failed without failure_reason → falls back to generic reason", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.failed", {
      id: GATEWAY_PAYOUT_ID,
      status: "failed",
    });

    expect(mockedMarkFailed).toHaveBeenCalledWith(
      ORG_PAYOUT_ID,
      "RazorpayX failure",
    );
  });

  it("payout.reversed → calls markOrgPayoutReversed (distinct from failed)", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.reversed", {
      id: GATEWAY_PAYOUT_ID,
      status: "reversed",
      failure_reason: "Account closed",
    });

    expect(mockedMarkReversed).toHaveBeenCalledWith(
      ORG_PAYOUT_ID,
      "Account closed",
    );
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(mockedMarkCompleted).not.toHaveBeenCalled();
  });

  it("orphan event (gatewayPayoutId not on any OrganizationPayout) → falls through to consultant path; consultant lookup also returns nothing → silent no-op (returns 200 to prevent retry storm)", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue(null);

    // The consultant fallback (handlePayoutWebhook) is itself
    // soft-skipping when no Payout row matches — we mock it to
    // resolve undefined so the test explicitly captures the
    // "no throw" contract.
    mockedHandlePayoutWebhook.mockResolvedValue(undefined);

    await expect(
      handleRazorpayPayoutWebhook("payout.processed", {
        id: "pout_orphan",
        status: "processed",
        utr: "X",
      }),
    ).resolves.toBeUndefined();

    // Org helpers must NOT have been called.
    expect(mockedMarkCompleted).not.toHaveBeenCalled();
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(mockedMarkReversed).not.toHaveBeenCalled();
    // Consultant fallback was attempted (with mapped status + forwarded UTR).
    expect(mockedHandlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_orphan",
      "COMPLETED",
      undefined,
      "X",
    );
  });

  it("payout.queued (informational in-flight event for an org payout) → no state-change helpers invoked", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.queued", {
      id: GATEWAY_PAYOUT_ID,
      status: "queued",
    });

    expect(mockedMarkCompleted).not.toHaveBeenCalled();
    expect(mockedMarkFailed).not.toHaveBeenCalled();
    expect(mockedMarkReversed).not.toHaveBeenCalled();
    expect(mockedHandlePayoutWebhook).not.toHaveBeenCalled();
    // Also no UTR persistence on a non-terminal event.
    expect(mockedPrisma.organizationPayout.update).not.toHaveBeenCalled();
  });

  it("payout.rejected → routed to markOrgPayoutFailed (gateway never accepted)", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue({
      id: ORG_PAYOUT_ID,
      status: "PROCESSING",
      organizationId: ORG_ID,
    });

    await handleRazorpayPayoutWebhook("payout.rejected", {
      id: GATEWAY_PAYOUT_ID,
      status: "rejected",
      failure_reason: "Beneficiary blocked",
    });

    expect(mockedMarkFailed).toHaveBeenCalledWith(
      ORG_PAYOUT_ID,
      "Beneficiary blocked",
    );
  });

  // #1451 — `failed` was missing from the consultant status map, so a bank
  // failure fell through to the PENDING default and the payout stayed in
  // flight with its earnings BATCHED. FAILED is what un-batches them.
  it("consultant payout.failed → handlePayoutWebhook with FAILED, not the PENDING default", async () => {
    mockedPrisma.organizationPayout.findUnique.mockResolvedValue(null);

    await handleRazorpayPayoutWebhook("payout.failed", {
      id: "pout_consultant",
      status: "failed",
      failure_reason: "Insufficient bank balance",
    });

    expect(mockedHandlePayoutWebhook).toHaveBeenCalledWith(
      "RAZORPAY",
      "pout_consultant",
      "FAILED",
      "Insufficient bank balance",
      undefined,
    );
  });
});
