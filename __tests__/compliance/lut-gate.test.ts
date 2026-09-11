/**
 * @jest-environment node
 */

/**
 * #1230 — the platform-LUT gate on export zero-rating.
 *
 * Rule 96A / Form RFD-11: zero-rating an export without paying IGST requires
 * a LUT valid for the CURRENT financial year. Before this gate the platform
 * zero-rated on buyer country alone, accruing a retrospective 18% + interest
 * exposure on every foreign invoice. Both pricing surfaces (checkout
 * determineTax and invoicing deriveGstBreakdown) must fail closed together,
 * and flip to zero-rated together, from the same env signal.
 */

import { readPlatformLut, hasValidPlatformLut } from "@/lib/compliance/lut";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { determineTax } from "@/lib/payments/tax/tax-engine";

function setLut(number: string | null, validTill: string | null) {
  if (number) process.env.PLATFORM_LUT_NUMBER = number;
  else delete process.env.PLATFORM_LUT_NUMBER;
  if (validTill) process.env.PLATFORM_LUT_VALID_TILL = validTill;
  else delete process.env.PLATFORM_LUT_VALID_TILL;
}

afterEach(() => {
  setLut(null, null);
  // CR #1234 — the valid-LUT fixtures hard-code a FY2026-27 LUT; without a
  // frozen clock they start failing on 2027-04-01 when production's
  // new Date() outlives the fixture.
  jest.useRealTimers();
});

/** Pin "now" inside the fixture LUT's validity window for time-sensitive tests. */
function freezeInsideLutWindow() {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2027-03-31T12:00:00Z"));
}

describe("readPlatformLut / hasValidPlatformLut", () => {
  it("absent env ⇒ not present, not valid (fail-closed)", () => {
    const s = readPlatformLut(new Date("2026-08-23T00:00:00Z"));
    expect(s.present).toBe(false);
    expect(s.valid).toBe(false);
    expect(hasValidPlatformLut(new Date("2026-08-23T00:00:00Z"))).toBe(false);
  });

  it("number without validity date ⇒ present but never valid", () => {
    setLut("AD270326000001L/2627", null);
    const s = readPlatformLut(new Date("2026-08-23T00:00:00Z"));
    expect(s.present).toBe(false);
    expect(s.valid).toBe(false);
  });

  it("validity date is inclusive through INDIAN end-of-day (CR #1234)", () => {
    setLut("LUT/2627", "2027-03-31");
    freezeInsideLutWindow();
    // Last IST instant of the FY = 2027-03-31T18:29:59.999Z — covered...
    expect(hasValidPlatformLut(new Date("2027-03-31T18:29:59.999Z"))).toBe(
      true,
    );
    // ...and the first instant of April 1 IST (= 18:30:00Z) is not.
    expect(hasValidPlatformLut(new Date("2027-03-31T18:30:00Z"))).toBe(false);
  });

  it("rejects non-calendar-date values instead of guessing", () => {
    setLut("LUT/2627", "not-a-date");
    freezeInsideLutWindow();
    const s = readPlatformLut(new Date("2027-03-31T12:00:00Z"));
    expect(s.present).toBe(false);
    expect(s.valid).toBe(false);
  });

  it("rejects calendar-impossible dates that Date would silently normalize", () => {
    // CR #1234 r3 — "2027-02-30" normalizes to Mar 2; accepting it would let
    // malformed config enable zero-rating on a date nobody declared.
    setLut("LUT/2627", "2027-02-30");
    freezeInsideLutWindow();
    const s = readPlatformLut(new Date("2027-03-31T12:00:00Z"));
    expect(s.present).toBe(false);
    expect(s.valid).toBe(false);
  });
});

describe("deriveGstBreakdown export branch", () => {
  const base = {
    subtotalPaise: 100_000,
    supplierStateCode: "29",
    buyerStateCode: null as string | null,
    buyerGstin: null as string | null,
    buyerCountry: "US",
    hsnCode: "9982",
  };

  it("no LUT ⇒ full 18% IGST with EXPORT_NO_LUT_IGST reason", () => {
    setLut(null, null);
    const r = deriveGstBreakdown(base);
    expect(r.reason).toBe("EXPORT_NO_LUT_IGST");
    expect(r.igstPaise).toBe(18_000);
    expect(r.cgstPaise).toBe(0);
    expect(r.totalPaise).toBe(118_000);
  });

  it("valid LUT ⇒ zero-rated exactly as before", () => {
    freezeInsideLutWindow();
    setLut("LUT/2627", "2027-03-31");
    const r = deriveGstBreakdown(base);
    expect(r.reason).toBe("ZERO_RATED_EXPORT");
    expect(r.igstPaise).toBe(0);
    expect(r.totalPaise).toBe(base.subtotalPaise);
  });

  it("expired LUT ⇒ taxable (renewal trap)", () => {
    setLut("LUT/2526", "2026-03-31");
    const r = deriveGstBreakdown({ ...base, buyerCountry: "DE" });
    expect(r.reason).toBe("EXPORT_NO_LUT_IGST");
    expect(r.igstPaise).toBe(18_000);
  });
});

describe("determineTax export branch (checkout parity)", () => {
  it("no LUT ⇒ 18% IN-GST treatment with explanatory notes", () => {
    setLut(null, null);
    const r = determineTax({ baseAmountPaise: 100_000, buyerCountry: "US" });
    expect(r.isZeroRated).toBe(false);
    expect(r.taxRate).toBe(18);
    expect(r.taxAmount).toBe(18_000);
    expect(r.jurisdiction).toBe("IN-GST");
    expect(r.notes).toMatch(/Rule 96A/i);
  });

  it("valid LUT ⇒ zero-rated export", () => {
    freezeInsideLutWindow();
    setLut("LUT/2627", "2027-03-31");
    const r = determineTax({ baseAmountPaise: 100_000, buyerCountry: "GB" });
    expect(r.isZeroRated).toBe(true);
    expect(r.taxAmount).toBe(0);
    expect(r.jurisdiction).toBe("EXPORT-ZERO");
  });

  it("domestic supply is unaffected by LUT state", () => {
    setLut(null, null);
    const r = determineTax({ baseAmountPaise: 100_000, buyerCountry: "IN" });
    expect(r.jurisdiction).toBe("IN-GST");
    expect(r.taxAmount).toBe(18_000);
  });
});
