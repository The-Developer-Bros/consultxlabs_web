/**
 * @jest-environment node
 */

/**
 * #1437 — the org WALLET/INVOICE/LICENSE rail (and zero-amount/mock)
 * confirms /api/checkout synchronously with a synthetic id and no gateway
 * order, but RazorpayCheckout/StripeCheckout still called razorpay.open()
 * on it: a 400 from Razorpay's preferences call surfaced as "Payment
 * Failed" over a booking that had already succeeded.
 *
 * checkoutNeedsGateway is the one place both gateway components now make
 * that decision, so pinning it pins the fix for all four checkout pages.
 */

import { checkoutNeedsGateway } from "@/app/checkout/plans/utils";

describe("checkoutNeedsGateway", () => {
  it("says no gateway is needed for the org WALLET-rail synchronous-success response", () => {
    // Shape handleCheckout returns for isOrgSponsoredPayment (WALLET/
    // INVOICE/LICENSE): success server-side, synthetic org_wallet_ id, no
    // client secret — skipPayment is the flag carrying that home.
    const walletResponse = {
      success: true,
      paymentIntent: {
        id: "org_wallet_1730000000000_ab12cd34",
        client_secret: null,
      },
      skipPayment: true,
      isMockPayment: false,
      isZeroAmountPayment: false,
    };
    expect(checkoutNeedsGateway(walletResponse)).toBe(false);
  });

  it("says no gateway is needed for zero-amount and mock responses", () => {
    expect(checkoutNeedsGateway({ isZeroAmountPayment: true })).toBe(false);
    expect(checkoutNeedsGateway({ skipPayment: true })).toBe(false);
  });

  it("says the gateway is needed for a real pending payment", () => {
    const realGatewayResponse = {
      success: true,
      paymentIntent: { id: "order_abc123", client_secret: "secret" },
      skipPayment: false,
      isMockPayment: false,
      isZeroAmountPayment: false,
    };
    expect(checkoutNeedsGateway(realGatewayResponse)).toBe(true);
  });
});
