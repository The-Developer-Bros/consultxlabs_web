/**
 * @jest-environment node
 */

/**
 * #1230 — CRN typing on the IRP payload. Credit notes were invisible to
 * e-invoicing: DocDtls.Typ was hard-wired "INV" and a CRN payload without
 * OrigDocDtls (the s.34 original-invoice reference) would be rejected by
 * the NIC schema anyway. Pins the gate and the typed output.
 */

import { buildIrpPayload, type BuildIrpPayloadInput } from "@/lib/compliance/irp-payload";

const seller = {
  gstin: "29AAFCF1234Q1ZN",
  legalName: "Familiarise Technologies Private Limited",
  address1: "Koramangala 1st Block",
  location: "Bangalore",
  pincode: "560034",
  stateCode: "KA",
};

function crnBase(): BuildIrpPayloadInput {
  return {
    invoice: {
      invoiceNumber: "ACME-2026-CN-001",
      issuedAt: new Date(Date.UTC(2026, 1, 10)),
      reverseCharge: false,
      lutNumber: null,
      subtotalPaise: 5000,
      cgstPaise: 450,
      sgstPaise: 450,
      igstPaise: 0,
      totalPaise: 5900,
      hsnCode: "998314",
      placeOfSupply: "KA",
    },
    lineItems: [
      {
        position: 0,
        description: "Consulting hours refunded",
        quantity: 1,
        unitPricePaise: 5000,
        hsnCode: null,
      },
    ],
    buyer: {
      name: "Acme Corp",
      gstin: "29ABCDE1234F1Z5",
      stateCode: "KA",
      hsnDefault: "999293",
    },
    seller,
  };
}

describe("buildIrpPayload — docType CRN", () => {
  it("defaults to INV (historical behavior unchanged)", () => {
    const r = buildIrpPayload(crnBase());
    // Throw-then-assert keeps jest/no-conditional-expect happy while making
    // a shape regression fail loudly instead of skipping the assertion.
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    const p = r.payload as { DocDtls: { Typ: string } };
    expect(p.DocDtls.Typ).toBe("INV");
  });

  it("rejects CRN without the s.34 original-invoice reference", () => {
    const r = buildIrpPayload({ ...crnBase(), docType: "CRN" });
    if (r.ok) throw new Error("expected rejection for CRN without OrigDocDtls");
    expect(r.reason).toMatch(/CRN requires originalInvoice/);
  });

  it("emits Typ=CRN with OrigDocDtls when references are supplied", () => {
    const r = buildIrpPayload({
      ...crnBase(),
      docType: "CRN",
      originalInvoiceNumber: "ACME-2026-001",
      originalInvoiceDate: new Date(Date.UTC(2026, 0, 15)),
    });
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
    const p = r.payload as {
      DocDtls: { Typ: string; No: string };
      OrigDocDtls?: { No: string; Dt: string };
    };
    expect(p.DocDtls.Typ).toBe("CRN");
    expect(p.DocDtls.No).toBe("ACME-2026-CN-001");
    expect(p.OrigDocDtls).toEqual({
      No: "ACME-2026-001",
      Dt: "15/01/2026",
    });
  });
});
