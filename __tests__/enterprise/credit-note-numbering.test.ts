/**
 * @jest-environment node
 */

/**
 * Per-org sequential credit-note numbering (CGST Rule 53, #776). Mirrors
 * invoice-numbering.test.ts: covers the pure format/allocation helpers via a
 * mocked Prisma `upsert`. Real concurrency (atomic increment) is a DB-level
 * guarantee validated at the integration layer.
 */

import {
  allocateOrgCreditNoteSeq,
  generateOrgCreditNoteNumber,
} from "@/lib/payments/billing/credit-note-numbering";

// upsert returns the POST-increment nextSeq; allocate returns nextSeq - 1.
function mockTx(allocations: number[]) {
  let i = 0;
  return {
    orgCreditNoteCounter: {
      upsert: jest.fn().mockImplementation(async () => {
        if (i >= allocations.length) throw new Error("ran out of mock allocations");
        return { nextSeq: allocations[i++] + 1 };
      }),
    },
  };
}

describe("allocateOrgCreditNoteSeq", () => {
  it("returns the pre-increment sequence (nextSeq - 1)", async () => {
    const tx = mockTx([1]);
    await expect(
      allocateOrgCreditNoteSeq(tx as never, "org-1", 2026),
    ).resolves.toBe(1);
  });

  it("is gapless across successive allocations", async () => {
    const tx = mockTx([1, 2, 3]);
    const a = await allocateOrgCreditNoteSeq(tx as never, "org-1", 2026);
    const b = await allocateOrgCreditNoteSeq(tx as never, "org-1", 2026);
    const c = await allocateOrgCreditNoteSeq(tx as never, "org-1", 2026);
    expect([a, b, c]).toEqual([1, 2, 3]);
  });
});

describe("generateOrgCreditNoteNumber", () => {
  it("formats as <PREFIX>-CN-<FY>-<SEQ> with the CN segment", async () => {
    const tx = mockTx([42]);
    const result = await generateOrgCreditNoteNumber(
      tx as never,
      { id: "org-1", slug: "acme-corp", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    // #789 — the credit-note budget is 3 chars tighter than the invoice one
    // because of the `-CN-` infix, so a 4-char prefix is capped to 3. The old
    // "ACME-CN-2026-0042" (17 chars) breached CGST Rule 53.
    expect(result.creditNoteNumber).toBe("ACM-CN-2026-0042");
    expect(result.creditNoteNumber.length).toBeLessThanOrEqual(16);
    expect(result.fiscalYear).toBe(2026);
    expect(result.seq).toBe(42);
  });

  it("falls back to slug (uppercased) when prefix is null", async () => {
    const tx = mockTx([1]);
    const result = await generateOrgCreditNoteNumber(
      tx as never,
      { id: "org-1", slug: "acme-corp", invoiceNumberPrefix: null },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    // "ACME-CORP-CN-2026-0001" (22 chars) was a gross breach; capped to 16.
    expect(result.creditNoteNumber).toBe("ACM-CN-2026-0001");
    expect(result.creditNoteNumber.length).toBeLessThanOrEqual(16);
  });

  it("March issue date lands in the prior FY (matches the invoice it adjusts)", async () => {
    const tx = mockTx([5]);
    const result = await generateOrgCreditNoteNumber(
      tx as never,
      { id: "org-1", slug: "acme", invoiceNumberPrefix: "ACME" },
      // 17:30 IST on 31 Mar — unambiguously March in IST (#776: FY reckoned in IST).
      new Date("2026-03-31T12:00:00.000Z"),
    );
    expect(result.creditNoteNumber).toBe("ACM-CN-2025-0005");
    expect(result.creditNoteNumber.length).toBeLessThanOrEqual(16);
    expect(result.fiscalYear).toBe(2025);
  });
});
