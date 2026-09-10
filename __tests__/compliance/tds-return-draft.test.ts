/**
 * @jest-environment node
 */

/**
 * #1230 — TDS return draft builder invariants: FY/quarter labelling on IST
 * edges, reversal netting, per-deductee section classification, and the
 * Form 26Q→140 label switch at FY 2026-27.
 */

import {
  buildTdsReturnDraft,
  closedIndianFyQuarterOf,
  indianFyQuarterOf,
  type TdsReturnSourceRow,
} from "@/lib/compliance/tds-return";

describe("indianFyQuarterOf", () => {
  it("maps calendar months to IST fiscal quarters with the Apr-start FY label", () => {
    expect(indianFyQuarterOf(new Date("2026-04-15T00:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 1,
    });
    // Mid-September IST (not 20:00Z, which is already Oct 1 IST).
    expect(indianFyQuarterOf(new Date("2026-09-30T10:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 2,
    });
    expect(indianFyQuarterOf(new Date("2026-12-31T10:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 3,
    });
    expect(indianFyQuarterOf(new Date("2027-01-01T00:00:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 4,
    });
  });

  it("a March instant belongs to the PREVIOUS FY label (IST-aware)", () => {
    // 19:00Z = Apr 1 00:30 IST → NEW fiscal year already.
    expect(
      indianFyQuarterOf(new Date("2026-03-31T19:00:00Z")).financialYear,
    ).toBe("2026-27");
    // 18:29:59Z is still Mar 31 23:59 IST → prior-FY Q4; 18:30Z tips over.
    expect(indianFyQuarterOf(new Date("2026-03-31T18:29:59Z")).quarter).toBe(4);
    expect(indianFyQuarterOf(new Date("2026-03-31T18:30:01Z")).quarter).toBe(1);
    // 17:00Z = 22:30 IST on Mar 31 → previous FY.
    expect(
      indianFyQuarterOf(new Date("2026-03-31T17:00:00Z")).financialYear,
    ).toBe("2025-26");
  });
});

describe("closedIndianFyQuarterOf", () => {
  it("targets the quarter that ended, not the one containing the run (#1354)", () => {
    // The workflow fires 01:20 UTC on the 5th of Jan/Apr/Jul/Oct.
    expect(closedIndianFyQuarterOf(new Date("2027-04-05T01:20:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 4,
    });
    expect(closedIndianFyQuarterOf(new Date("2027-01-05T01:20:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 3,
    });
    expect(closedIndianFyQuarterOf(new Date("2026-07-05T01:20:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 1,
    });
    expect(closedIndianFyQuarterOf(new Date("2026-10-05T01:20:00Z"))).toEqual({
      financialYear: "2026-27",
      quarter: 2,
    });
    // Mid-quarter re-run: still the last CLOSED quarter, never the open one.
    expect(closedIndianFyQuarterOf(new Date("2026-05-20T09:00:00Z"))).toEqual({
      financialYear: "2025-26",
      quarter: 4,
    });
  });
});

describe("buildTdsReturnDraft", () => {
  const base: TdsReturnSourceRow[] = [
    {
      deducteeType: "CONSULTANT",
      deducteeId: "c1",
      deducteeName: "Consultant One",
      deducteePanLast4: "1234",
      deducteeGstin: null,
      tdsSection: "194O",
      paymentCode: "1005",
      amountCreditedPaise: 1_000_000,
      tdsDeductedPaise: 1_000,
      isReversal: false,
    },
    {
      deducteeType: "CONSULTANT",
      deducteeId: "c1",
      deducteeName: "Consultant One",
      deducteePanLast4: "1234",
      deducteeGstin: null,
      tdsSection: "194O",
      paymentCode: "1005",
      amountCreditedPaise: 500_000,
      tdsDeductedPaise: -500,
      isReversal: true,
    },
    {
      deducteeType: "CONSULTANT",
      deducteeId: "c2",
      deducteeName: "Consultant Two",
      deducteePanLast4: "5678",
      deducteeGstin: null,
      tdsSection: null,
      paymentCode: null,
      amountCreditedPaise: 250_000,
      tdsDeductedPaise: 2_500,
      isReversal: false,
    },
  ];

  it("nets reversals into the deduction totals and classifies by section", () => {
    const d = buildTdsReturnDraft(base, "2026-27", 1);
    expect(d.totalAmountCreditedPaise).toBe(1_750_000);
    // 1000 - 500 + 2500
    expect(d.totalTdsDeductedNetPaise).toBe(3_000);
    const c1 = d.deductees.find((x) => x.deducteeId === "c1");
    expect(c1?.tdsDeductedNetPaise).toBe(500);
    // Unstamped rows land under UNKNOWN with a warning, never silently dropped.
    expect(d.deductees.find((x) => x.tdsSection === "UNKNOWN")).toBeDefined();
    expect(d.warnings.join(" ")).toMatch(/tdsSection/);
  });

  it("switches the form label at FY 2026-27 (IT Act 2025 renumbering)", () => {
    expect(buildTdsReturnDraft(base, "2025-26", 4).formLabel).toBe("FORM_26Q");
    expect(buildTdsReturnDraft(base, "2026-27", 1).formLabel).toBe("FORM_140");
  });

  it("flags an empty quarter instead of filing silent zeros", () => {
    const d = buildTdsReturnDraft([], "2026-27", 3);
    expect(d.warnings.join(" ")).toMatch(/payout pipeline/i);
  });

  it("emits an organization deductee row alongside a consultant row (#1354)", () => {
    const d = buildTdsReturnDraft(
      [
        ...base,
        {
          deducteeType: "ORGANIZATION",
          deducteeId: "org1",
          deducteeName: "Acme Advisory Pvt Ltd",
          deducteePanLast4: "9012",
          deducteeGstin: "27AAAAA0000A1Z5",
          tdsSection: "194J",
          paymentCode: "1004",
          amountCreditedPaise: 4_000_000,
          tdsDeductedPaise: 400_000,
          isReversal: false,
        },
      ],
      "2026-27",
      2,
    );

    const consultant = d.deductees.find((x) => x.deducteeId === "c1");
    const org = d.deductees.find((x) => x.deducteeId === "org1");
    expect(consultant?.deducteeType).toBe("CONSULTANT");
    expect(org?.deducteeType).toBe("ORGANIZATION");
    expect(org?.tdsSection).toBe("194J");
    expect(org?.tdsDeductedNetPaise).toBe(400_000);
    // 1_750_000 consultant credits + the org's 4_000_000.
    expect(d.totalAmountCreditedPaise).toBe(5_750_000);
    // 1000 - 500 + 2500 + 400_000.
    expect(d.totalTdsDeductedNetPaise).toBe(403_000);
    // The org rail files a real return line now, so the standing "no return
    // artifact" warning must be gone rather than merely inaccurate.
    expect(d.warnings.join(" ")).not.toMatch(/OrganizationPayout/);
  });
});
