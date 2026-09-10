/**
 * Cron: generate BillingSubscription-driven invoices — REAL (Issue #681).
 *
 * Schedule: daily at 01:00 UTC (06:30 IST).
 * Scope: every `BillingSubscription` with `nextInvoiceDate <= now`.
 *
 * Concurrency:
 *   Each due subscription is handled inside a Serializable `$transaction`.
 *   The claim step is a conditional `updateMany` that only advances
 *   `nextInvoiceDate` if it's still `<= now` — this doubles as the
 *   distributed lock: two cron replicas (or a retried invocation) race
 *   on the UPDATE, exactly one wins, the loser's `claimed.count === 0`
 *   and it silently skips. All three side-effects
 *   (invoice create + cycle advance + settlement ledger) commit
 *   together so a crash mid-way cannot produce a duplicate invoice on
 *   the next run.
 *
 * For each due subscription:
 *   1. Compute the invoice amount (flatFeePaise for FLAT_FEE, or
 *      activeSeatCount × ratePerSeatPaise for PER_SEAT).
 *   2. Atomically claim the subscription by advancing `nextInvoiceDate`
 *      from `<= now` to the next cycle end.
 *   3. Create an OrganizationInvoice with GST breakdown (stubbed via
 *      lib/compliance/gst.ts).
 *   4. Emit a SettlementLedgerEntry (kind=INVOICE_ISSUED).
 *
 * IRP upload is handled by the separate `irp-uploader.ts` cron.
 */

