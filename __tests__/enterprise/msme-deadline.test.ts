/**
 * @jest-environment node
 */

/**
 * Live MSME (Section 43B(h)) deadline derivation. The cron at
 * `jobs/compliance/msme-payment-alerts.ts` sweeps off the
 * `mustPayByDate` these tests pin down — getting any of these wrong
 * costs the org their FY tax deduction, so the cases here are the
 * non-negotiable "before-launch" guardrails.
 */

import {
  computeMsmePaymentDeadline,
  isValidUdyamNumber,
  MSME_NO_WRITTEN_AGREEMENT_DAYS,
  MSME_WRITTEN_AGREEMENT_DAYS,
  DEFAULT_MSME_DEADLINE_DAYS,
} from "@/lib/compliance/msme";

const INVOICE = new Date("2026-01-01T00:00:00.000Z");

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

describe("computeMsmePaymentDeadline — Section 43B(h)", () => {
  it("MICRO + written agreement → 45 days", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "MICRO",
      writtenAgreement: true,
    });
    expect(daysBetween(INVOICE, d)).toBe(MSME_WRITTEN_AGREEMENT_DAYS);
  });

  it("MICRO + no written agreement → 15 days", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "MICRO",
      writtenAgreement: false,
    });
    expect(daysBetween(INVOICE, d)).toBe(MSME_NO_WRITTEN_AGREEMENT_DAYS);
  });

  it("SMALL + written agreement → 45 days", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "SMALL",
      writtenAgreement: true,
    });
    expect(daysBetween(INVOICE, d)).toBe(MSME_WRITTEN_AGREEMENT_DAYS);
  });

  it("SMALL + no written agreement → 15 days", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "SMALL",
      writtenAgreement: false,
    });
    expect(daysBetween(INVOICE, d)).toBe(MSME_NO_WRITTEN_AGREEMENT_DAYS);
  });
});

describe("computeMsmePaymentDeadline — non-43B statuses", () => {
  it("MEDIUM falls back to defaultTermsDays (60 by default)", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "MEDIUM",
      writtenAgreement: false,
    });
    expect(daysBetween(INVOICE, d)).toBe(DEFAULT_MSME_DEADLINE_DAYS);
  });

  it("NONE falls back to defaultTermsDays (60 by default)", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "NONE",
      writtenAgreement: false,
    });
    expect(daysBetween(INVOICE, d)).toBe(DEFAULT_MSME_DEADLINE_DAYS);
  });

  it("NONE with explicit defaultTermsDays=30 → 30 days", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "NONE",
      writtenAgreement: false,
      defaultTermsDays: 30,
    });
    expect(daysBetween(INVOICE, d)).toBe(30);
  });

  it("MICRO ignores defaultTermsDays — 43B(h) is the hard ceiling", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "MICRO",
      writtenAgreement: true,
      defaultTermsDays: 90, // would be a 43B(h) violation if honoured
    });
    expect(daysBetween(INVOICE, d)).toBe(MSME_WRITTEN_AGREEMENT_DAYS);
  });

  it("defaults writtenAgreement to false (safer = shorter deadline)", () => {
    const d = computeMsmePaymentDeadline({
      invoiceDate: INVOICE,
      counterpartyMsmeStatus: "SMALL",
    });
    expect(daysBetween(INVOICE, d)).toBe(MSME_NO_WRITTEN_AGREEMENT_DAYS);
  });
});

describe("isValidUdyamNumber", () => {
  it("accepts a well-formed Udyam number", () => {
    expect(isValidUdyamNumber("UDYAM-MH-12-1234567")).toBe(true);
  });
  it("rejects malformed values", () => {
    expect(isValidUdyamNumber(null)).toBe(false);
    expect(isValidUdyamNumber("UDYAM-mh-12-1234567")).toBe(false);
    expect(isValidUdyamNumber("UDYAM-MH-1-1234567")).toBe(false);
    expect(isValidUdyamNumber("UDYAM-MH-12-12345")).toBe(false);
  });
});
