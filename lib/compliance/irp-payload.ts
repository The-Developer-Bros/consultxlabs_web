/**
 * ClearTax / NIC IRP e-invoice payload MAPPER — INDIA COMPLIANCE.
 *
 * #703 / #778 — the one missing piece of the IRP pipeline: a PURE function
 * that maps an already-fetched OrganizationInvoice (+ line items + buyer
 * tax info) to the NIC e-invoice schema v1.1 JSON that
 * `lib/compliance/irp.generateIrn` POSTs to ClearTax. No DB access here —
 * the cron fetches, this maps. HTTP + env-gating stay in irp.ts.
 *
 * Money note: the invoice stores paise (Int); the IRP wants rupees with 2
 * decimals. We round per line and push the paise residual onto the last
 * line so ItemList sums reconcile to ValDtls exactly — the IRP rejects any
 * mismatch between per-line totals and invoice totals.
 *
 * State codes: the IRP wants the 2-digit NUMERIC GST state code (e.g. "29"
 * Karnataka). The GSTIN's first 2 chars ARE that code, so we derive Pos /
 * Stcd from the GSTIN where available and fall back to an alpha→numeric
 * lookup for the env-sourced seller state.
 */

import { numericStateCode } from "./state-codes";

interface IrpPayloadLineItem {
  position: number;
  description: string;
  quantity: number;
  unitPricePaise: number;
  hsnCode: string | null;
}

interface IrpPayloadInvoice {
  invoiceNumber: string | null;
  issuedAt: Date | null;
  reverseCharge: boolean;
  lutNumber: string | null;
  // GST split (paise) + place-of-supply, written by the v1 money audit.
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  hsnCode: string; // invoice-level HSN fallback
  placeOfSupply: string | null; // buyer state (alpha or numeric)
}

interface IrpPayloadBuyer {
  name: string;
  gstin: string | null;
  stateCode: string | null; // OrganizationTaxInfo.gstStateCode
  hsnDefault: string; // OrganizationTaxInfo.hsnDefault
}

interface IrpPayloadSeller {
  gstin: string; // platform GSTIN (env-sourced in the cron)
  legalName: string;
  address1: string;
  location: string;
  pincode: string;
  stateCode: string; // alpha or numeric; normalized here
}

export interface BuildIrpPayloadInput {
  invoice: IrpPayloadInvoice;
  lineItems: IrpPayloadLineItem[];
  buyer: IrpPayloadBuyer;
  seller: IrpPayloadSeller;
  /**
   * #1230 — document type for the IRP DocDtls. "INV" (default) is the
   * historical behavior; "CRN" marks a CGST s.34 credit note, which the
   * NIC schema requires to carry OrigDocDtls referencing the original
   * invoice. Credit notes were previously invisible to e-invoicing
   * entirely — the uploader scanned invoices only and this field was
   * hard-wired to "INV".
   */
  docType?: "INV" | "CRN";
  /** Required when docType === "CRN": the adjusted invoice's number. */
  originalInvoiceNumber?: string;
  /** Required when docType === "CRN": the adjusted invoice's date. */
  originalInvoiceDate?: Date;
}

export type BuildIrpPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

// paise → rupees, 2dp, as a Number (the IRP accepts numeric monetary fields).
function toRupees(paise: number): number {
  return Math.round(paise) / 100;
}

