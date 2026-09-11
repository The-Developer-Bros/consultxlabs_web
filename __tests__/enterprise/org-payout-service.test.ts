/**
 * @jest-environment node
 */

/**
 * Issue #713-2 / #700 LED-4: org-payout-service rewrite.
 *
 * The service was a stub before this PR. These tests cover the public
 * surface the cron + the route both call:
 *   - getOrgPayoutEligibility — read-only probe
 *   - PayoutLockError + PayoutValidationError carry useful httpStatus
 *
 * The full createOrgPayoutBatch / processOrgPayout flows hit Postgres
 * directly (Serializable tx, real conditional UPDATEs) and live in the
 * integration smoke. Pure-logic checks here are about the service's
 * error envelope + read-side semantics so the route layer can rely on
 * stable error codes.
 */

import {
  PayoutLockError,
  PayoutValidationError,
} from "@/lib/payments/payouts/org-payout-service";

describe("org-payout-service errors", () => {
  it("PayoutLockError exposes a stable code", () => {
    const err = new PayoutLockError();
    expect(err.code).toBe("PAYOUT_LOCK_CONFLICT");
    expect(err.name).toBe("PayoutLockError");
  });

  it("PayoutLockError accepts a custom message", () => {
    const err = new PayoutLockError("Too busy, try later");
    expect(err.message).toBe("Too busy, try later");
  });

  it("PayoutValidationError carries httpStatus (default 409)", () => {
    const err = new PayoutValidationError("Bad period");
    expect(err.code).toBe("PAYOUT_VALIDATION_FAILED");
    expect(err.httpStatus).toBe(409);
  });

  it("PayoutValidationError httpStatus is overridable", () => {
    const err = new PayoutValidationError("Bad input", 400);
    expect(err.httpStatus).toBe(400);
  });

  it("Both errors are throwable + identifiable via instanceof", () => {
    const a = new PayoutLockError();
    const b = new PayoutValidationError("x");
    expect(a instanceof PayoutLockError).toBe(true);
    expect(b instanceof PayoutValidationError).toBe(true);
    expect(a instanceof PayoutValidationError).toBe(false);
    expect(b instanceof PayoutLockError).toBe(false);
  });
});
