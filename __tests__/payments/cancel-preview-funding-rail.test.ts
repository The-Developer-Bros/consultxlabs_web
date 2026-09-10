/**
 * @jest-environment node
 */

/**
 * The cancellation quote has to name the rail the money comes back on.
 *
 * The preview derived a single boolean, `creditFunded`, from the `free_`
 * prefix and had no `org_` branch at all. So a learner whose seat was funded
 * by their organisation's wallet, invoice accrual or licence was shown the
 * card sentence — "refunds reach your original payment method in 5–7 working
 * days" — about a card nobody ever charged, for money that was going back to
 * the org's balance instead.
 *
 * `fundingRailForIntent` is the one derivation both the quote and the charge
 * read, so the three prefixes are pinned here against the same predicates
 * `refundBookingPayment` branches on.
 */

import {
  fundingRailForIntent,
  isFreeCreditIntent,
  isInternalFundedIntent,
} from "../../lib/payments/operations/booking-refund";

describe("fundingRailForIntent", () => {
  it("reads an org-funded intent as the INTERNAL rail", () => {
    for (const intent of [
      "org_wallet_abc",
      "org_invoice_abc",
      "org_license_abc",
    ]) {
      expect(fundingRailForIntent(intent)).toBe("INTERNAL");
      // Same predicate the refund front door branches on — if these ever
      // disagree, the quote and the charge describe different rails.
      expect(isInternalFundedIntent(intent)).toBe(true);
    }
  });

  it("reads a fully credit-funded intent as the CREDITS rail", () => {
    expect(fundingRailForIntent("free_abc")).toBe("CREDITS");
    expect(isFreeCreditIntent("free_abc")).toBe(true);
  });

  it("reads every gateway intent shape as the GATEWAY rail", () => {
    for (const intent of ["pi_abc", "cs_abc", "order_abc", "pay_abc"]) {
      expect(fundingRailForIntent(intent)).toBe("GATEWAY");
    }
  });

  it("falls back to GATEWAY when there is no payment to read", () => {
    // An unpaid booking quotes zero either way; guessing INTERNAL here would
    // promise an org balance restoration that no ledger row backs.
    expect(fundingRailForIntent(null)).toBe("GATEWAY");
    expect(fundingRailForIntent(undefined)).toBe("GATEWAY");
  });
});
