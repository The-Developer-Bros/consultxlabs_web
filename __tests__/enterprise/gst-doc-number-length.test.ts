/**
 * @jest-environment node
 */

/**
 * #789 — CGST Rule 46(b)/Rule 53 cap invoice and credit-note numbers at sixteen
 * characters. These tests drive the real numbering functions with a fake
 * transaction client and assert every emitted number respects the cap, across
 * a range of org-prefix lengths that previously overflowed.
 */

import { generateOrgInvoiceNumber } from "../../lib/payments/billing/invoice-numbering";
import { generateOrgCreditNoteNumber } from "../../lib/payments/billing/credit-note-numbering";
import { GST_DOC_NUMBER_MAX_LEN } from "../../lib/payments/billing/invoice-numbering";

// Minimal fake tx client: the counter upsert just returns a fixed nextSeq so
// the allocated sequence is deterministic (nextSeq - 1).
function fakeTx(nextSeq: number) {
  const counter = { upsert: jest.fn().mockResolvedValue({ nextSeq }) };
  return {
    orgInvoiceCounter: counter,
    orgCreditNoteCounter: counter,
  } as never;
}

const issuedAt = new Date("2026-06-05T10:00:00Z");

describe("GST document-number length cap (Rule 46(b) / Rule 53)", () => {
  const prefixes = ["AB", "WIPRO", "ACCENTURE", "VERYLONGORGNAME"];

  it.each(prefixes)(
    "invoice number stays within 16 chars for prefix %s",
    async (prefix) => {
      const { invoiceNumber } = await generateOrgInvoiceNumber(
        fakeTx(2),
        { id: "org_1", slug: prefix, invoiceNumberPrefix: prefix },
        issuedAt,
      );
      expect(invoiceNumber.length).toBeLessThanOrEqual(GST_DOC_NUMBER_MAX_LEN);
    },
  );

  it.each(prefixes)(
    "credit-note number stays within 16 chars for prefix %s",
    async (prefix) => {
      const { creditNoteNumber } = await generateOrgCreditNoteNumber(
        fakeTx(2),
        { id: "org_1", slug: prefix, invoiceNumberPrefix: prefix },
        issuedAt,
      );
      expect(creditNoteNumber.length).toBeLessThanOrEqual(
        GST_DOC_NUMBER_MAX_LEN,
      );
    },
  );

  it("WIPRO credit note no longer overflows (was 18 chars: WIPRO-CN-2026-0001)", async () => {
    const { creditNoteNumber } = await generateOrgCreditNoteNumber(
      fakeTx(2),
      { id: "org_1", slug: "wipro", invoiceNumberPrefix: "WIPRO" },
      issuedAt,
    );
    // The old output was `WIPRO-CN-2026-0001` (18). It must now fit the cap and
    // still carry the CN infix, the FY, and the zero-padded sequence.
    expect(creditNoteNumber.length).toBeLessThanOrEqual(GST_DOC_NUMBER_MAX_LEN);
    expect(creditNoteNumber).toMatch(/-CN-2026-0001$/);
  });

  it("keeps a four-digit-plus sequence within the cap", async () => {
    // seq 12344 (nextSeq 12345) widens the padded segment to five digits; the
    // prefix budget must shrink accordingly.
    const { invoiceNumber } = await generateOrgInvoiceNumber(
      fakeTx(12345),
      { id: "org_1", slug: "acme", invoiceNumberPrefix: "ACME" },
      issuedAt,
    );
    expect(invoiceNumber.length).toBeLessThanOrEqual(GST_DOC_NUMBER_MAX_LEN);
    expect(invoiceNumber).toMatch(/-2026-12344$/);
  });
});