import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { generateOrgInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { BILLABLE_ORG_STATUSES } from "@/lib/enterprise/org-status";
import {
  notifyOrgLicenseRenewalUpcoming,
  notifyOrgInvoiceIssued,
} from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";
import { Currency, OrgInvoiceStatus, Prisma } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import { reportSentryError } from "@/lib/observability/report";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

// Reminder fires when nextInvoiceDate is within this many days. Once
// per cycle (gated by BillingSubscription.renewalReminderSentAt).
const RENEWAL_REMINDER_WINDOW_DAYS = 7;

export async function runGenerateSubscriptionInvoices(): Promise<{
  generated: number;
  skipped: number;
  remindersSent: number;
}> {
  await abortIfMaintenance("generate-subscription-invoices");
  const now = new Date();
  const remindersSent = await sendRenewalReminders(now);

  const dueSubs = await prisma.billingSubscription.findMany({
    where: {
      nextInvoiceDate: { lte: now },
      contract: {
        organization: { status: { in: BILLABLE_ORG_STATUSES } },
        // E2E-audit P0 fix — only bill contracts that are ACTIVE and within
        // their term. This cron used to filter on org status alone, so a
        // TERMINATED / EXPIRED / superseded contract kept issuing invoices
        // every cycle forever (its docstring even claimed the expire cron
        // enforced this — it doesn't; that cron only stamps contract status).
        status: "ACTIVE",
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
    },
    include: {
      contract: {
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              invoiceNumberPrefix: true,
              taxInfo: { select: { gstStateCode: true, gstin: true } },
            },
          },
        },
      },
      billingAccount: true,
    },
  });

  let generated = 0;
  let skipped = 0;

  for (const sub of dueSubs) {
    const subtotal =
      sub.model === "FLAT_FEE"
        ? (sub.flatFeePaise ?? 0)
        : (sub.ratePerSeatPaise ?? 0) * sub.activeSeatCount;
    if (subtotal <= 0) {
      console.warn(
        `[cron] Skipping subscription ${sub.id} with non-positive subtotal`,
      );
      skipped++;
      continue;
    }

    const gst = deriveGstBreakdown({
      subtotalPaise: subtotal,
      // Supplier state defaults to Karnataka but is env-overridable so a
      // change of business address (or a regional GSTIN) doesn't require
      // a code change. Place-of-supply rules use this to decide CGST+SGST
      // vs IGST split.
      supplierStateCode: process.env.SUPPLIER_STATE_CODE ?? "KA",
      buyerStateCode: sub.contract.organization.taxInfo?.gstStateCode ?? null,
      buyerCountry: "IN",
    });

    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + sub.contract.paymentTermsDays);

    // Advance cycle once — compute outside the tx for a stable target.
    const nextStart = sub.currentCycleEnd;
    const nextEnd = new Date(nextStart);
    if (sub.cycle === "MONTHLY") nextEnd.setMonth(nextEnd.getMonth() + 1);
    else if (sub.cycle === "QUARTERLY")
      nextEnd.setMonth(nextEnd.getMonth() + 3);
    else nextEnd.setFullYear(nextEnd.getFullYear() + 1);

    // #1401 — held outside the transaction so the P2002 handler below can name
    // the number that collided; the value is only meaningful once the claim has
    // been won and the counter reserved.
    let competingInvoiceNumber: string | undefined;

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Claim: advance nextInvoiceDate atomically. Only one worker
          // can win this UPDATE because we gate on the pre-update value.
          const claimed = await tx.billingSubscription.updateMany({
            where: {
              id: sub.id,
              nextInvoiceDate: { lte: now },
              // Re-checked AT CLAIM TIME: the contract may have terminated
              // (or its term ended) between the cohort read and this write.
              contract: {
                status: "ACTIVE",
                OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
              },
            },
            data: {
              currentCycleStart: nextStart,
              currentCycleEnd: nextEnd,
              nextInvoiceDate: nextEnd,
              // New cycle, new reminder window — clear the gate so
              // the upcoming-renewal Novu fires once before nextEnd.
              renewalReminderSentAt: null,
            },
          });
          if (claimed.count === 0) {
            return { claimed: false as const };
          }

          // Per-org sequential number — atomic counter reservation.
          const { invoiceNumber, fiscalYear } = await generateOrgInvoiceNumber(
            tx,
            {
              id: sub.contract.organization.id,
              slug: sub.contract.organization.slug,
              invoiceNumberPrefix: sub.contract.organization.invoiceNumberPrefix,
            },
            now,
          );
          competingInvoiceNumber = invoiceNumber;

          const invoice = await tx.organizationInvoice.create({
            data: {
              billingAccountId: sub.billingAccountId,
              organizationId: sub.contract.organization.id,
              invoiceNumber,
              fiscalYear,
              status: OrgInvoiceStatus.ISSUED,
              displayCurrency: Currency.INR,
              inrEquivalentPaise: gst.totalPaise,
              subtotalPaise: gst.subtotalPaise,
              igstPaise: gst.igstPaise,
              cgstPaise: gst.cgstPaise,
              sgstPaise: gst.sgstPaise,
              totalPaise: gst.totalPaise,
              hsnCode: gst.hsnCode,
              placeOfSupply: gst.placeOfSupply,
              reverseCharge: gst.reverseCharge,
              gstin: sub.contract.organization.taxInfo?.gstin ?? null,
              lineItems: {
                create: [
                  {
                    position: 0,
                    description:
                      sub.model === "FLAT_FEE"
                        ? "Enterprise license flat fee"
                        : `Per-seat license × ${sub.activeSeatCount} seats`,
                    quantity:
                      sub.model === "PER_SEAT" ? sub.activeSeatCount : 1,
                    unitPricePaise:
                      sub.model === "FLAT_FEE"
                        ? (sub.flatFeePaise ?? 0)
                        : (sub.ratePerSeatPaise ?? 0),
                  },
                ],
              },
              issuedAt: now,
              dueDate,
              billingCycleStart: sub.currentCycleStart,
              billingCycleEnd: sub.currentCycleEnd,
              autoGenerated: true,
            },
          });

          return {
            claimed: true as const,
            invoiceId: invoice.id,
            invoiceNumber,
            totalPaise: gst.totalPaise,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      if (result.claimed) {
        generated++;
        // #438 — email the issued invoice (bell + billingEmail channel). No
        // request in a cron, so build the origin from getAppUrl(). Fire-and-
        // forget, mirroring notifyOrgLicenseRenewalUpcoming below.
        const origin = getAppUrl();
        const orgId = sub.contract.organization.id;
        void notifyOrgInvoiceIssued(orgId, {
          invoiceNumber: result.invoiceNumber,
          orgName: sub.contract.organization.name,
          totalPaise: result.totalPaise,
          currency: Currency.INR,
          dueDate: dueDate.toISOString(),
          dashboardUrl: `${origin}/dashboard/organization/${orgId}/billing`,
          pdfUrl: `${origin}/api/organizations/${orgId}/billing-account/invoices/${result.invoiceId}/pdf`,
        }).catch((err) =>
          console.error("[cron] notifyOrgInvoiceIssued failed:", err),
        );
        // E2E-audit P1 fix — cron-issued invoices never emitted
        // `invoice.issued`, so integrators (HRIS/ERP) only ever saw
        // manually-created invoices. Same payload shape as the manual route.
        void dispatchWebhookEvent({
          prisma,
          organizationId: orgId,
          eventType: "invoice.issued",
          payload: {
            invoiceId: result.invoiceId,
            invoiceNumber: result.invoiceNumber,
            totalPaise: result.totalPaise,
            displayCurrency: Currency.INR,
            dueDate: dueDate.toISOString(),
            purchaseOrderId: null,
            contractId: sub.contract.id,
          },
        }).catch((err) =>
          console.error("[cron] invoice.issued webhook failed:", err),
        );
      } else {
        console.log(
          `[cron] Subscription ${sub.id} already claimed by another worker, skipping`,
        );
        skipped++;
      }
    } catch (err) {
      // Unique-number collision (two parallel workers computed the same
      // invoiceNumber while their claim-UPDATE was still in flight) is
      // the one other failure mode worth handling gracefully. The cron
      // is idempotent on its next run.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        console.warn(
          `[cron] Duplicate invoiceNumber for subscription ${sub.id}; will retry next run`,
        );
        // #1401 — no number burns: the counter reservation runs inside this
        // same Serializable transaction, so the collision rolls the sequence
        // back with it and the next run re-issues cleanly. What was missing is
        // that nobody heard about it — a console.warn in a cron is not an
        // alert, and a repeating collision means the claim UPDATE has stopped
        // serialising the workers, which is worth waking someone for. Alerting
        // only; the skip-and-retry behaviour is unchanged.
        reportSentryError(err, {
          subsystem: "jobs",
          op: "generate-subscription-invoices",
          level: "error",
          extra: { subscriptionId: sub.id, competingInvoiceNumber },
        });
        // One capture, not two: recordSystemError escalates to Sentry itself,
        // and its escalation drops `context`, so the collision extras would
        // only survive on the reportSentryError event above. The durable row
        // is written through recordSystemEvent directly instead. Awaited: the
        // insert rides this job's Prisma client, and a fire-and-forget one
        // loses the audit row to the `$disconnect()` at the end of `main`.
        await recordSystemEvent({
          organizationId: sub.contract.organization.id,
          category: "INVOICE",
          severity: "ERROR",
          message: `Duplicate invoice number on subscription ${sub.id}: ${err.message}`,
          context: {
            subscriptionId: sub.id,
            competingInvoiceNumber,
            errorMessage: err.message,
          },
        }).catch(() => {});
        skipped++;
        continue;
      }
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "generate-subscription-invoices" } });
      console.error(
        `[cron] Failed to generate invoice for subscription ${sub.id}:`,
        err,
      );
      skipped++;
    }
  }

  console.log(
    `[cron] generate-subscription-invoices: ${generated} invoices, ${skipped} skipped, ${remindersSent} renewal reminders`,
  );
  return { generated, skipped, remindersSent };
}

