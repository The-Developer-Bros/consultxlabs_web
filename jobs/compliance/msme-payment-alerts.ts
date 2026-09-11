/**
 * Cron: MSME Section 43B(h) payment-deadline alerts.
 *
 * STATUS: live (body + derivation). `lib/compliance/msme.ts`
 * (`computeMsmePaymentDeadline`) implements the real 15/45-day MICRO/
 * SMALL rule and falls back to `contract.defaultTermsDays` for MEDIUM/
 * NONE. The pipeline below:
 *
 *   1. Query OrganizationPayout rows within 5 days of `mustPayByDate`
 *      that haven't yet COMPLETED.
 *   2. If any exist, email the finance inbox (env: `MSME_ALERT_EMAIL`)
 *      with a deadline-sorted list + direct links into the finance
 *      dashboard.
 *   3. Emit a structured log line that Cloud Logging can route to the
 *      #finance-alerts channel via its built-in sink.
 *
 * Schedule: daily at 04:30 UTC (10:00 IST).
 * GH Actions: `.github/workflows/msme-payment-alerts.yml`.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. See
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import { Resend } from "resend";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";

const ALERT_WINDOW_DAYS = 5;
const MAX_ROWS_IN_EMAIL = 20;

// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function runMsmePaymentAlerts(): Promise<{
  alerted: number;
  atRisk: number;
  emailSent: boolean;
}> {
  return withCronLock("msme-payment-alerts", { failMode: "open" }, () =>
    runMsmePaymentAlertsUnlocked(),
  );
}

async function runMsmePaymentAlertsUnlocked(): Promise<{
  alerted: number;
  atRisk: number;
  emailSent: boolean;
}> {
  Sentry.logger.info("job:msme-payment-alerts started");
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + ALERT_WINDOW_DAYS);

  // Both payout paths carry a 43B(h) deadline: OrganizationPayout (HOST/ORG
  // recipient) and ConsultantPayout (SELF recipient, #776). Sweep both and
  // merge so the SELF path can't silently miss the statutory window.
  const [orgRows, selfRows] = await Promise.all([
    prisma.organizationPayout.findMany({
      where: {
        mustPayByDate: { lte: windowEnd, not: null },
        status: { notIn: ["COMPLETED"] },
      },
      orderBy: { mustPayByDate: "asc" },
      take: MAX_ROWS_IN_EMAIL + 1,
      select: {
        id: true,
        mustPayByDate: true,
        amountPaise: true,
        status: true,
        organizationId: true,
      },
    }),
    prisma.consultantPayout.findMany({
      where: {
        mustPayByDate: { lte: windowEnd, not: null },
        status: { notIn: ["COMPLETED"] },
      },
      orderBy: { mustPayByDate: "asc" },
      take: MAX_ROWS_IN_EMAIL + 1,
      select: {
        id: true,
        mustPayByDate: true,
        amount: true, // ConsultantPayout stores paise in `amount`
        status: true,
        consultantProfileId: true,
      },
    }),
  ]);

  // Normalize to one shape (org id vs consultant id → `ownerId`) so the
  // email/log treat both uniformly.
  const atRiskRows = [
    ...orgRows.map((r) => ({
      id: r.id,
      mustPayByDate: r.mustPayByDate,
      amountPaise: r.amountPaise,
      status: r.status as string,
      ownerId: r.organizationId ?? "(none)",
    })),
    ...selfRows.map((r) => ({
      id: r.id,
      mustPayByDate: r.mustPayByDate,
      amountPaise: r.amount,
      status: r.status as string,
      ownerId: r.consultantProfileId,
    })),
  ].sort(
    (a, b) =>
      (a.mustPayByDate?.getTime() ?? 0) - (b.mustPayByDate?.getTime() ?? 0),
  );

  const atRisk = atRiskRows.length;
  if (atRisk === 0) {
    console.log("[MSME] no payouts in alert window");
    return { alerted: 0, atRisk: 0, emailSent: false };
  }

  // Structured log for Cloud Logging → #finance-alerts sink.
  console.warn(
    `[MSME] ${atRisk} payouts within ${ALERT_WINDOW_DAYS}d of Section 43B(h) deadline`,
    {
      event: "msme.payout.at_risk",
      count: atRisk,
      windowDays: ALERT_WINDOW_DAYS,
      windowEnd: windowEnd.toISOString(),
    },
  );

  // Email dispatch — opt-in per environment so we don't spam finance
  // during staging/preview deploys. The log above is always emitted.
  const to = process.env.MSME_ALERT_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  let emailSent = false;
  if (to && apiKey) {
    try {
      const resend = new Resend(apiKey);
      const rowsToShow = atRiskRows.slice(0, MAX_ROWS_IN_EMAIL);
      const truncated = atRiskRows.length > MAX_ROWS_IN_EMAIL;
      const appUrl = getAppUrl();
      const tableHtml = rowsToShow
        .map(
          (r) =>
            `<tr><td>${new Date(r.mustPayByDate ?? 0).toISOString().slice(0, 10)}</td>` +
            `<td>${r.id}</td>` +
            `<td>${r.ownerId}</td>` +
            `<td>₹${((r.amountPaise ?? 0) / 100).toLocaleString("en-IN")}</td>` +
            `<td>${r.status}</td>` +
            `<td><a href="${appUrl}/admin/payouts/${r.id}">open</a></td></tr>`,
        )
        .join("");
      await resend.emails.send({
        from: "Familiarise Finance <finance@familiarise.com>",
        to,
        subject: `[MSME 43B(h)] ${atRisk} payouts approaching deadline`,
        html:
          `<p>The MSME alert cron found <strong>${atRisk}</strong> payouts ` +
          `within ${ALERT_WINDOW_DAYS} days of their Section 43B(h) deadline ` +
          `and still not in COMPLETED status.</p>` +
          `<table border="1" cellpadding="6" cellspacing="0">` +
          `<thead><tr><th>Deadline</th><th>Payout id</th><th>Owner id</th><th>Amount</th><th>Status</th><th></th></tr></thead>` +
          `<tbody>${tableHtml}</tbody></table>` +
          (truncated
            ? `<p>…and ${atRisk - MAX_ROWS_IN_EMAIL} more. Open the finance dashboard for the full list.</p>`
            : ""),
      });
      emailSent = true;
      console.log(`[MSME] alert email sent to ${to}`);
    } catch (err) {
      console.error("[MSME] alert email failed:", err);
      Sentry.captureException(err, {
        tags: { subsystem: "jobs", job: "msme-payment-alerts" },
      });
    }
  } else {
    console.log(
      "[MSME] MSME_ALERT_EMAIL or RESEND_API_KEY not configured; email skipped",
    );
  }

  const result = { alerted: emailSent ? atRisk : 0, atRisk, emailSent };
  Sentry.logger.info("job:msme-payment-alerts finished", {
    alerted: result.alerted,
    atRisk: result.atRisk,
    emailSent: result.emailSent,
  });
  return result;
}

// Self-execute when invoked directly via `npx tsx`. Allows imports for
// unit tests without triggering the cron body.
if (require.main === module) {
  runJob("msme-payment-alerts", async () => {
    await abortIfMaintenance("msme-payment-alerts");
    try {
      const r = await runMsmePaymentAlerts();
      console.log(
        `[MSME] cron done — alerted=${r.alerted} atRisk=${r.atRisk} emailSent=${r.emailSent}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
}
