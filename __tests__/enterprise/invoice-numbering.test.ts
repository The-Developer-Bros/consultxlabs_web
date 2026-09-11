/**
 * @jest-environment node
 */

/**
 * Per-org sequential invoice numbering (CGST Rule 46). Covers the pure
 * helpers; concurrency is validated separately at the integration layer
 * because Jest doesn't expose a real Postgres for the
 * INSERT ... ON CONFLICT ... RETURNING pattern.
 */

import {
  indianFiscalYear,
  generateOrgInvoiceNumber,
} from "@/lib/payments/billing/invoice-numbering";

describe("indianFiscalYear", () => {
  it("April → start of next FY", () => {
    expect(indianFiscalYear(new Date("2026-04-01T00:00:00.000Z"))).toBe(2026);
  });

  it("March → previous FY (IST)", () => {
    // 17:30 IST on 31 Mar — unambiguously March in IST.
    expect(indianFiscalYear(new Date("2026-03-31T12:00:00.000Z"))).toBe(2025);
  });

  it("#776 — early-April-IST boundary reckoned in IST, not UTC", () => {
    // 2026-03-31T23:59:59Z is 01-Apr 05:29 IST → FY 2026. Computing in UTC would
    // wrongly file it under FY 2025 (the boundary bug F3 fixes).
    expect(indianFiscalYear(new Date("2026-03-31T23:59:59.000Z"))).toBe(2026);
  });

  it("December (mid-year) → current FY", () => {
    expect(indianFiscalYear(new Date("2026-12-15T12:00:00.000Z"))).toBe(2026);
  });

  it("January → previous calendar year's FY", () => {
    expect(indianFiscalYear(new Date("2026-01-15T00:00:00.000Z"))).toBe(2025);
  });
});

describe("generateOrgInvoiceNumber", () => {
  function mockTx(allocations: number[]) {
    let i = 0;
    return {
      // #776 — allocateOrgInvoiceSeq now uses the ORM upsert (no raw SQL) and
      // returns `nextSeq - 1`, so a mocked allocation N maps to nextSeq = N + 1.
      orgInvoiceCounter: {
        upsert: jest.fn().mockImplementation(async () => {
          if (i >= allocations.length) {
            throw new Error("ran out of mock allocations");
          }
          return { nextSeq: allocations[i++] + 1 };
        }),
      },
    };
  }

  it("uses invoiceNumberPrefix when set", async () => {
    const tx = mockTx([42]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme-corp", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-2026-0042");
    expect(result.fiscalYear).toBe(2026);
    expect(result.seq).toBe(42);
  });

  it("falls back to slug (uppercased) when prefix is null", async () => {
    const tx = mockTx([1]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme-corp", invoiceNumberPrefix: null },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    // #789 — the prefix is capped to keep the number within CGST Rule 46(b)'s
    // 16 chars; "ACME-CORP-2026-0001" (19 chars) was a breach. Orgs that want a
    // cleaner number should configure a short invoiceNumberPrefix.
    expect(result.invoiceNumber).toBe("ACME-C-2026-0001");
    expect(result.invoiceNumber.length).toBeLessThanOrEqual(16);
  });

  it("zero-pads seq to 4 digits", async () => {
    const tx = mockTx([7]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-2026-0007");
  });

  it("does NOT trim seq once it exceeds 4 digits (10000+)", async () => {
    const tx = mockTx([10000]);
    const result = await generateOrgInvoiceNumber(
      tx as never,
      { id: "org-1", slug: "acme", invoiceNumberPrefix: "ACME" },
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(result.invoiceNumber).toBe("ACME-2026-10000");
  });
});
