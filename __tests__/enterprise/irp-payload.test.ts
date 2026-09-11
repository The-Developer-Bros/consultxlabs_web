/**
 * @jest-environment node
 *
 * #703 / #778 — buildIrpPayload pure mapper. Covers intra-state (CGST+SGST),
 * inter-state (IGST), paise→rupee residual landing on the last line, and each
 * required-field rejection. No DB / no env — pure in → out.
 */
import {
  buildIrpPayload,
  type BuildIrpPayloadInput,
} from "@/lib/compliance/irp-payload";

const seller = {
  gstin: "29AAFCF1234Q1ZN", // Karnataka (29)
  legalName: "Familiarise Technologies Private Limited",
  address1: "Koramangala 1st Block",
  location: "Bangalore",
  pincode: "560034",
  stateCode: "KA",
};

// Buyer in Karnataka → intra-state (CGST+SGST). 10000 paise @18% = 1800 tax,
// split 900/900.
const intraInput = (): BuildIrpPayloadInput => ({
  invoice: {
    invoiceNumber: "ACME-2026-001",
    issuedAt: new Date(Date.UTC(2026, 0, 15)), // 15/01/2026
    reverseCharge: false,
    lutNumber: null,
    subtotalPaise: 10000,
    cgstPaise: 900,
    sgstPaise: 900,
    igstPaise: 0,
    totalPaise: 11800,
    hsnCode: "998314",
    placeOfSupply: "KA",
  },
  lineItems: [
    {
      position: 0,
      description: "Consulting hours",
      quantity: 1,
      unitPricePaise: 10000,
      hsnCode: null,
    },
  ],
  buyer: {
    name: "Acme Corp",
    gstin: "29ABCDE1234F1Z5", // Karnataka buyer
    stateCode: "KA",
    hsnDefault: "999293",
  },
  seller,
});

describe("buildIrpPayload — happy path", () => {
  it("intra-state maps CGST+SGST, B2B, numeric state codes, DD/MM/YYYY", () => {
    const r = buildIrpPayload(intraInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as Record<string, any>;

    expect(p.Version).toBe("1.1");
    expect(p.TranDtls.SupTyp).toBe("B2B");
    expect(p.TranDtls.TaxSch).toBe("GST");
    expect(p.DocDtls.No).toBe("ACME-2026-001");
    expect(p.DocDtls.Dt).toBe("15/01/2026");

    // Numeric state codes derived from GSTIN prefix.
    expect(p.SellerDtls.Stcd).toBe("29");
    expect(p.BuyerDtls.Stcd).toBe("29");
    expect(p.BuyerDtls.Pos).toBe("29");
    expect(p.BuyerDtls.Gstin).toBe("29ABCDE1234F1Z5");

    // Line HSN falls back to invoice HSN when line is null.
    expect(p.ItemList[0].HsnCd).toBe("998314");
    expect(p.ItemList[0].CgstAmt).toBe(9);
    expect(p.ItemList[0].SgstAmt).toBe(9);
    expect(p.ItemList[0].IgstAmt).toBe(0);
    expect(p.ItemList[0].GstRt).toBe(18);
    expect(p.ItemList[0].TotItemVal).toBe(118);

    // ValDtls in rupees.
    expect(p.ValDtls.AssVal).toBe(100);
    expect(p.ValDtls.CgstVal).toBe(9);
    expect(p.ValDtls.SgstVal).toBe(9);
    expect(p.ValDtls.IgstVal).toBe(0);
    expect(p.ValDtls.TotInvVal).toBe(118);
  });

  it("inter-state maps IGST only", () => {
    const input = intraInput();
    input.invoice.cgstPaise = 0;
    input.invoice.sgstPaise = 0;
    input.invoice.igstPaise = 1800;
    input.buyer.gstin = "33ABCDE1234F1Z5"; // Tamil Nadu (33) → inter-state
    input.buyer.stateCode = "TN";
    input.invoice.placeOfSupply = "TN";

    const r = buildIrpPayload(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as Record<string, any>;

    expect(p.BuyerDtls.Stcd).toBe("33");
    expect(p.BuyerDtls.Pos).toBe("33");
    expect(p.ItemList[0].IgstAmt).toBe(18);
    expect(p.ItemList[0].CgstAmt).toBe(0);
    expect(p.ItemList[0].SgstAmt).toBe(0);
    expect(p.ValDtls.IgstVal).toBe(18);
    expect(p.ValDtls.CgstVal).toBe(0);
  });

  it("zero-rated export with LUT → EXPWOP", () => {
    const input = intraInput();
    input.invoice.cgstPaise = 0;
    input.invoice.sgstPaise = 0;
    input.invoice.igstPaise = 0;
    input.invoice.totalPaise = 10000;
    input.invoice.lutNumber = "LUT-2026-XYZ";

    const r = buildIrpPayload(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).TranDtls.SupTyp).toBe("EXPWOP");
  });

  it("reverse charge sets RegRev=Y", () => {
    const input = intraInput();
    input.invoice.reverseCharge = true;
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload as any).TranDtls.RegRev).toBe("Y");
  });
});

