/**
 * @jest-environment node
 */

/**
 * Issue #717 regression — `normalizeRazorpayContact` must reject
 * repeated-digit phone strings (e.g. "9999999999") because Razorpay's
 * test-mode gateway rejects them as "Invalid mobile number" and the
 * user sees an opaque modal failure. Catching here lets the caller
 * (WalletTab and similar) prompt the user to set a real phone before
 * the checkout opens.
 *
 * E.164 validation is otherwise unchanged: optional leading "+", 1-9
 * leading digit, 10-15 digits total.
 */

import {
  buildRazorpayPrefill,
  normalizeRazorpayContact,
} from "@/lib/payments/razorpay-prefill";

describe("normalizeRazorpayContact", () => {
  describe("happy paths", () => {
    it("accepts a 10-digit Indian mobile", () => {
      expect(normalizeRazorpayContact("9876543210")).toBe("9876543210");
    });

    it("accepts E.164 with leading +", () => {
      expect(normalizeRazorpayContact("+919876543210")).toBe("+919876543210");
    });

    it("strips spaces, hyphens, and parentheses", () => {
      expect(normalizeRazorpayContact("+91 (987) 654-3210")).toBe(
        "+919876543210",
      );
    });

    it("accepts a 15-digit international number (E.164 max)", () => {
      expect(normalizeRazorpayContact("+123456789012345")).toBe(
        "+123456789012345",
      );
    });
  });

  describe("rejects repeated-digit numbers (#717)", () => {
    it("rejects 9999999999 (the canonical test-mode failure)", () => {
      expect(normalizeRazorpayContact("9999999999")).toBeNull();
    });

    it("rejects 1111111111", () => {
      expect(normalizeRazorpayContact("1111111111")).toBeNull();
    });

    it("rejects +919999999999 (with leading +)", () => {
      expect(normalizeRazorpayContact("+919999999999")).toBeNull();
    });

    it("rejects after stripping formatting", () => {
      // After strip, this collapses to "9999999999" and must reject.
      expect(normalizeRazorpayContact("(999) 999-9999")).toBeNull();
    });

    it("does NOT reject a number with mostly-repeating digits but at least one variation", () => {
      // 9876543210 has all distinct digits — must pass. Boundary check
      // ensures the repeated-digit guard doesn't over-match.
      expect(normalizeRazorpayContact("9876543210")).toBe("9876543210");
    });
  });

  describe("E.164 baseline rejections (unchanged)", () => {
    it("rejects null/undefined/empty", () => {
      expect(normalizeRazorpayContact(null)).toBeNull();
      expect(normalizeRazorpayContact(undefined)).toBeNull();
      expect(normalizeRazorpayContact("")).toBeNull();
    });

    it("rejects too-short numbers (< 10 digits)", () => {
      expect(normalizeRazorpayContact("12345")).toBeNull();
    });

    it("rejects too-long numbers (> 15 digits)", () => {
      expect(normalizeRazorpayContact("1234567890123456")).toBeNull();
    });

    it("rejects numbers with a leading 0", () => {
      expect(normalizeRazorpayContact("0123456789")).toBeNull();
    });

    it("rejects alphabetical input", () => {
      expect(normalizeRazorpayContact("hello-world")).toBeNull();
    });
  });
});

describe("buildRazorpayPrefill", () => {
  it("includes contact when phone passes normalisation", () => {
    const prefill = buildRazorpayPrefill({
      name: "Alice",
      email: "alice@example.com",
      phone: "+919876543210",
    });
    expect(prefill).toEqual({
      name: "Alice",
      email: "alice@example.com",
      contact: "+919876543210",
    });
  });

  it("omits contact when phone fails normalisation (#717 repeated digits)", () => {
    const prefill = buildRazorpayPrefill({
      name: "Alice",
      email: "alice@example.com",
      phone: "9999999999",
    });
    // Omitted entirely so Razorpay falls back to its own guess instead
    // of receiving an invalid value.
    expect(prefill).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("omits empty fields", () => {
    const prefill = buildRazorpayPrefill({
      name: null,
      email: "",
      phone: undefined,
    });
    expect(prefill).toEqual({});
  });
});
