/**
 * @jest-environment node
 *
 * #776 — CGST/SGST intra-state split must net exactly. The prior
 * `Math.round(taxPaise/2)` on both legs over-stated odd-tax invoices by 1 paise.
 */
import { deriveGstBreakdown } from "@/lib/compliance/gst";

const intra = (subtotalPaise: number) =>
  deriveGstBreakdown({
    subtotalPaise,
    supplierStateCode: "KA",
    buyerStateCode: "KA", // same state → CGST + SGST
    buyerCountry: "IN",
  });

describe("deriveGstBreakdown — intra-state CGST/SGST split", () => {
  it("nets exactly when the tax is odd (the #776 regression)", () => {
    // 100010 paise @18% = 18001.8 → round 18002 (even here); pick a value whose
    // 18% rounds odd: 10005 → 1800.9 → 1801 (odd).
    const r = intra(10005);
    expect(r.cgstPaise + r.sgstPaise).toBe(1801); // == taxPaise, not 1802
    expect(r.totalPaise).toBe(r.subtotalPaise + r.cgstPaise + r.sgstPaise);
    expect(r.totalPaise).toBe(10005 + 1801);
    // CGST floored, SGST absorbs the remainder.
    expect(r.cgstPaise).toBe(900);
    expect(r.sgstPaise).toBe(901);
  });

  it("splits evenly when the tax is even", () => {
    const r = intra(10000); // 1800 tax
    expect(r.cgstPaise).toBe(900);
    expect(r.sgstPaise).toBe(900);
    expect(r.totalPaise).toBe(11800);
  });

  it("total always equals subtotal + cgst + sgst across a range", () => {
    for (let sub = 9990; sub <= 10010; sub++) {
      const r = intra(sub);
      expect(r.igstPaise).toBe(0);
      expect(r.cgstPaise + r.sgstPaise).toBe(r.totalPaise - r.subtotalPaise);
    }
  });
});
