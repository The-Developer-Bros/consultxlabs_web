/**
 * Platform supplier identity for statutory documents (tax invoices, credit
 * notes, IRP payloads).
 *
 * #1132/#1230 — this used to fall back to a hard-coded dummy GSTIN
 * ("29AAFCF1234Q1ZN") when PLATFORM_GSTIN was unset, which produced
 * legal-looking tax invoices carrying a fabricated GSTIN if an env var ever
 * slipped. The contract is now FAIL-CLOSED: callers must handle the null
 * case (the PDF routes return 503 with an ops-actionable message) rather
 * than minting documents a GST officer would flag as impersonation.
 */

import { isValidGstin } from "@/lib/compliance/gst";

export interface PlatformSupplier {
  name: string;
  gstin: string;
  address: string;
  email: string;
}

/**
 * Returns the platform supplier identity, or null when PLATFORM_GSTIN is
 * not configured. Kept as a read (not a throwing helper) so callers choose
 * their own failure shape — a 503 on a download route vs. skipping an IRP
 * batch item with EXPIRED_WINDOW semantics.
 */
export function getPlatformSupplier(): PlatformSupplier | null {
  const gstin = process.env.PLATFORM_GSTIN?.trim();
  // Format-gate (CR #1234): a typo'd PLATFORM_GSTIN must fail closed like an
  // absent one — "not-a-gstin" on statutory documents is the same defect as
  // the old dummy fallback, just quieter.
  if (!gstin || !isValidGstin(gstin)) return null;
  return {
    name: "Familiarise Technologies Private Limited",
    gstin,
    address: "Koramangala 1st Block, Bangalore, Karnataka 560034, India",
    email: "billing@familiarise.com",
  };
}
