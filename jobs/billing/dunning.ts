/**
 * #779 §A — DUNNING cron. Two stages over OrganizationInvoice:
 *
 *   Stage 1 (first notice): ISSUED + dueDate passed + markedOverdueAt:null
 *     → claim ISSUED→OVERDUE (stamp markedOverdueAt), notify the finance
 *       roster, emit an INVOICE_OVERDUE audit row.
 *   Stage 2 (escalation): OVERDUE rows whose last reminder (or the overdue
 *     stamp) is >7d old AND dunningReminderCount < 3 → claim via the
 *     lastDunningReminderAt gate, bump the count, re-notify with the next
 *     escalation stage.
 *
 * No booking-suspend stage yet — dunningSuspendedAt stays unwritten.
 * TODO(#1319): config-gated booking-suspend cascade once OVERDUE drags past
 * the grace window.
 *
 * Schedule: daily at 05:00 IST (`.github/workflows/dunning.yml`), after the
 * invoice-gen + expire-contracts crons so a freshly-issued/expired invoice
 * is in its final state before dunning reads it.
 *
 * Idempotent: every stamp (markedOverdueAt / lastDunningReminderAt) is an
 * idempotency gate baked into the claim updateMany, so two cron replicas or
 * a same-day re-run can't double-notify.
 *
 * Usage:
 *   npx tsx jobs/billing/dunning.ts
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { ENABLE_DUNNING_SUSPEND } from "@/lib/feature-flags";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { notifyOrgInvoiceOverdue } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

// #779 — 7-day cadence between escalations, capped at 3 reminders.
const REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REMINDERS = 3;

// #812 — Stage 3 (config-gated). After the 3rd reminder, if the invoice is
// still OVERDUE this long past being marked overdue, suspend the org's
// sponsored bookings by stamping `dunningSuspendedAt`. OFF by default — the
// cascade only runs when ENABLE_DUNNING_SUSPEND=true, so wiring it changes
// nothing until explicitly enabled. The booking-side gate lives in checkout.ts
// behind the SAME flag.
const SUSPEND_ENABLED = ENABLE_DUNNING_SUSPEND;
const SUSPEND_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7d past the final reminder

// #779 — only dun orgs that are still reachable. DEACTIVATED orgs are torn
// down; their invoices don't get chased.
const DUNNABLE_ORG_STATUSES = [
  "ACTIVE",
  "PENDING_VERIFICATION",
  "SUSPENDED",
] as const;

interface DunningStats {
  scannedStage1: number;
  markedOverdue: number;
  scannedStage2: number;
  remindersSent: number;
  suspended: number;
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// S3776 — the claim-wrap pattern (retry transient aborts, skip-and-log persistent
// ones) shared by all three stages; extracted from the stage loops so
// runDunning stays under the cognitive-complexity budget.
async function claimInvoiceGuarded(
  inv: { id: string },
  label: string,
  run: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await withSerializableRetry(run);
  } catch (err) {
    console.error(
      `[dunning] ${label} claim failed for invoice ${inv.id}:`,
      err,
    );
    return false;
  }
}

export async function runDunning(): Promise<DunningStats> {
  const stats: DunningStats = {
    scannedStage1: 0,
    markedOverdue: 0,
    scannedStage2: 0,
    remindersSent: 0,
    suspended: 0,
  };
  const now = new Date();

  // ── Stage 1: ISSUED past due → OVERDUE first notice ────────────────────
  const newlyOverdue = await prisma.organizationInvoice.findMany({
    where: {
      status: "ISSUED",
      dueDate: { lt: now },
      markedOverdueAt: null,
      organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
    },
    select: {
      id: true,
      organizationId: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      dueDate: true,
      organization: { select: { name: true } },
    },
  });
  stats.scannedStage1 = newlyOverdue.length;

  for (const inv of newlyOverdue) {
    // #1132 follow-up — transient P2034 aborts are retried by the house
    // helper; persistent failures skip this invoice so one bad row can't
    // kill the day's run.
    const claimed = await claimInvoiceGuarded(inv, "stage", () =>
      prisma.$transaction(
        async (tx) => {
          // Claim the row only if still ISSUED + un-stamped so two replicas
          // don't both flip + notify. Loser sees count 0 and skips.
          const claim = await tx.organizationInvoice.updateMany({
            where: { id: inv.id, status: "ISSUED", markedOverdueAt: null },
            data: { status: "OVERDUE", markedOverdueAt: now },
          });
          if (claim.count === 0) return false;

          await tx.orgAuditLog.create({
            data: {
              organizationId: inv.organizationId,
              actorMembershipId: null,
              targetMembershipId: null,
              category: "INVOICE",
              action: AUDIT_ACTIONS.INVOICE.INVOICE_OVERDUE,
              description: `Invoice ${inv.invoiceNumber} marked OVERDUE (due ${inv.dueDate.toISOString()})`,
              details: {
                invoiceId: inv.id,
                invoiceNumber: inv.invoiceNumber,
                dueDate: inv.dueDate.toISOString(),
                daysLate: daysBetween(inv.dueDate, now),
              },
            },
          });
          return true;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
      ),
    );
    if (!claimed) continue;
    stats.markedOverdue += 1;

    // Fire-and-forget notify outside the tx — committed state, no DB writes.
    void notifyOrgInvoiceOverdue(inv.organizationId, {
      invoiceNumber: inv.invoiceNumber,
      orgName: inv.organization.name,
      totalPaise: inv.totalPaise,
      currency: inv.displayCurrency,
      daysLate: daysBetween(inv.dueDate, now),
      reminderStage: 0,
      payUrl: `${getAppUrl()}/dashboard/organization/${inv.organizationId}/billing`,
    }).catch((err) => console.error("[dunning] stage-1 notify failed:", err));
  }

  // ── Stage 2: OVERDUE escalation reminders (7-day cadence, cap 3) ────────
  const cutoff = new Date(now.getTime() - REMINDER_INTERVAL_MS);
  const dueForReminder = await prisma.organizationInvoice.findMany({
    where: {
      status: "OVERDUE",
      dunningReminderCount: { lt: MAX_REMINDERS },
      organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
      // next reminder when (now - (lastDunningReminderAt ?? markedOverdueAt)) > 7d
      OR: [
        { lastDunningReminderAt: { lt: cutoff } },
        { lastDunningReminderAt: null, markedOverdueAt: { lt: cutoff } },
      ],
    },
    select: {
      id: true,
      organizationId: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      dueDate: true,
      markedOverdueAt: true,
      lastDunningReminderAt: true,
      dunningReminderCount: true,
      organization: { select: { name: true } },
    },
  });
  stats.scannedStage2 = dueForReminder.length;

  for (const inv of dueForReminder) {
    // The lastDunningReminderAt the claim must still match — the same value
    // we read selected the row, so a concurrent reminder loses the race.
    const priorReminderAt = inv.lastDunningReminderAt;
    const nextStage = inv.dunningReminderCount + 1;

    // #1132 follow-up — transient P2034 aborts are retried by the house
    // helper; persistent failures skip this invoice so one bad row can't
    // kill the day's run.
    const claimed = await claimInvoiceGuarded(inv, "stage", () =>
      prisma.$transaction(
        async (tx) => {
          const claim = await tx.organizationInvoice.updateMany({
            where: {
              id: inv.id,
              status: "OVERDUE",
              lastDunningReminderAt: priorReminderAt,
              dunningReminderCount: { lt: MAX_REMINDERS },
            },
            data: {
              lastDunningReminderAt: now,
              dunningReminderCount: { increment: 1 },
            },
          });
          return claim.count > 0;
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
      ),
    );
    if (!claimed) continue;
    stats.remindersSent += 1;

    void notifyOrgInvoiceOverdue(inv.organizationId, {
      invoiceNumber: inv.invoiceNumber,
      orgName: inv.organization.name,
      totalPaise: inv.totalPaise,
      currency: inv.displayCurrency,
      daysLate: daysBetween(inv.dueDate, now),
      reminderStage: nextStage,
      payUrl: `${getAppUrl()}/dashboard/organization/${inv.organizationId}/billing`,
    }).catch((err) => console.error("[dunning] stage-2 notify failed:", err));
  }

  // ── Stage 3 (#812, config-gated): suspend sponsored bookings ────────────
  // Once an invoice has had all 3 reminders and is still OVERDUE past the grace
  // window, stamp dunningSuspendedAt. checkout.ts blocks the org's NEW sponsored
  // bookings while any such invoice is unpaid (both sides gated on the same
  // ENABLE_DUNNING_SUSPEND flag). Paying the invoice (status leaves OVERDUE)
  // lifts the suspension naturally — nothing un-stamps a paid invoice.
  if (SUSPEND_ENABLED) {
    const suspendCutoff = new Date(now.getTime() - SUSPEND_GRACE_MS);
    const toSuspend = await prisma.organizationInvoice.findMany({
      where: {
        status: "OVERDUE",
        dunningReminderCount: { gte: MAX_REMINDERS },
        dunningSuspendedAt: null,
        // #812 — grace measured from the LAST reminder, not the overdue stamp:
        // the cap-3 reminders span ~21d, so gating on markedOverdueAt suspended
        // the moment the 3rd reminder cleared. lastDunningReminderAt is the
        // Stage-2 cadence anchor, so suspend only 7d past the final reminder.
        lastDunningReminderAt: { lt: suspendCutoff },
        organization: { status: { in: [...DUNNABLE_ORG_STATUSES] } },
      },
      select: {
        id: true,
        organizationId: true,
        invoiceNumber: true,
        totalPaise: true,
        displayCurrency: true,
      },
    });
    for (const inv of toSuspend) {
      // #812 — claim + audit in one Serializable tx, mirroring Stage 1, so two
      // replicas can't both stamp + log. Idempotent claim: only stamp a row
      // still un-suspended + OVERDUE; loser sees count 0 and skips.
      // #1132 follow-up — transient P2034 aborts are retried by the house
      // helper; persistent failures skip this invoice so one bad row can't
      // kill the day's run.
      const claimed = await claimInvoiceGuarded(inv, "stage-3 suspend", () =>
        prisma.$transaction(
          async (tx) => {
            const claim = await tx.organizationInvoice.updateMany({
              where: {
                id: inv.id,
                dunningSuspendedAt: null,
                status: "OVERDUE",
              },
              data: { dunningSuspendedAt: now },
            });
            if (claim.count === 0) return false;

            await tx.orgAuditLog.create({
              data: {
                organizationId: inv.organizationId,
                actorMembershipId: null,
                category: "INVOICE",
                action: AUDIT_ACTIONS.INVOICE.INVOICE_DUNNING_SUSPENDED,
                description: `Invoice ${inv.invoiceNumber} unpaid past dunning grace — org sponsored bookings suspended`,
                details: {
                  invoiceId: inv.id,
                  invoiceNumber: inv.invoiceNumber,
                  totalPaise: inv.totalPaise,
                  currency: inv.displayCurrency,
                },
              },
            });
            return true;
          },
          { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
        ),
      );

      if (!claimed) continue;
      stats.suspended += 1;
    }
  }

  return stats;
}

async function main() {
  await abortIfMaintenance("dunning");
  console.log(`[dunning] Starting at ${new Date().toISOString()}`);
  Sentry.logger.info("job:dunning started");
  const stats = await withCronLock("dunning", { failMode: "closed" }, () =>
    runDunning(),
  );
  console.log(
    `[dunning] Done. scannedStage1=${stats.scannedStage1} markedOverdue=${stats.markedOverdue} scannedStage2=${stats.scannedStage2} remindersSent=${stats.remindersSent} suspended=${stats.suspended}`,
  );
  Sentry.logger.info("job:dunning finished", {
    scannedStage1: stats.scannedStage1,
    markedOverdue: stats.markedOverdue,
    scannedStage2: stats.scannedStage2,
    remindersSent: stats.remindersSent,
    suspended: stats.suspended,
  });
}

if (require.main === module) {
  runJob("dunning", () => main().finally(() => prisma.$disconnect()));
}
