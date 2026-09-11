/**
 * @jest-environment node
 *
 * #812 — property-based invariants for the money core. These are the safety net
 * that makes the blocking-ledger change safe and would have caught the bugs this
 * PR fixes (GST under-credit, unbalanced postings). Example-based tests cover a
 * handful of cases; fast-check covers the combinatorial space.
 */

import fc from "fast-check";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import {
  postLedgerTxn,
  LedgerImbalanceError,
  type Posting,
} from "@/lib/payments/ledger/post";
import { mintRefundCreditNote } from "@/lib/payments/operations/refund";

const paise = fc.integer({ min: 0, max: 1_000_000_000 });

describe("#812 invariant — GST breakdown always nets", () => {
  it("total = subtotal + igst + cgst + sgst, and the tax is 18% of subtotal", () => {
    fc.assert(
      fc.property(paise, fc.boolean(), (subtotal, interState) => {
        const gst = deriveGstBreakdown({
          subtotalPaise: subtotal,
          supplierStateCode: "KA",
          buyerStateCode: interState ? "MH" : "KA",
          buyerCountry: "IN",
        });
        // The components must reconstitute the total exactly (no lost paise).
        expect(gst.totalPaise).toBe(
          gst.subtotalPaise + gst.igstPaise + gst.cgstPaise + gst.sgstPaise,
        );
        expect(gst.subtotalPaise).toBe(subtotal);
        const tax = gst.igstPaise + gst.cgstPaise + gst.sgstPaise;
        expect(tax).toBe(Math.round(subtotal * 0.18));
        // Route to IGST (inter-state) or CGST+SGST (intra-state). Expected
        // values computed up front so the assertions stay unconditional.
        const expectedIgst = interState ? tax : 0;
        const expectedCgst = interState ? 0 : Math.floor(tax / 2);
        const expectedSgst = interState ? 0 : tax - Math.floor(tax / 2);
        expect(gst.igstPaise).toBe(expectedIgst);
        expect(gst.cgstPaise).toBe(expectedCgst);
        expect(gst.sgstPaise).toBe(expectedSgst);
      }),
    );
  });
});

describe("#812 invariant — every ledger transaction balances", () => {
  // A db stub whose findUnique short-circuits balanced postings before any
  // write, so we only exercise the in-function balance assertion.
  const db = {
    ledgerTransaction: {
      findUnique: jest.fn().mockResolvedValue({ id: "existing" }),
      create: jest.fn(),
    },
  } as never;

  it("accepts any balanced (Σdebit == Σcredit) posting", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1_000_000 }), async (amt) => {
        const postings: Posting[] = [
          { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: amt },
          {
            account: { kind: "PLATFORM_FEE" },
            direction: "CREDIT",
            amountPaise: amt,
          },
        ];
        await expect(
          postLedgerTxn(db, {
            idempotencyKey: `bal:${amt}`,
            kind: "BOOKING",
            postings,
          }),
        ).resolves.toBeDefined();
      }),
    );
  });

  it("rejects any imbalanced posting with LedgerImbalanceError", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }), // ≥1 guarantees an imbalance
        async (amt, extra) => {
          const postings: Posting[] = [
            { account: { kind: "CASH" }, direction: "DEBIT", amountPaise: amt },
            {
              account: { kind: "PLATFORM_FEE" },
              direction: "CREDIT",
              amountPaise: amt + extra,
            },
          ];
          await expect(
            postLedgerTxn(db, {
              idempotencyKey: `imb:${amt}:${extra}`,
              kind: "BOOKING",
              postings,
            }),
          ).rejects.toBeInstanceOf(LedgerImbalanceError);
        },
      ),
    );
  });
});

describe("#812 invariant — refund credit note fully reverses proportional GST", () => {
  function mockTx(subtotal: number, reverse: number) {
    const created: Record<string, unknown>[] = [];
    const tax = Math.round(subtotal * 0.18);
    const cgst = Math.floor(tax / 2);
    return {
      _created: created,
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: "p",
          amount: reverse,
          organizationId: "org",
          billableToOrgInvoiceId: "inv",
          legs: [{ source: "INVOICE_ACCRUAL", amountPaise: reverse }],
        }),
      },
      creditNote: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(async (a: { data: Record<string, unknown> }) => {
            created.push(a.data);
            return { id: "cn", ...a.data };
          }),
      },
      organizationInvoice: {
        findUnique: jest.fn().mockResolvedValue({
          id: "inv",
          status: "ISSUED",
          issuedAt: new Date("2026-05-01T00:00:00Z"),
          subtotalPaise: subtotal,
          cgstPaise: cgst,
          sgstPaise: tax - cgst,
          igstPaise: 0,
          totalPaise: subtotal + tax,
        }),
      },
      organization: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "org", slug: "acme", invoiceNumberPrefix: "ACM" }),
      },
      orgCreditNoteCounter: { upsert: jest.fn().mockResolvedValue({ nextSeq: 2 }) },
    };
  }

  it("cnTotal = cnSubtotal + cnTax, and cnTax is the proportional GST of the reversed pre-tax amount", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        async (subtotal, frac) => {
          const reverse = Math.max(1, Math.floor(subtotal * frac));
          const tx = mockTx(subtotal, reverse);
          await mintRefundCreditNote(tx as never, {
            paymentId: "p",
            refundId: "r",
            amountPaise: reverse,
            reason: "prop",
          });
          const cn = tx._created[0] as {
            subtotalPaise: number;
            cgstPaise: number;
            sgstPaise: number;
            igstPaise: number;
            totalPaise: number;
          };
          const cnTax = cn.cgstPaise + cn.sgstPaise + cn.igstPaise;
          // Pre-tax reversed amount is the CN subtotal; total adds tax on top.
          expect(cn.subtotalPaise).toBe(reverse);
          expect(cn.totalPaise).toBe(cn.subtotalPaise + cnTax);
          // Tax is the invoice's 18% applied to the reversed pre-tax base.
          expect(cnTax).toBe(Math.round((reverse * Math.round(subtotal * 0.18)) / subtotal));
        },
      ),
    );
  });
});
