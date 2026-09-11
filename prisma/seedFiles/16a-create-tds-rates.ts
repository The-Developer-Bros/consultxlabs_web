import prisma from "../../lib/prisma";

/**
 * #778 §D/§E — statutory TDS rate rows for the law-aware TdsRate lookup.
 * Append-only by design: a rate change is a NEW row with a fresh
 * effectiveFrom. IT2025 paymentCode stays null until the CBDT challan/RPU
 * schema is final (publishers disagree on the 10xx codes — do not guess).
 * Rates web-verified 2026-06-10.
 */
export async function createTdsRates() {
  const rows = [
    {
      lawCode: "IT1961" as const,
      section: "194O",
      rateBps: 10, // 0.1% w.e.f. 2024-10-01 (was 100 bps)
      noPanRateBps: 500, // the 194-O 5% no-PAN carve-out
      thresholdPaise: BigInt(50_000_000), // ₹5L FY exemption (individual/HUF with PAN)
      effectiveFrom: new Date("2024-10-01T00:00:00+05:30"),
      effectiveTo: new Date("2026-03-31T23:59:59+05:30"),
    },
    {
      lawCode: "IT1961" as const,
      section: "194J",
      rateBps: 1000, // 10% professional fees
      noPanRateBps: 2000, // 206AA 20%
      thresholdPaise: BigInt(3_000_000), // ₹30K per-FY
      effectiveFrom: new Date("2020-04-01T00:00:00+05:30"),
      effectiveTo: new Date("2026-03-31T23:59:59+05:30"),
    },
    {
      // §393(1) Table Sl. 8(v) — the 194-O successor; same economics.
      lawCode: "IT2025" as const,
      section: "393-8(v)",
      paymentCode: null, // pending the final CBDT notification — never guess
      rateBps: 10,
      noPanRateBps: 500, // §397(2) e-commerce carve-out
      thresholdPaise: BigInt(50_000_000),
      effectiveFrom: new Date("2026-04-01T00:00:00+05:30"),
      effectiveTo: null,
    },
  ];

  for (const row of rows) {
    await prisma.tdsRate.upsert({
      where: {
        lawCode_section_effectiveFrom: {
          lawCode: row.lawCode,
          section: row.section,
          effectiveFrom: row.effectiveFrom,
        },
      },
      create: row,
      update: {}, // append-only: existing rows are never rewritten
    });
  }
  console.log(`✅ Seeded ${rows.length} TdsRate rows`);
}
