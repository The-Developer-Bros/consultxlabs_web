/**
 * @jest-environment node
 */

/**
 * #1230 — GSTR-8 draft builder invariants: integer-paise clamping, supplier
 * annex aggregation, IST period labelling, and the honest-empty warning.
 *
 * #1370 — and the reporting window those labels describe. Every statutory
 * period here is an IST calendar month, so both of its boundaries are IST
 * midnights expressed as instants. Computing them from UTC components dropped
 * the first five and a half hours of the month and swallowed the same span of
 * the next one, which no label would ever have shown.
 */

import {
  buildGstr8Draft,
  gstr8PeriodLabel,
  type Gstr8SourceRow,
} from "@/lib/compliance/gstr8";
import {
  previousIstCalendarMonthStart,
  nextMonthStart,
} from "@/lib/compliance/ist-period";
import { buildOutwardRegister } from "@/lib/compliance/gst-outward-register";

const AUG_2026_UTC = new Date("2026-08-01T00:00:00Z");

describe("gstr8PeriodLabel", () => {
  it("labels the IST calendar month of the period start", () => {
    expect(gstr8PeriodLabel(AUG_2026_UTC)).toBe("2026-08");
  });

  it("a UTC instant before 18:30Z stays in the prior IST month", () => {
    // Jul 1 20:00Z = Jul 2 01:30 IST → July; but Jun 30 18:00Z = Jun 30
    // 23:30 IST → still June. Anchoring on IST matters exactly at this edge.
    expect(gstr8PeriodLabel(new Date("2026-07-01T20:00:00Z"))).toBe("2026-07");
    expect(gstr8PeriodLabel(new Date("2026-06-30T18:00:00Z"))).toBe("2026-06");
    expect(gstr8PeriodLabel(new Date("2026-06-30T19:00:00Z"))).toBe("2026-07");
  });
});

describe("IST calendar-month boundaries", () => {
  // The 3rd-of-the-month run, exporting August.
  const NOW = new Date("2026-09-04T00:00:00Z");
  const START = previousIstCalendarMonthStart(NOW);

  it("opens and closes at IST midnight, not UTC midnight", () => {
    expect(START.toISOString()).toBe("2026-07-31T18:30:00.000Z");
    expect(nextMonthStart(START).toISOString()).toBe(
      "2026-08-31T18:30:00.000Z",
    );
  });

  it("covers the opening hours a UTC-midnight window filed against July", () => {
    // 2026-08-01T00:15 IST is 2026-07-31T18:45Z, which sits before the old
    // 2026-08-01T00:00Z boundary.
    const justAfterMidnightIst = new Date("2026-07-31T18:45:00Z");
    expect(justAfterMidnightIst.getTime()).toBeGreaterThanOrEqual(
      START.getTime(),
    );
    expect(justAfterMidnightIst.getTime()).toBeLessThan(
      nextMonthStart(START).getTime(),
    );
  });

  it("still names the IST month in the GSTR-8 label", () => {
    expect(gstr8PeriodLabel(START)).toBe("2026-08");
  });

  it("labels the register for exactly the IST days it covers", () => {
    expect(
      buildOutwardRegister([], START, nextMonthStart(START)).periodLabel,
    ).toBe("2026-08-01 to 2026-08-31");
  });

  it("labels an operator's UTC-midnight override honestly too", () => {
    // GST_REGISTER_PERIOD_START/END parse to UTC midnights, which is why the
    // exclusive end is stepped back a whole day rather than a millisecond.
    expect(
      buildOutwardRegister(
        [],
        new Date("2026-08-01T00:00:00Z"),
        new Date("2026-09-01T00:00:00Z"),
      ).periodLabel,
    ).toBe("2026-08-01 to 2026-08-31");
  });
});

describe("buildGstr8Draft", () => {
  it("aggregates totals and the seller-wise annex", () => {
    const rows: Gstr8SourceRow[] = [
      { consultantProfileId: "c1", netTaxablePaise: 100_000, tcsCollectedPaise: 500 },
      { consultantProfileId: "c1", netTaxablePaise: 50_000, tcsCollectedPaise: 250 },
      { consultantProfileId: "c2", netTaxablePaise: 200_000, tcsCollectedPaise: 1000 },
    ];
    const d = buildGstr8Draft(rows, AUG_2026_UTC);
    expect(d.totalNetTaxablePaise).toBe(350_000);
    expect(d.totalTcsCollectedPaise).toBe(1750);
    expect(d.suppliers).toHaveLength(2);
    const c1 = d.suppliers.find((s) => s.consultantProfileId === "c1");
    expect(c1).toMatchObject({ netTaxablePaise: 150_000, tcsCollectedPaise: 750 });
  });

  it("clamps negative rows to zero (refund-adjustment bugs must not file negative liabilities)", () => {
    const d = buildGstr8Draft(
      [
        { consultantProfileId: "c1", netTaxablePaise: -5_000, tcsCollectedPaise: -25 },
      ],
      AUG_2026_UTC,
    );
    expect(d.totalNetTaxablePaise).toBe(0);
    expect(d.totalTcsCollectedPaise).toBe(0);
  });

  it("empty period emits an explicit warning instead of silent zeros", () => {
    const d = buildGstr8Draft([], AUG_2026_UTC);
    expect(d.warnings.join(" ")).toMatch(/accrual writer/i);
  });

  it("leaves the intra/inter split null rather than guessing heads", () => {
    const d = buildGstr8Draft(
      [{ consultantProfileId: "c1", netTaxablePaise: 1, tcsCollectedPaise: 1 }],
      AUG_2026_UTC,
    );
    expect(d.intraStateTcsPaise).toBeNull();
    expect(d.interStateTcsPaise).toBeNull();
  });
});
