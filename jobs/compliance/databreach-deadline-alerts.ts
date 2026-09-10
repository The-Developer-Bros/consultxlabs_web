/**
 * Cron: DPDP DataBreach 72-hour reporting deadline alerts.
 *
 * The DPDP Act + DPDP Rules 2025 require the Data Fiduciary to report a
 * personal-data breach to the DPB (Data Protection Board) within 72
 * hours of detection. Past that window the breach is a regulatory
 * incident on its own. This cron sweeps `DataBreach` rows that:
 *
 *   - Have `reportedAt = NULL`, AND
 *   - Are within (or past) the 72-hour reporting window.
 *
 * It then dispatches a single batched email to the DPDP-officer inbox
 * (env: `DATABREACH_ALERT_EMAIL`) listing every at-risk row, sorted by
 * `detectedAt` ascending so the most-overdue ones surface first. A
 * structured-log line `event: "dpdp.databreach.deadline"` mirrors the
 * email so Cloud Logging can route to a #security-alerts sink even
 * without the Resend dispatch.
 *
 * Schedule: hourly. The 72-hour deadline is sharp; daily would risk
 * crossing the cutoff between runs. The query is cheap (indexed on
 * `detectedAt` and `reportedAt`).
 *
 * GH Actions: `.github/workflows/databreach-deadline-alerts.yml`.
 *
 * NOTE: this is the alert pipeline only. The actual breach intake form,
 * incident response playbook, and post-72h escalation policy belong to
 * the DPDP epic (#701). When that ships, the email recipient will
 * change to a DPB-portal-aware integration.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. GitHub Actions loads env via
// repo secrets, but local + emergency manual runs would fail. See
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import { Resend } from "resend";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";

const REPORTING_DEADLINE_HOURS = 72;
const WARN_HOURS_BEFORE_DEADLINE = 12; // surface breaches when ≤12h remain
const MAX_ROWS_IN_EMAIL = 50;

// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function runDataBreachDeadlineAlerts(): Promise<{
  atRisk: number;
  overdue: number;
  emailSent: boolean;
}> {
  return withCronLock("databreach-deadline-alerts", { failMode: "open" }, () =>
    runDataBreachDeadlineAlertsUnlocked(),
  );
}

async function runDataBreachDeadlineAlertsUnlocked(): Promise<{
  atRisk: number;
  overdue: number;
  emailSent: boolean;
}> {
  Sentry.logger.info("job:databreach-deadline-alerts started");
  const now = new Date();
  // Anything detected this far back already has ≤ WARN_HOURS_BEFORE_DEADLINE
  // hours remaining. We pull everything from "deadline minus warn-window"
  // forward through "now" so a single sweep catches both upcoming and
  // overdue rows.
  const warnCutoff = new Date(
    now.getTime() -
      (REPORTING_DEADLINE_HOURS - WARN_HOURS_BEFORE_DEADLINE) * 60 * 60 * 1000,
  );

  const candidates = await prisma.dataBreach.findMany({
    where: {
      reportedAt: null,
      detectedAt: { lte: warnCutoff },
    },
    orderBy: { detectedAt: "asc" },
    take: MAX_ROWS_IN_EMAIL + 1,
    select: {
      id: true,
      detectedAt: true,
      affectedUserIds: true,
      rootCause: true,
      dpbReference: true,
    },
  });

  const overdueCutoff = new Date(
    now.getTime() - REPORTING_DEADLINE_HOURS * 60 * 60 * 1000,
  );
  const overdue = candidates.filter((c) => c.detectedAt < overdueCutoff).length;
  const atRisk = candidates.length;

  if (atRisk === 0) {
    console.log("[DataBreach] no breaches in alert window");
    return { atRisk: 0, overdue: 0, emailSent: false };
  }

  // Structured log — primary alerting channel even when email is unset.
  console.warn(
    `[DataBreach] ${atRisk} breaches near/past 72h DPB deadline (${overdue} overdue)`,
    {
      event: "dpdp.databreach.deadline",
      atRisk,
      overdue,
      reportingDeadlineHours: REPORTING_DEADLINE_HOURS,
    },
  );

  const to = process.env.DATABREACH_ALERT_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  let emailSent = false;
  if (to && apiKey) {
    try {
      const resend = new Resend(apiKey);
      const rowsToShow = candidates.slice(0, MAX_ROWS_IN_EMAIL);
      const truncated = candidates.length > MAX_ROWS_IN_EMAIL;
      const appUrl = getAppUrl();
      const tableHtml = rowsToShow
        .map((r) => {
          const ageHours = Math.round(
            (now.getTime() - r.detectedAt.getTime()) / (60 * 60 * 1000),
          );
          const isOverdue = ageHours >= REPORTING_DEADLINE_HOURS;
          const cell = (v: string) =>
            `<td${isOverdue ? ' style="color:#c00;font-weight:bold"' : ""}>${v}</td>`;
          return (
            `<tr>${cell(r.detectedAt.toISOString())}` +
            `${cell(`${ageHours}h`)}` +
            `${cell(String(r.affectedUserIds.length))}` +
            `${cell(r.rootCause.slice(0, 80))}` +
            `${cell(r.dpbReference ?? "—")}` +
            `${cell(`<a href="${appUrl}/dashboard/admin/data-breaches/${r.id}">open</a>`)}` +
            `</tr>`
          );
        })
        .join("");
      await resend.emails.send({
        from: "Familiarise DPDP <dpdp@familiarise.com>",
        to,
        subject: `[DPDP] ${atRisk} breach(es) approaching 72h deadline${overdue > 0 ? ` — ${overdue} OVERDUE` : ""}`,
        html:
          `<p>The DPDP DataBreach cron found <strong>${atRisk}</strong> ` +
          `unreported breaches approaching or past the 72-hour DPB ` +
          `reporting deadline (Section 8(6), DPDP Act). Overdue rows ` +
          `are highlighted in red.</p>` +
          `<table border="1" cellpadding="6" cellspacing="0">` +
          `<thead><tr><th>Detected</th><th>Age</th><th>Affected users</th>` +
          `<th>Root cause</th><th>DPB ref</th><th></th></tr></thead>` +
          `<tbody>${tableHtml}</tbody></table>` +
          (truncated
            ? `<p>…and ${atRisk - MAX_ROWS_IN_EMAIL} more. Open the ` +
              `admin dashboard for the full list.</p>`
            : ""),
      });
      emailSent = true;
      console.log(`[DataBreach] alert email sent to ${to}`);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { subsystem: "jobs", job: "databreach-deadline-alerts" },
      });
      console.error("[DataBreach] alert email failed:", err);
    }
  } else {
    console.log(
      "[DataBreach] DATABREACH_ALERT_EMAIL or RESEND_API_KEY not configured; email skipped",
    );
  }

  Sentry.logger.info("job:databreach-deadline-alerts finished", {
    atRisk,
    overdue,
    emailSent,
  });
  return { atRisk, overdue, emailSent };
}

// Self-execute when invoked directly via `npx tsx`.
if (require.main === module) {
  runJob("databreach-deadline-alerts", async () => {
    await abortIfMaintenance("databreach-deadline-alerts");
    try {
      const r = await runDataBreachDeadlineAlerts();
      console.log(
        `[DataBreach] cron done — atRisk=${r.atRisk} overdue=${r.overdue} emailSent=${r.emailSent}`,
      );
    } finally {
      await prisma.$disconnect();
    }
  });
}
