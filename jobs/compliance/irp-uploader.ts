/**
 * Cron: IRP (Invoice Registration Portal) uploader — Issue #681.
 *
 * STATUS: body live, env-gated. The cron iterates eligible invoices and
 * calls `lib/compliance/irp.generateIrn`. When `CLEARTAX_API_KEY`,
 * `CLEARTAX_GSP_TOKEN`, and `CLEARTAX_GSTIN` are configured, the
 * connector posts the invoice payload to ClearTax GSP and persists
 * `irn`, `ackNumber`, `signedQrPayload`, `irpStatus`, plus retry
 * telemetry (`irpRetryCount`, `irpLastError`, `irpLastAttemptAt`).
 * When env vars are absent, `generateIrn` returns
 * `{ status: "FAILED", reason: "STUB" }` and the uploader records that
 * as a normal retry — the cron does not crash on missing credentials.
 *
 * Production approval requires:
 *   1. Sandbox credentials provisioned and end-to-end tested
 *   2. Payload mapping validated against CBIC schema (HSN, GSTIN, amounts)
 *   3. 24-hour IRN cancellation window behaviour proven
 *   4. Accountant / legal sign-off on IRN format and invoice sequence
 *   5. Retry dashboard and ops runbook in place (see docs/enterprise/50-operations/03-runbooks.md)
 *
 * Schedule: daily at 02:50 UTC (08:20 IST; #709 minute map).
 * GH Actions: `.github/workflows/irp-uploader.yml`.
 * Scope: OrganizationInvoice with irpStatus=PENDING, issuedAt within 30d
 *        (CBIC cut-off for retroactive IRN generation). Batch size: 50.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. See
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import prisma from "@/lib/prisma";
import { generateIrn } from "@/lib/compliance/irp";
import { buildIrpPayload } from "@/lib/compliance/irp-payload";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import { isValidGstin } from "@/lib/compliance/gst";

// #703 — platform-side seller constants. GSTIN mirrors the invoice-PDF
// route (PLATFORM_GSTIN); the rest are env-overridable for a future
// per-region supplier. Seller state code is derived from the GSTIN prefix
// inside the mapper, SUPPLIER_STATE_CODE is the fallback.
// CR #1234 — the dummy-GSTIN fallback is gone: an unset or malformed
// PLATFORM_GSTIN yields null, the uploader skips the batch item with a
// logged reason, and buildIrpPayload's own missing-GSTIN guard stays the
// second net. No statutory payload may carry a fabricated identity.
const SELLER = (() => {
  const gstin = process.env.PLATFORM_GSTIN?.trim();
  return {
    gstin: gstin && isValidGstin(gstin) ? gstin : null,
    legalName:
      process.env.SUPPLIER_LEGAL_NAME ??
      "Familiarise Technologies Private Limited",
    address1: process.env.SUPPLIER_ADDR1 ?? "Koramangala 1st Block",
    location: process.env.SUPPLIER_LOCATION ?? "Bangalore",
    pincode: process.env.SUPPLIER_PINCODE ?? "560034",
    stateCode: process.env.SUPPLIER_STATE_CODE ?? "KA",
  };
})();

// #476 — entry-level cron lock, fail-closed: an IRN is a statutory object
// registered with the government and cancellable only inside a 24-hour window,
// so two runners both believing they hold the lock while Redis is unreachable
// is the one outcome this job may never risk.
export async function runIrpUploader(): Promise<{
  processed: number;
  failed: number;
  skipped: number;
}> {
  return withCronLock("irp-uploader", { failMode: "closed" }, () =>
    runIrpUploaderUnlocked(),
  );
}

/**
 * S3776 — NIC payload assembly extracted from the run loop. The candidate is
 * the fetched invoice row (with organization + lineItems); mapping failures
 * are the caller's concern.
 */
function buildPayloadFor(
  candidate: Awaited<ReturnType<typeof fetchIrpCandidates>>[number],
  sellerGstin: string,
) {
  return buildIrpPayload({
    invoice: {
      invoiceNumber: candidate.invoiceNumber,
      issuedAt: candidate.issuedAt,
      reverseCharge: candidate.reverseCharge,
      lutNumber: candidate.lutNumber,
      subtotalPaise: candidate.subtotalPaise,
      cgstPaise: candidate.cgstPaise,
      sgstPaise: candidate.sgstPaise,
      igstPaise: candidate.igstPaise,
      totalPaise: candidate.totalPaise,
      hsnCode: candidate.hsnCode,
      placeOfSupply: candidate.placeOfSupply,
    },
    lineItems: candidate.lineItems,
    buyer: {
      name: candidate.organization.name,
      gstin: candidate.organization.taxInfo?.gstin ?? null,
      stateCode: candidate.organization.taxInfo?.gstStateCode ?? null,
      hsnDefault: candidate.organization.taxInfo?.hsnDefault ?? "999293",
    },
    seller: { ...SELLER, gstin: sellerGstin },
  });
}

