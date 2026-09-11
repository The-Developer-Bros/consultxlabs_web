/**
 * Staff System Jobs API
 * List available system jobs
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
// Job configuration matching SystemJobsPanel
const SYSTEM_JOBS = [
  {
    id: "cleanup-abandoned-payments",
    name: "Cleanup Abandoned Payments",
    description: "Cancel abandoned payment intents and expire pending payments",
    schedule: "Every 15 minutes",
    category: "Payments",
  },
  {
    id: "cleanup-approval-payments",
    name: "Cleanup Approval Payments",
    description: "Expire 48h+ pending approval payments",
    schedule: "Hourly",
    category: "Payments",
  },
  {
    id: "reconcile-refunds",
    name: "Reconcile Pending Refunds",
    description: "Sync refund status with payment gateways",
    schedule: "Every 15 minutes",
    category: "Refunds",
  },
  {
    id: "reconcile-disputes",
    name: "Reconcile Disputes",
    description: "Sync dispute status with Stripe",
    schedule: "Every 6 hours",
    category: "Disputes",
  },
  {
    id: "handle-lost-disputes",
    name: "Handle Lost Disputes",
    description: "Reverse earnings on lost disputes",
    schedule: "Every 6 hours",
    category: "Disputes",
  },
  {
    id: "release-earnings",
    name: "Release Earnings from Hold",
    description: "Move PENDING earnings to READY after hold period",
    schedule: "Hourly",
    category: "Earnings",
  },
  {
    id: "create-payout-batch",
    name: "Create Payout Batch",
    description: "Create weekly payout batches",
    schedule: "Weekly (Mon 8PM UTC)",
    category: "Payouts",
  },
  {
    id: "process-payouts",
    name: "Process Payouts",
    description: "Send approved payouts",
    schedule: "Weekly (Mon 9PM UTC)",
    category: "Payouts",
  },
  {
    id: "auth-tokens",
    name: "Auth Token Cleanup",
    description: "Delete expired sessions and tokens",
    schedule: "Daily",
    category: "Cleanup",
  },
  // Stream (#1270). The whole Stream fleet was absent from this catalogue, so
  // the staff Jobs page could not show when any of it last ran — which is how
  // four of these jobs crashed at import on every scheduled run without anyone
  // seeing a gap. The ids match the `withCronLock` job names, which are what
  // `SystemJobExecution.jobId` carries, so the last-run stats below resolve.
  //
  // Built from tuples rather than seven object literals: the shape is identical
  // across the fleet, and repeating it is what pushed this file's duplication
  // past the quality gate.
  ...(
    [
      [
        "stream-sync",
        "Stream User Sync",
        "Soft-delete Stream users that no longer exist in the database",
        "Daily (03:40 UTC)",
      ],
      [
        "mark-expired-recordings",
        "Mark Expired Recordings",
        "Tombstone recordings whose Stream S3 URL has lapsed",
        "Daily (03:20 UTC)",
      ],
      [
        "transfer-expiring-recordings",
        "Transfer Expiring Recordings",
        "Copy permanent-policy recordings to Supabase before Stream deletes them",
        "Every 6 hours",
      ],
      [
        "cleanup-old-stream-recordings",
        "Stream Recording Retention Sweep",
        "Delete Supabase objects and tombstone recordings past each org's retention window",
        "Daily (03:00 UTC)",
      ],
      [
        "reconcile-orphaned-recordings",
        "Reconcile Orphaned Recordings",
        "Recover recordings whose call.recording_ready webhook was never delivered",
        "Daily (05:00 UTC)",
      ],
      [
        "expire-event-channels",
        "Expire Event Chat Channels",
        "Freeze webinar and class chat after 7 days, delete at retention",
        "Daily (04:35 UTC)",
      ],
      [
        "reconcile-orphaned-sessions",
        "Reconcile Orphaned Meeting Sessions",
        "Close meeting sessions whose call.session_ended webhook never landed",
        "Every 30 minutes",
      ],
    ] as const
  ).map(([id, name, description, schedule]) => ({
    id,
    name,
    description,
    schedule,
    category: "Stream",
  })),
  {
    // #1270 — scheduled at `8-59/30 * * * *` by
    // .github/workflows/retry-moderation-enforcement.yml. Enforcement already
    // reported as done should not wait an hour to become true.
    id: "retry-moderation-enforcement",
    name: "Retry Moderation Enforcement",
    description:
      "Re-drive the Stream ban, deactivation or message delete of moderation actions whose recorded outcome says it failed",
    schedule: "Every 30 minutes",
    category: "Moderation",
  },
];

/**
 * GET /api/staff/system-jobs
 * List all available system jobs
 */
export async function GET() {
  try {
    const auth = await requireBackofficeSurface("systemJobs.manage");
    if (auth.error) return auth.error;

    // Get recent execution stats for each job
    const recentExecutions = await prisma.systemJobExecution.groupBy({
      by: ["jobId"],
      _count: { id: true },
      _max: { startedAt: true },
      where: {
        startedAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
        },
      },
    });

    const executionMap = new Map(
      recentExecutions.map((e) => [
        e.jobId,
        { count: e._count.id, lastRun: e._max.startedAt },
      ]),
    );

    const jobsWithStats = SYSTEM_JOBS.map((job) => ({
      ...job,
      recentExecutions: executionMap.get(job.id)?.count || 0,
      lastRun: executionMap.get(job.id)?.lastRun || null,
    }));

    return NextResponse.json({ jobs: jobsWithStats });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching system jobs:", error);
    return NextResponse.json(
      { error: "Failed to fetch system jobs" },
      { status: 500 },
    );
  }
}
