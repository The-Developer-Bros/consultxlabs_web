/**
 * @jest-environment node
 */

/**
 * Issue #675 + #687: governance helpers — verifiedAt gating, default
 * INVOICE credit limit.
 */

import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
  getInvoiceCreditLimitPaise,
  hasVerifiedDomain,
} from "@/lib/enterprise/governance";

describe("UNVERIFIED_ORG_SEAT_CAP", () => {
  it("is a small positive number; allows founding team but blocks bulk", () => {
    expect(UNVERIFIED_ORG_SEAT_CAP).toBeGreaterThan(0);
    expect(UNVERIFIED_ORG_SEAT_CAP).toBeLessThanOrEqual(10);
  });
});

describe("getInvoiceCreditLimitPaise", () => {
  const original = process.env.MAX_INVOICE_BOOKING_PAISE;
  afterEach(() => {
    if (original === undefined) delete process.env.MAX_INVOICE_BOOKING_PAISE;
    else process.env.MAX_INVOICE_BOOKING_PAISE = original;
  });

  it("falls back to ₹50,000 when env not set", () => {
    delete process.env.MAX_INVOICE_BOOKING_PAISE;
    expect(getInvoiceCreditLimitPaise()).toBe(50_000_00);
  });

  it("respects MAX_INVOICE_BOOKING_PAISE env override", () => {
    process.env.MAX_INVOICE_BOOKING_PAISE = "1000000"; // ₹10,000
    expect(getInvoiceCreditLimitPaise()).toBe(1_000_000);
  });

  it("ignores non-positive env values and falls back to default", () => {
    process.env.MAX_INVOICE_BOOKING_PAISE = "0";
    expect(getInvoiceCreditLimitPaise()).toBe(50_000_00);
    process.env.MAX_INVOICE_BOOKING_PAISE = "-100";
    expect(getInvoiceCreditLimitPaise()).toBe(50_000_00);
  });

  it("ignores garbage env values", () => {
    process.env.MAX_INVOICE_BOOKING_PAISE = "not-a-number";
    expect(getInvoiceCreditLimitPaise()).toBe(50_000_00);
  });
});

describe("hasVerifiedDomain", () => {
  function makeDb(verifiedClaim: { id: string } | null) {
    return {
      orgDomainClaim: {
        findFirst: jest.fn().mockResolvedValue(verifiedClaim),
      },
    };
  }

  it("returns true when at least one claim has verifiedAt!=null", async () => {
    const db = makeDb({ id: "c1" });
    const result = await hasVerifiedDomain(db as never, "org-1");
    expect(result).toBe(true);
    expect(db.orgDomainClaim.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        verifiedAt: { not: null },
      },
      select: { id: true },
    });
  });

  it("returns false when no claim is verified", async () => {
    const db = makeDb(null);
    const result = await hasVerifiedDomain(db as never, "org-1");
    expect(result).toBe(false);
  });
});

describe("DomainVerificationRequiredError", () => {
  it("carries the feature label + 403 + stable code", () => {
    const err = new DomainVerificationRequiredError("SSO");
    expect(err.feature).toBe("SSO");
    expect(err.code).toBe("DOMAIN_VERIFICATION_REQUIRED");
    expect(err.httpStatus).toBe(403);
  });
});
