/**
 * Shared request handling for the consumer (B2C) statutory PDF downloads.
 *
 * The tax-invoice route and the credit-note route differ only in which row
 * they load and which renderer they hand it to. Everything around that — who
 * is allowed to ask, the per-actor rate limit, the fail-closed supplier gate,
 * the 24-hour render cache, the upload-and-stamp, and the redirect to a signed
 * URL — is one contract, and it is the part that must not drift between the
 * two documents. A buyer whose credit note were served under weaker rules than
 * their invoice would be a real leak, so the rules live here once.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import {
  consumerPdfStoragePathFor,
  uploadInvoicePdf,
  createInvoicePdfSignedUrl,
} from "@/lib/pdf/storage";
import { getPlatformSupplier, type PlatformSupplier } from "@/lib/pdf/supplier";

/** 24h — matches the signed-URL TTL, so a cached path always re-signs cleanly. */
const PDF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The minimum a loaded document must expose for this helper to authorise it,
 * cache it and stamp it. Callers select whatever else their renderer needs.
 */
export interface ConsumerPdfDocument {
  /** Row id; also the object name under the buyer's storage prefix. */
  id: string;
  /** The buyer who may download it. Anyone else needs ADMIN or STAFF. */
  ownerUserId: string;
  pdfStoragePath: string | null;
  pdfGeneratedAt: Date | null;
}

export interface ServeConsumerPdfArgs<TDoc extends ConsumerPdfDocument> {
  /** Structured-log event name used if rendering throws. */
  event: string;
  /** Identifiers for that log line. Never include buyer data. */
  logContext: Record<string, string>;
  /** Message returned with the 500 when rendering fails. */
  failureMessage: string;
  /** Load the row, or null when no such document was ever issued. */
  load: () => Promise<TDoc | null>;
  /** Render the loaded row. The supplier is passed through already gated. */
  render: (doc: TDoc, supplier: PlatformSupplier) => Promise<Buffer>;
  /** Persist the render cache on the row the document came from. */
  stamp: (args: {
    id: string;
    pdfStoragePath: string;
    pdfGeneratedAt: Date;
  }) => Promise<void>;
}

export async function serveConsumerPdf<TDoc extends ConsumerPdfDocument>(
  args: ServeConsumerPdfArgs<TDoc>,
): Promise<Response> {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate-limited per actor: rendering a PDF is expensive, and the bucket is
  // shared with the other money operations this user can trigger.
  const limited = await applyRateLimit(moneyOpsLimiter, session.user.id);
  if (limited) return limited;

  // Fail closed on supplier identity (#1132/#1230): a statutory document
  // carrying a fabricated GSTIN is worse than no download at all.
  const supplier = getPlatformSupplier();
  if (!supplier) {
    return NextResponse.json(
      {
        error:
          "PLATFORM_GSTIN is not configured; the platform cannot issue statutory documents.",
        code: "SUPPLIER_GSTIN_UNCONFIGURED",
      },
      { status: 503 },
    );
  }

  const doc = await args.load();
  if (!doc) {
    return NextResponse.json(
      {
        error: "No such statutory document has been issued for this payment.",
        code: "INVOICE_NOT_ISSUED",
      },
      { status: 404 },
    );
  }

  if (doc.ownerUserId !== session.user.id && !isPrivileged(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cachedPath = doc.pdfStoragePath;
  const cachedIsFresh =
    cachedPath !== null &&
    doc.pdfGeneratedAt !== null &&
    Date.now() - doc.pdfGeneratedAt.getTime() < PDF_CACHE_TTL_MS;

  try {
    if (cachedIsFresh && cachedPath) {
      // Re-sign without re-rendering; createSignedUrl is a single cheap call.
      const url = await createInvoicePdfSignedUrl(cachedPath);
      return NextResponse.redirect(url, { status: 302 });
    }

    const buffer = await args.render(doc, supplier);
    const storagePath = consumerPdfStoragePathFor(doc.ownerUserId, doc.id);
    await uploadInvoicePdf({ storagePath, buffer });
    await args.stamp({
      id: doc.id,
      pdfStoragePath: storagePath,
      pdfGeneratedAt: new Date(),
    });

    const url = await createInvoicePdfSignedUrl(storagePath);
    return NextResponse.redirect(url, { status: 302 });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: args.event,
        ...args.logContext,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      {
        tags: { subsystem: "payments" },
      },
    );
    return NextResponse.json({ error: args.failureMessage }, { status: 500 });
  }
}