async function sendRenewalReminders(now: Date): Promise<number> {
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + RENEWAL_REMINDER_WINDOW_DAYS);

  const due = await prisma.billingSubscription.findMany({
    where: {
      renewalReminderSentAt: null,
      nextInvoiceDate: { gt: now, lte: horizon },
      contract: {
        organization: { status: { in: BILLABLE_ORG_STATUSES } },
      },
    },
    include: {
      contract: {
        include: {
          organization: { select: { id: true, name: true } },
        },
      },
    },
  });

  let sent = 0;
  for (const sub of due) {
    const expectedTotalPaise =
      sub.model === "FLAT_FEE"
        ? (sub.flatFeePaise ?? 0)
        : (sub.ratePerSeatPaise ?? 0) * sub.activeSeatCount;

    const daysUntilRenewal = Math.max(
      0,
      Math.ceil(
        (sub.nextInvoiceDate.getTime() - now.getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    );

    // Claim first so a crashed Novu trigger doesn't double-fire on the
    // next cron tick. Conditional update gates on the still-null
    // value, mirroring the invoice claim pattern below.
    const claimed = await prisma.billingSubscription.updateMany({
      where: { id: sub.id, renewalReminderSentAt: null },
      data: { renewalReminderSentAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      await notifyOrgLicenseRenewalUpcoming(sub.contract.organization.id, {
        orgName: sub.contract.organization.name,
        cycle: sub.cycle,
        renewalDate: sub.nextInvoiceDate.toISOString(),
        daysUntilRenewal,
        expectedTotalPaise,
        currency: "INR",
        dashboardUrl: `${getAppUrl()}/dashboard/organization/${sub.contract.organization.id}/billing`,
      });
      sent++;
    } catch (err) {
      // Novu non-throwing already, but belt-and-braces — the claim
      // already committed so re-running won't double-send.
      console.error(
        `[cron] renewal-upcoming notify failed for sub ${sub.id}:`,
        err,
      );
    }
  }
  return sent;
}

async function main() {
  console.log(
    `[generate-subscription-invoices] Starting at ${new Date().toISOString()}`,
  );
  Sentry.logger.info("job:generate-subscription-invoices started");
  const result = await withCronLock(
    "generate-subscription-invoices",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => runGenerateSubscriptionInvoices(),
  );
  Sentry.logger.info("job:generate-subscription-invoices finished", {
    generated: result?.generated,
    skipped: result?.skipped,
    remindersSent: result?.remindersSent,
  });
}

if (require.main === module) {
  runJob("generate-subscription-invoices", () => main().finally(() => prisma.$disconnect()));
}
