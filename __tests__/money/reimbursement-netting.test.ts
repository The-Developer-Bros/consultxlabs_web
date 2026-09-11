/**
 * The reimbursement report has been wrong in both directions.
 *
 * First it summed `Payment.amount` for every SUCCEEDED payment. `PaymentStatus`
 * has no REFUNDED member — refunds live in a separate model and never touch it
 * — so a fully refunded booking stayed on the payroll report and the org paid
 * back cash the member had already received.
 *
 * The fix for that dropped any payment carrying a succeeded refund, which broke
 * the other direction: a ₹1,000 payment with a ₹100 refund reimbursed ₹0
 * instead of ₹900. "Never over-pays" was true and not good enough — a silent
 * under-payment has no signal on the report at all.
 *
 * Both routes now net per row. Fully refunded rows stay visible at a net of
 * zero rather than being filtered out: netting cannot be expressed in a Prisma
 * `where` (it compares an aggregate against a column), so dropping them would
 * mean post-filtering an already-paginated page and returning short pages — and
 * showing them makes the report explain itself.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const LIST = "app/api/organizations/[orgId]/reimbursements/route.ts";
const EXPORT = "app/api/organizations/[orgId]/reimbursements/export/route.ts";
const UI = "app/dashboard/organization/[orgId]/reimbursements/page.tsx";

/**
 * The netting rule, mirrored from both routes. Pinning the arithmetic here is
 * the point of the file — the routes compute it inline against Prisma rows.
 */
function net(grossPaise: number, refunds: number[]) {
  const refundedPaise = refunds.reduce((a, b) => a + b, 0);
  return {
    refundedPaise,
    netReimbursablePaise: Math.max(0, grossPaise - refundedPaise),
  };
}

describe("netting arithmetic", () => {
  it("pays the remainder on a partial refund, not zero", () => {
    // The regression that prompted this: ₹1,000 with ₹100 back is ₹900 owed.
    expect(net(100_000, [10_000])).toEqual({
      refundedPaise: 10_000,
      netReimbursablePaise: 90_000,
    });
  });

  it("pays nothing on a full refund", () => {
    expect(net(100_000, [100_000]).netReimbursablePaise).toBe(0);
  });

  it("pays the full amount when there is no refund", () => {
    expect(net(100_000, []).netReimbursablePaise).toBe(100_000);
  });

  it("sums multiple partial refunds against one payment", () => {
    expect(net(100_000, [10_000, 25_000]).netReimbursablePaise).toBe(65_000);
  });

  it("clamps an over-refund to zero rather than going negative", () => {
    // A negative row would silently deduct from the rest of the payroll run.
    expect(net(100_000, [150_000]).netReimbursablePaise).toBe(0);
  });
});

describe("both routes net, and agree with each other", () => {
  it.each([LIST, EXPORT])("%s counts only succeeded, non-deleted refunds", (rel) => {
    const src = read(rel);
    expect(src).toContain('status: "SUCCEEDED" as const, deletedAt: null');
    // A PENDING or FAILED refund has not returned any money yet, so deducting
    // it would under-pay a member whose refund never lands.
    expect(src).toContain("refunds");
  });

  it.each([LIST, EXPORT])("%s no longer drops refunded rows wholesale", (rel) => {
    // This filter was the under-payment.
    expect(read(rel)).not.toContain("refunds: { none:");
  });

  it.each([LIST, EXPORT])("%s clamps the net at zero", (rel) => {
    expect(read(rel)).toMatch(/Math\.max\(0,\s*grossPaise - refundedPaise\)/);
  });

  it("the CSV carries the refunded and net columns finance pays from", () => {
    const src = read(EXPORT);
    expect(src).toContain('"Refunded (paise)"');
    expect(src).toContain('"Net reimbursable (paise)"');
    // Gross keeps its original column name so an existing importer reading by
    // header is not silently repointed at a different number.
    expect(src).toContain('"Amount (paise)"');
  });

  it("the screen's headline figure is the net, not the gross", () => {
    const src = read(UI);
    expect(src).toContain("totalNetPaise");
    expect(src).toContain("Net reimbursable");
    // The card is labelled "Total to reimburse"; reading the gross there
    // over-stated the transfer by every refund.
    expect(src).toContain("totalNetRupees");
  });
});
