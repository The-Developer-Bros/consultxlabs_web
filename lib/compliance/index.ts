/**
 * India compliance barrel.
 *
 * Status as of 2026-07-17:
 *   - tds.ts          — DTAA + section selection live; rate constant
 *                       still being normalised (see compliance docs 01).
 *   - msme.ts         — `computeMsmePaymentDeadline` live (15/45-day rule).
 *   - gst.ts          — `deriveGstBreakdown` live (CGST/SGST/IGST split).
 *   - irp.ts          — env-gated ClearTax connector (production-approval
 *                       still pending).
 *   - dpdp.ts         — `buildConsentArtifact` + `checkConsent` (fail-closed)
 *                       live. `checkConsent` is now wired at org-sponsored
 *                       checkout, invite acceptance, and data export (#701);
 *                       the remaining call-site cascade (SCIM / Stream /
 *                       analytics) is tracked in #701.
 *   - form15.ts       — schema-only; cross-border remittance refs not
 *                       yet captured. See compliance doc 07.
 *
 * The full live-implementation plan lives in:
 *
 *   docs/compliance/13-implementation-roadmap.md
 *
 * Callers MUST treat any function still flagged as a stub ("form15.*") as
 * "sensible default, safe but not compliant" and NOT rely on it for:
 *   - Audit-ready filings
 *   - Cross-border remittance approvals
 *
 * See each module's header docblock for live-implementation status.
 */

export * from "./tds";
export * from "./msme";
export * from "./gst";
export * from "./irp";
export * from "./dpdp";
export * from "./purpose-codes";
export * from "./form15";