// DD/MM/YYYY in UTC — the IRP doc-date format. UTC keeps it deterministic
// regardless of the cron host TZ.
function formatDocDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function buildIrpPayload(
  input: BuildIrpPayloadInput,
): BuildIrpPayloadResult {
  const { invoice, lineItems, buyer, seller } = input;
  const docType = input.docType ?? "INV";

  // CRN payloads must reference the adjusted document (NIC v1.1 OrigDocDtls).
  if (docType === "CRN" && (!input.originalInvoiceNumber || !input.originalInvoiceDate)) {
    return {
      ok: false,
      reason: "docType CRN requires originalInvoiceNumber and originalInvoiceDate",
    };
  }

  // B2B e-invoice requires the buyer GSTIN (the whole point of the IRP).
  if (!buyer.gstin) {
    return { ok: false, reason: "buyer GSTIN missing (B2B e-invoice requires it)" };
  }
  if (!invoice.invoiceNumber) {
    return { ok: false, reason: "invoiceNumber missing" };
  }
  if (!invoice.issuedAt) {
    return { ok: false, reason: "issuedAt missing (no document date)" };
  }
  if (lineItems.length === 0) {
    return { ok: false, reason: "no line items" };
  }
  if (!seller.gstin) {
    return { ok: false, reason: "seller GSTIN missing (PLATFORM_GSTIN env unset)" };
  }

  const sellerStcd = numericStateCode(seller.gstin, seller.stateCode);
  if (!sellerStcd) {
    return { ok: false, reason: "seller state code unresolved" };
  }
  const buyerStcd = numericStateCode(
    buyer.gstin,
    buyer.stateCode ?? invoice.placeOfSupply,
  );
  if (!buyerStcd) {
    return { ok: false, reason: "buyer state code unresolved" };
  }

  // Whole-invoice split decides intra (CGST+SGST) vs inter (IGST). We split
  // each line's GST in the SAME mode so per-line legs sum to the invoice legs.
  const isInterState = invoice.igstPaise > 0;

  // Assessable (taxable) base in paise — line totals must sum to this.
  const lineAssessable = lineItems.map(
    (li) => li.quantity * li.unitPricePaise,
  );
  const assessableTotalFromLines = lineAssessable.reduce((a, b) => a + b, 0);

  // The invoice's stored subtotal is the source of truth for ValDtls.AssVal.
  // If line math drifts from it (shouldn't, but guard), bail rather than ship
  // a payload the IRP will reject.
  if (assessableTotalFromLines !== invoice.subtotalPaise) {
    return {
      ok: false,
      reason: `line assessable ${assessableTotalFromLines} != invoice subtotal ${invoice.subtotalPaise}`,
    };
  }

  // Distribute each tax leg across lines proportional to assessable value,
  // rounding per line and pushing the residual onto the LAST line so the
  // per-line legs reconcile to the invoice legs exactly.
  const distribute = (totalPaise: number): number[] => {
    if (assessableTotalFromLines === 0) return lineItems.map(() => 0);
    const out: number[] = [];
    let running = 0;
    for (let i = 0; i < lineItems.length; i++) {
      if (i === lineItems.length - 1) {
        out.push(totalPaise - running);
      } else {
        const share = Math.round(
          (totalPaise * lineAssessable[i]) / assessableTotalFromLines,
        );
        out.push(share);
        running += share;
      }
    }
    return out;
  };

  const cgstByLine = distribute(invoice.cgstPaise);
  const sgstByLine = distribute(invoice.sgstPaise);
  const igstByLine = distribute(invoice.igstPaise);

  const itemList = lineItems.map((li, i) => {
    const assPaise = lineAssessable[i];
    const cgstPaise = isInterState ? 0 : cgstByLine[i];
    const sgstPaise = isInterState ? 0 : sgstByLine[i];
    const igstPaise = isInterState ? igstByLine[i] : 0;
    const taxPaise = cgstPaise + sgstPaise + igstPaise;
    // GstRt = blended % on this line's assessable value, 2dp.
    const gstRt =
      assPaise > 0 ? Math.round((taxPaise / assPaise) * 10000) / 100 : 0;
    const totItemValPaise = assPaise + taxPaise;

    return {
      SlNo: String(i + 1),
      IsServc: "Y", // consulting / SaaS — services only
      PrdDesc: li.description,
      HsnCd: li.hsnCode ?? invoice.hsnCode ?? buyer.hsnDefault,
      Qty: li.quantity,
      Unit: "OTH",
      UnitPrice: toRupees(li.unitPricePaise),
      TotAmt: toRupees(assPaise),
      AssAmt: toRupees(assPaise),
      GstRt: gstRt,
      CgstAmt: toRupees(cgstPaise),
      SgstAmt: toRupees(sgstPaise),
      IgstAmt: toRupees(igstPaise),
      TotItemVal: toRupees(totItemValPaise),
    };
  });

  // Zero-rated export with LUT (no IGST paid) → EXPWOP; else B2B. Reverse
  // charge stays a B2B flag (Y/N), not a supply type.
  const isZeroRatedExport =
    Boolean(invoice.lutNumber) &&
    invoice.igstPaise === 0 &&
    invoice.cgstPaise === 0 &&
    invoice.sgstPaise === 0;
  const supTyp = isZeroRatedExport ? "EXPWOP" : "B2B";

  const payload: Record<string, unknown> = {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: supTyp,
      RegRev: invoice.reverseCharge ? "Y" : "N",
    },
    DocDtls: {
      Typ: docType,
      No: invoice.invoiceNumber,
      Dt: formatDocDate(invoice.issuedAt),
    },
    ...(docType === "CRN" && input.originalInvoiceDate
      ? {
          OrigDocDtls: {
            No: input.originalInvoiceNumber,
            Dt: formatDocDate(input.originalInvoiceDate),
          },
        }
      : {}),
    SellerDtls: {
      Gstin: seller.gstin,
      LglNm: seller.legalName,
      Addr1: seller.address1,
      Loc: seller.location,
      Pin: Number(seller.pincode),
      Stcd: sellerStcd,
    },
    BuyerDtls: {
      Gstin: buyer.gstin,
      LglNm: buyer.name,
      Pos: buyerStcd,
      Stcd: buyerStcd,
    },
    ItemList: itemList,
    ValDtls: {
      AssVal: toRupees(invoice.subtotalPaise),
      CgstVal: toRupees(invoice.cgstPaise),
      SgstVal: toRupees(invoice.sgstPaise),
      IgstVal: toRupees(invoice.igstPaise),
      TotInvVal: toRupees(invoice.totalPaise),
    },
  };

  return { ok: true, payload };
}
