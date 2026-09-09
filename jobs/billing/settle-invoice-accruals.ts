/**
 * #771 / #749 — monthly consolidated rollup cron: roll each org's unbilled
 * INVOICE_ACCRUAL / OVERAGE_INVOICE_ACCRUAL bookings into one
 * OrganizationInvoice per org. Thin wrapper over `rollupOrgInvoiceAccruals`,
 * scheduled monthly alongside `generate-subscription-invoices`.
 *
 * E2E-audit P0 fix — this job is now ENABLED BY DEFAULT (opt-out via
 * ENABLE_CONSOLIDATED_INVOICE="false"). It shipped default-off while being
 * the ONLY path from INVOICE_ACCRUAL legs to an actual invoice, so with the
 * shipped config org INVOICE-rail bookings and CHARGE_ORG overages accrued
 * forever, grew unbounded credit-limit exposure in checkout, and produced no
 * GST document — a money black hole.
 *
 * #813 — two real defences against double-billing, not the unimplemented
 * "lock discipline" the old docstring claimed: (1) the workflow `concurrency`
 * block serialises job-level runs, and (2) `rollupOrgInvoiceAccruals` reads
 * the unstamped set inside a Serializable tx, so overlapping per-org runs
 * either abort (P2034) or see the empty set.
 *
 * #1347 — the rollup now retries a P2034 itself. One reaching this job means
 * the retries were exhausted, which is no longer a benign skip: the org goes
 * unbilled for the cycle, so it is recorded as a SystemEvent (and thereby
 * Sentry) rather than logged. The job still continues to the next org — one
 * contended org must not strand every other org's invoice.
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

export async function settleInvoiceAccruals(): Promise<{
  orgsProcessed: number;
  invoicesCreated: number;
}> {
  if (process.env.ENABLE_CONSOLIDATED_INVOICE === "false") {
    console.log(
      '[settle-invoice-accruals] ENABLE_CONSOLIDATED_INVOICE === "false" — skipping (explicit opt-out)',
    );
    return { orgsProcessed: 0, invoicesCreated: 0 };
  }

  // Distinct orgs with at least one unbilled accrual. Include
  // OVERAGE_INVOICE_ACCRUAL: an org whose base bookings are all LICENSE-covered
  // (₹0 legs) but has CHARGE_ORG overage would otherwise be skipped here and
  // never billed for the overage (the rollup itself already bills both sources).
  const rows = await prisma.payment.findMany({
    where: {
      billableToOrgInvoiceId: null,
      paymentStatus: "SUCCEEDED",
      organizationId: { not: null },
      legs: {
        some: {
          source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] },
        },
      },
    },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });

  let invoicesCreated = 0;
  for (const row of rows) {
    if (!row.organizationId) continue;
    try {
      const r = await rollupOrgInvoiceAccruals({
        organizationId: row.organizationId,
        issueImmediately: true,
      });
      if (r.invoiceId) {
        invoicesCreated++;
        console.log(
          `[settle-invoice-accruals] org ${row.organizationId}: invoice ${r.invoiceNumber} for ${r.billedPaymentCount} bookings (₹${(r.totalPaise / 100).toFixed(2)})`,
        );
      }
    } catch (err) {
      // #1347 — a P2034 that survived the rollup's bounded retries. Skip
      // semantics are kept (the next org still runs) but the org is left
      // unbilled for this cycle, so it is reported, not logged away.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2034"
      ) {
        await recordSystemError({
          organizationId: row.organizationId,
          category: "INVOICE",
          summary: `Consolidated invoice rollup exhausted its serialization retries for org ${row.organizationId} — its unbilled accruals were NOT invoiced this cycle and will be retried on the next run`,
          err,
          context: { organizationId: row.organizationId, prismaCode: "P2034" },
        });
        continue;
      }
      console.error(
        `[settle-invoice-accruals] org ${row.organizationId} failed:`,
        err instanceof Error ? err.message : err,
      );
      Sentry.captureException(err, {
        tags: { subsystem: "jobs", job: "settle-invoice-accruals" },
      });
    }
  }

  return { orgsProcessed: rows.length, invoicesCreated };
}

/**
 * The locked core both entry points share — the Actions run below and the
 * CRON_SECRET twin at `app/api/cleanup/settle-invoice-accruals/route.ts`. The
 * lock has to live here rather than in `main`, or the HTTP call would bill the
 * same accrual set alongside a scheduled run. The maintenance guard does NOT:
 * `abortIfMaintenance` exits the process, which inside the Next server would
 * take the instance down, so each entry point applies its own flavour
 * (`abortIfMaintenance` here, `assertNotInMaintenance` in `cleanupRoute`).
 */
export async function runSettleInvoiceAccruals(): Promise<{
  orgsProcessed: number;
  invoicesCreated: number;
}> {
  return withCronLock(
    "settle-invoice-accruals",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => settleInvoiceAccruals(),
  );
}

async function main() {
  console.log(
    `[settle-invoice-accruals] Starting at ${new Date().toISOString()}`,
  );
  Sentry.logger.info("job:settle-invoice-accruals started");
  await abortIfMaintenance("settle-invoice-accruals");
  const r = await runSettleInvoiceAccruals();
  console.log(
    `[settle-invoice-accruals] Done. orgsProcessed=${r.orgsProcessed} invoicesCreated=${r.invoicesCreated}`,
  );
  Sentry.logger.info("job:settle-invoice-accruals finished", {
    orgsProcessed: r.orgsProcessed,
    invoicesCreated: r.invoicesCreated,
  });
}

if (require.main === module) {
  runJob("settle-invoice-accruals", () =>
    main().finally(() => prisma.$disconnect()),
  );
}