async function fetchIrpCandidates(thirtyDaysAgo: Date) {
  return prisma.organizationInvoice.findMany({
    where: {
      irpStatus: "PENDING",
      issuedAt: { gte: thirtyDaysAgo, not: null },
    },
    // #703 — widen to everything the payload mapper needs (split paise,
    // place-of-supply, line items, buyer tax info). The mapper is pure;
    // the cron does the fetch.
    select: {
      id: true,
      invoiceNumber: true,
      issuedAt: true,
      reverseCharge: true,
      lutNumber: true,
      subtotalPaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
      hsnCode: true,
      placeOfSupply: true,
      irpRetryCount: true,
      organization: {
        select: {
          name: true,
          taxInfo: {
            select: { gstin: true, gstStateCode: true, hsnDefault: true },
          },
        },
      },
      lineItems: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          description: true,
          quantity: true,
          unitPricePaise: true,
          hsnCode: true,
        },
      },
    },
    take: 50, // batch size
  });
}

/**
 * S3776 (CR #1234 r5) — one candidate's full lifecycle: map to NIC payload
 * (permanent failure on unmappable data), call the IRP, and persist the
 * resulting state. Returns the counter bucket for the caller's aggregates.
 */
async function processIrpCandidate(
  candidate: Awaited<ReturnType<typeof fetchIrpCandidates>>[number],
  sellerGstin: string,
): Promise<"processed" | "failed" | "skipped"> {
  const mapped = buildPayloadFor(candidate, sellerGstin);

  if (!mapped.ok) {
    await prisma.organizationInvoice.update({
      where: { id: candidate.id },
      data: {
        irpStatus: "FAILED", // permanent — do not loop
        irpLastError: `MAP: ${mapped.reason}`.slice(0, 500),
        irpLastAttemptAt: new Date(),
      },
    });
    return "failed";
  }

  const result = await generateIrn({
    invoiceId: candidate.id,
    payload: mapped.payload,
  });

  if (result.status === "GENERATED" && result.irn) {
    await prisma.organizationInvoice.update({
      where: { id: candidate.id },
      data: {
        irn: result.irn,
        ackNumber: result.ackNumber,
        ackDate: result.ackDate,
        signedQrPayload: result.signedQrPayload,
        irpStatus: "GENERATED",
        irpUploadedAt: new Date(),
        irpLastError: null,
        irpLastAttemptAt: new Date(),
      },
    });
    return "processed";
  }

  // Retryable failure: stay PENDING with bounded attempts (≈12 daily ticks)
  // before flipping FAILED past the 30-day IRN hard cut-off.
  if (result.status === "FAILED") {
    const MAX_RETRIES = 12;
    const nextRetryCount = (candidate.irpRetryCount ?? 0) + 1;
    const exhausted = nextRetryCount >= MAX_RETRIES;

    await prisma.organizationInvoice.update({
      where: { id: candidate.id },
      data: {
        irpStatus: exhausted ? "FAILED" : "PENDING",
        irpLastError: result.reason.slice(0, 500),
        irpLastAttemptAt: new Date(),
        irpRetryCount: nextRetryCount,
      },
    });
    return exhausted ? "failed" : "skipped";
  }

  return "skipped";
}

async function runIrpUploaderUnlocked(): Promise<{
  processed: number;
  failed: number;
  skipped: number;
}> {
  console.log("[cron][irp-uploader] starting");
  Sentry.logger.info("job:irp-uploader started");

  // Config gate before any invoice is touched: a missing/malformed
  // PLATFORM_GSTIN is an ENV outage, not a per-invoice defect — failing each
  // candidate permanently (MAP: seller GSTIN missing) would burn the whole
  // queue on a fixable config slip.
  const sellerGstin = SELLER.gstin;
  if (!sellerGstin) {
    console.error(
      "[cron][irp-uploader] PLATFORM_GSTIN missing or malformed — skipping run",
    );
    return { processed: 0, failed: 0, skipped: 0 };
  }
  // CR #1234 r5 — preflight the FULL provider configuration. generateIrn
  // marks rows FAILED on a missing CLEARTAX_* credential, so an auth outage
  // would burn all twelve retries per pending invoice and permanently fail
  // them before the environment is fixed. A missing setting is an ENV
  // outage: skip the run, leave every row PENDING, recover automatically.
  const missingCleartax = [
    "CLEARTAX_API_KEY",
    "CLEARTAX_GSP_TOKEN",
    "CLEARTAX_GSTIN",
  ].filter((k) => !process.env[k]?.trim());
  if (missingCleartax.length > 0) {
    console.error(
      `[cron][irp-uploader] IRP provider config missing (${missingCleartax.join(", ")}) — skipping run; invoices stay PENDING`,
    );
    return { processed: 0, failed: 0, skipped: 0 };
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const candidates = await fetchIrpCandidates(thirtyDaysAgo);

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    // CR #1234 r5 — per-candidate mapping/submission/state-update lives in
    // processIrpCandidate; this loop keeps only the aggregate counters.
    const outcome = await processIrpCandidate(candidate, sellerGstin);
    if (outcome === "processed") processed++;
    else if (outcome === "failed") failed++;
    else skipped++;
  }

  console.log(
    `[IRP] uploader finished — processed=${processed} failed=${failed} skipped=${skipped}`,
  );
  Sentry.logger.info("job:irp-uploader finished", {
    processed,
    failed,
    skipped,
  });
  return { processed, failed, skipped };
}

// Self-execute when invoked directly via `npx tsx`. Allows imports for
// unit tests without triggering the cron body. Mirrors the pattern in
// jobs/contracts/expire-contracts.ts.
if (require.main === module) {
  runJob("irp-uploader", async () => {
    await abortIfMaintenance("irp-uploader");
    await runIrpUploader().finally(() => prisma.$disconnect());
  });
}