describe("buildIrpPayload — paise→rupee residual on last line", () => {
  it("multi-line intra-state: per-line CGST/SGST reconcile to ValDtls exactly", () => {
    // Three odd lines so proportional rounding leaves a residual that must
    // land on the last line.
    const input = intraInput();
    // assessable 3334 + 3333 + 3333 = 10000; tax 900/900 each leg.
    input.lineItems = [
      { position: 0, description: "L1", quantity: 1, unitPricePaise: 3334, hsnCode: null },
      { position: 1, description: "L2", quantity: 1, unitPricePaise: 3333, hsnCode: null },
      { position: 2, description: "L3", quantity: 1, unitPricePaise: 3333, hsnCode: null },
    ];

    const r = buildIrpPayload(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as Record<string, any>;

    // Per-line legs (in rupees) must sum to the invoice legs exactly.
    const sumCgst = p.ItemList.reduce((a: number, it: any) => a + it.CgstAmt, 0);
    const sumSgst = p.ItemList.reduce((a: number, it: any) => a + it.SgstAmt, 0);
    const sumAss = p.ItemList.reduce((a: number, it: any) => a + it.AssAmt, 0);
    const sumTot = p.ItemList.reduce((a: number, it: any) => a + it.TotItemVal, 0);

    expect(Number(sumCgst.toFixed(2))).toBe(p.ValDtls.CgstVal);
    expect(Number(sumSgst.toFixed(2))).toBe(p.ValDtls.SgstVal);
    expect(Number(sumAss.toFixed(2))).toBe(p.ValDtls.AssVal);
    expect(Number(sumTot.toFixed(2))).toBe(p.ValDtls.TotInvVal);
  });

  it("residual lands on the last line (paise-level)", () => {
    const input = intraInput();
    // tax 901 paise (odd) split across 2 lines: line0 gets round(901*0.5)=451,
    // line1 absorbs 450 → sums to 901.
    input.invoice.cgstPaise = 901;
    input.invoice.sgstPaise = 901;
    input.invoice.totalPaise = 10000 + 901 + 901;
    input.lineItems = [
      { position: 0, description: "L1", quantity: 1, unitPricePaise: 5000, hsnCode: null },
      { position: 1, description: "L2", quantity: 1, unitPricePaise: 5000, hsnCode: null },
    ];

    const r = buildIrpPayload(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as Record<string, any>;
    // 451 paise = 4.51, 450 paise = 4.50; total 9.01 == CgstVal.
    expect(p.ItemList[0].CgstAmt).toBe(4.51);
    expect(p.ItemList[1].CgstAmt).toBe(4.5);
    expect(p.ValDtls.CgstVal).toBe(9.01);
  });
});

describe("buildIrpPayload — rejections", () => {
  it("rejects missing buyer GSTIN", () => {
    const input = intraInput();
    input.buyer.gstin = null;
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/buyer GSTIN/i);
  });

  it("rejects missing invoiceNumber", () => {
    const input = intraInput();
    input.invoice.invoiceNumber = null;
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/invoiceNumber/i);
  });

  it("rejects missing issuedAt", () => {
    const input = intraInput();
    input.invoice.issuedAt = null;
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/issuedAt/i);
  });

  it("rejects empty line items", () => {
    const input = intraInput();
    input.lineItems = [];
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/line item/i);
  });

  it("rejects missing seller GSTIN", () => {
    const input = intraInput();
    input.seller = { ...seller, gstin: "" };
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/seller GSTIN/i);
  });

  it("rejects line/subtotal mismatch", () => {
    const input = intraInput();
    input.invoice.subtotalPaise = 9999; // != line assessable 10000
    const r = buildIrpPayload(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/subtotal/i);
  });
});
