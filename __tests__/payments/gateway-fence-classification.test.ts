/**
 * #1351 — a fenced or stub gateway must reach the caller as a business
 * rejection. Before this pin the guard's error matched no message pattern, so
 * `POST /api/checkout` with a disabled rail answered 500 UNKNOWN_ERROR and
 * Sentry recorded it as an unexpected exception.
 */
import {
  classifyError,
  ErrorTypes,
} from "@/lib/errors/classification/payment-error-classification";
import { getErrorToast } from "@/lib/errors/mapping/payment-error-toast-map";
import {
  DisabledGatewayError,
  UnsupportedGatewayError,
} from "@/lib/payments/validation/gateway-guards";
import { DomainVerificationRequiredError } from "@/lib/enterprise/governance";
import { WalletInsufficientFundsError } from "@/lib/api/organizations/wallet";

describe("gateway fence classification", () => {
  it("classifies a disabled gateway as a 422 business rejection", () => {
    const classified = classifyError(
      new DisabledGatewayError("STRIPE", "route a checkout"),
    );

    expect(classified.errorType).toBe(ErrorTypes.GATEWAY_UNAVAILABLE);
    expect(classified.isBusinessError).toBe(true);
    expect(classified.httpStatus).toBe(422);
  });

  it("classifies a stub gateway the same way", () => {
    const classified = classifyError(
      new UnsupportedGatewayError("PAYPAL", "issue a refund"),
    );

    expect(classified.errorType).toBe(ErrorTypes.GATEWAY_UNAVAILABLE);
    expect(classified.httpStatus).toBe(422);
  });

  it("gives the buyer a payment-method toast, not the env flag", () => {
    const toast = getErrorToast(ErrorTypes.GATEWAY_UNAVAILABLE);

    expect(toast.title).toBe("This payment method is not available");
    expect(toast.description).not.toContain("STRIPE_ENABLED");
  });

  // #1426 — WALLET_FROZEN, CONSENT_REQUIRED and CONSENT_WITHDRAWN are the
  // codes checkout.ts already throws (lib/payments/operations/checkout.ts:881,
  // :1556, :2538) but BUSINESS_ERROR_CODES only carried GATEWAY_DISABLED and
  // UNSUPPORTED_GATEWAY, so these three fell through to the 500 UNKNOWN path.
  it.each(["WALLET_FROZEN", "CONSENT_REQUIRED", "CONSENT_WITHDRAWN"])(
    "classifies %s as a business rejection with an actionable toast",
    (code) => {
      const classified = classifyError(
        Object.assign(new Error("refused"), { code }),
      );

      expect(classified.isBusinessError).toBe(true);
      expect(classified.httpStatus).not.toBe(500);

      const toast = getErrorToast(classified.errorType);
      expect(toast.title).not.toBe("Something Went Wrong");
      expect(toast.description).toBeTruthy();
    },
  );

  // #1407 — invoice funding's verified-domain guard throws its own typed 403,
  // and with no BUSINESS_ERROR_CODES row it answered 500 UNKNOWN_ERROR: the
  // buyer saw "something went wrong" for a condition their admin can fix.
  it("classifies the verified-domain guard as an actionable 403", () => {
    const classified = classifyError(
      new DomainVerificationRequiredError("INVOICE_FUNDING"),
    );

    expect(classified.errorType).toBe(ErrorTypes.DOMAIN_VERIFICATION_REQUIRED);
    expect(classified.isBusinessError).toBe(true);
    expect(classified.httpStatus).toBe(403);

    const toast = getErrorToast(classified.errorType);
    expect(toast.title).toBe("Domain Verification Required");
    expect(toast.description).toBeTruthy();
  });

  // #1458 — the overage settlement throws PROGRAM_CAP_EXHAUSTED as a 402 with
  // copy the buyer can act on, but the checkout catch rewrote it to "Failed to
  // record payment information" and the classifier answered 500 UNKNOWN_ERROR.
  it("classifies PROGRAM_CAP_EXHAUSTED as a 402 with its own toast", () => {
    const classified = classifyError(
      Object.assign(new Error("cycle ceiling reached"), {
        httpStatus: 402,
        code: "PROGRAM_CAP_EXHAUSTED",
      }),
    );

    expect(classified.errorType).toBe(ErrorTypes.PROGRAM_CAP_EXHAUSTED);
    expect(classified.isBusinessError).toBe(true);
    expect(classified.httpStatus).toBe(402);

    const toast = getErrorToast(classified.errorType);
    expect(toast.title).not.toBe("Something Went Wrong");
    expect(toast.description).toContain("programme budget");
  });

  it("classifies the other checkout-transaction refusals off their codes", () => {
    expect(
      classifyError(
        Object.assign(new Error("session cap"), {
          code: "PROGRAM_SESSION_CAP_REACHED",
        }),
      ).httpStatus,
    ).toBe(402);
    expect(
      classifyError(
        Object.assign(new Error("member overage"), {
          code: "OVERAGE_CHARGE_MEMBER_UNSUPPORTED",
        }),
      ).httpStatus,
    ).toBe(409);
    expect(
      classifyError(
        Object.assign(new Error("funding"), {
          code: "OVERAGE_UNSUPPORTED_FUNDING",
        }),
      ).httpStatus,
    ).toBe(409);
  });

  // #1467 — a lapsed contract and a dunning suspension are org entitlement
  // states the member's admin can clear. Both threw bare Errors, so the
  // message-only fallback answered 500 UNKNOWN_ERROR on a routine refusal.
  it.each([
    ["PROGRAM_ASSIGNMENT_INACTIVE", 409],
    ["BILLING_SUSPENDED_DUNNING", 402],
  ])("classifies %s as a business rejection with status %i", (code, status) => {
    const classified = classifyError(
      Object.assign(new Error("refused"), { code }),
    );

    expect(classified.isBusinessError).toBe(true);
    expect(classified.httpStatus).toBe(status);

    const toast = getErrorToast(classified.errorType);
    expect(toast.title).not.toBe("Something Went Wrong");
    expect(toast.description).toContain("admin");
  });

  // #1477 — `WalletInsufficientFundsError` carried no code at all, so an org
  // that had simply spent its wallet down got 500 "Something Went Wrong" and a
  // Sentry incident for a refusal only a top-up can clear.
  it("classifies an overdrawn org wallet as a 402 pointing at the billing admin", () => {
    const classified = classifyError(
      new WalletInsufficientFundsError("ba_1", 250000),
    );

    expect(classified.errorType).toBe(ErrorTypes.WALLET_INSUFFICIENT_FUNDS);
    expect(classified.isBusinessError).toBe(true);
    expect(classified.httpStatus).toBe(402);

    const toast = getErrorToast(classified.errorType);
    expect(toast.title).not.toBe("Something Went Wrong");
    expect(toast.description).toContain("billing admin");
  });
});
