/**
 * PDF storage helpers — Supabase upload + signed URL for invoice PDFs.
 *
 * Thin domain wrapper over the generic primitives in
 * `lib/storage/private-finance-object.ts`. We don't go through the generic
 * `uploadToSupabase` helper in `lib/supabase.ts` because that one bundles
 * upload + signed-URL generation in one call (and hardcodes a 1h TTL); our
 * flow needs to re-sign on cache hits without re-uploading, with a 24h TTL
 * that matches the `pdfGeneratedAt` cache window on `OrganizationInvoice`.
 *
 * Bucket: `org-invoices` (private). Path scheme for invoices:
 * `<orgId>/<invoiceId>.pdf`. The orgId prefix lets a future per-tenant
 * Supabase token scope reads cleanly.
 *
 * #1354 — the primitives moved out of this file so a scheduled job could reach
 * them. This module's own import graph is request-scoped and keeps the
 * `server-only` chain through `lib/supabase.ts`; the leaf module carries no
 * such marker and is what a bare `tsx jobs/...` process imports. The three
 * generic helpers are re-exported here unchanged so existing callers did not
 * have to move.
 */

import {
  createPrivateFinanceSignedUrl,
  uploadPrivateFinanceObject,
} from "@/lib/storage/private-finance-object";

export {
  createPrivateFinanceSignedUrl,
  privateFinanceObjectExists,
  uploadPrivateFinanceObject,
} from "@/lib/storage/private-finance-object";

const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60; // 24h — matches `pdfGeneratedAt` cache semantics

export function pdfStoragePathFor(
  organizationId: string,
  invoiceId: string,
): string {
  return `${organizationId}/${invoiceId}.pdf`;
}

/**
 * Storage path for a consumer (B2C) invoice or credit-note PDF — #1365.
 *
 * Deliberately the SAME private bucket as the org documents, under a
 * `consumer/` prefix keyed by buyer. A second bucket would need its own
 * creation, its own policies and its own retention runbook to hold objects
 * with identical sensitivity and an identical access rule (signed URL, minted
 * only after the route has authorised the caller).
 */
export function consumerPdfStoragePathFor(
  userId: string,
  docId: string,
): string {
  return `consumer/${userId}/${docId}.pdf`;
}

export async function uploadInvoicePdf(args: {
  storagePath: string;
  buffer: Buffer;
}): Promise<void> {
  // upsert=true so a regeneration on status change (REFUNDED / VOID)
  // overwrites the previous PDF rather than failing on conflict.
  await uploadPrivateFinanceObject({
    storagePath: args.storagePath,
    body: args.buffer,
    contentType: "application/pdf",
    cacheControl: "86400",
  });
}

export async function createInvoicePdfSignedUrl(
  storagePath: string,
): Promise<string> {
  return createPrivateFinanceSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
}
