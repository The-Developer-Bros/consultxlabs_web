/**
 * @jest-environment node
 */

/**
 * Shared refund credit-note minting (#776 / #778 §D). `mintRefundCreditNote` is
 * called from BOTH applyRefundCascade (app/cron) and the gateway-refund webhook,
 * so it must be idempotent on refundId (one CN per refund, no duplicate, no
 * burned sequence number) and a no-op for non-invoiced payments. Mocked tx.
 */

import { mintRefundCreditNote } from "@/lib/payments/operations/refund";

function mockTx(opts: {
  payment: {
    id: string;
    amount: number;
    organizationId: string | null;
    billableToOrgInvoiceId: string | null;
    legs: Array<{ source: string; amountPaise: number }>;
  } | null;
  existingCreditNote?: { id: string } | null;
  invoice?: Record<string, unknown> | null;
}) {
  const creditNoteCreate = jest
    .fn()
    .mockImplementation(async () => ({ id: "cn-new" }));
  return {
    _creditNoteCreate: creditNoteCreate,
    payment: { findUnique: jest.fn().mockResolvedValue(opts.payment) },
    creditNote: {
      findUnique: jest.fn().mockResolvedValue(opts.existingCreditNote ?? null),
      create: creditNoteCreate,
    },
    organizationInvoice: {
      findUnique: jest.fn().mockResolvedValue(
        opts.invoice ?? {
          id: "inv1",
          // #776 — credit notes only mint against an issued invoice.
          status: "ISSUED",
          issuedAt: new Date("2026-05-01T00:00:00.000Z"),
          // #812 — subtotalPaise drives the gross-up (tax over SUBTOTAL, not
          // total); omitting it silently zeroed taxFraction and the test
          // affirmed the old under-credit bug.
          subtotalPaise: 1000,
          totalPaise: 1180,
          igstPaise: 0,
          cgstPaise: 90,
          sgstPaise: 90,
        },
      ),
    },
    organization: {
      findUnique: jest.fn().mockResolvedValue({
        id: "org1",
        slug: "acme",
        invoiceNumberPrefix: "ACME",
      }),
    },
    orgCreditNoteCounter: {
      upsert: jest.fn().mockResolvedValue({ nextSeq: 2 }),
    },
  };
}

const INVOICED_PAYMENT = {
  id: "p1",
  amount: 1000,
  organizationId: "org1",
  billableToOrgInvoiceId: "inv1",
  legs: [{ source: "INVOICE_ACCRUAL", amountPaise: 1000 }],
};

describe("mintRefundCreditNote", () => {
  it("mints a credit note for an invoiced refund", async () => {
    const tx = mockTx({ payment: INVOICED_PAYMENT });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBe("cn-new");
    expect(tx._creditNoteCreate).toHaveBeenCalledTimes(1);
    const data = tx._creditNoteCreate.mock.calls[0][0].data;
    expect(data.refundId).toBe("ref1");
    expect(data.invoiceId).toBe("inv1");
    // #812 — a full refund of a ₹1180 invoice (₹1000 + 18% GST) must mint a
    // ₹1180 credit note: the reversed accrual legs are tax-EXCLUSIVE, so GST
    // is grossed up on top (CGST Sec 34 reverses output tax proportionally).
    expect(data.subtotalPaise).toBe(1000);
    expect(data.cgstPaise).toBe(90);
    expect(data.sgstPaise).toBe(90);
    expect(data.igstPaise).toBe(0);
    expect(data.totalPaise).toBe(1180);
    // #789 — the prefix is capped so the number satisfies CGST Rule 53's
    // 16-character limit; "ACME-CN-2026-0001" (17 chars) was itself a breach.
    expect(data.creditNoteNumber).toBe("ACM-CN-2026-0001");
    expect(data.creditNoteNumber.length).toBeLessThanOrEqual(16);
  });

  it("#776 — does NOT mint a credit note against a DRAFT invoice", async () => {
    const tx = mockTx({
      payment: INVOICED_PAYMENT,
      invoice: {
        id: "inv1",
        status: "DRAFT",
        issuedAt: null,
        totalPaise: 1180,
        igstPaise: 0,
        cgstPaise: 90,
        sgstPaise: 90,
      },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBeNull();
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
  });

  it("is idempotent — returns the existing note and does NOT create a second", async () => {
    const tx = mockTx({
      payment: INVOICED_PAYMENT,
      existingCreditNote: { id: "cn-existing" },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBe("cn-existing");
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
    expect(tx.orgCreditNoteCounter.upsert).not.toHaveBeenCalled();
  });

  it("is a no-op for a non-invoiced payment", async () => {
    const tx = mockTx({
      payment: {
        ...INVOICED_PAYMENT,
        billableToOrgInvoiceId: null,
        organizationId: null,
      },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBeNull();
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
  });

  it("is a no-op when no invoice-accrual legs are present", async () => {
    const tx = mockTx({
      payment: {
        ...INVOICED_PAYMENT,
        legs: [{ source: "CARD", amountPaise: 1000 }],
      },
    });
    const res = await mintRefundCreditNote(tx as never, {
      paymentId: "p1",
      refundId: "ref1",
      amountPaise: 1000,
      reason: "test",
    });
    expect(res.creditNoteId).toBeNull();
    expect(tx._creditNoteCreate).not.toHaveBeenCalled();
  });
});
