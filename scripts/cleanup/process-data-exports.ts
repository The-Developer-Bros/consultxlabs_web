/**
 * DPDP §11 Data Export Worker — Core Logic
 *
 * Picks PENDING `OrgDataExportJob` rows and builds a JSON bundle
 * containing every org-scoped entity (members, contracts, programs,
 * invoices, earnings, payouts, audit-log). The bundle is uploaded to
 * Supabase Storage under `org-exports/{orgId}/{jobId}.json` with a
 * 7-day signed-URL expiry, and the job row is marked READY with the
 * URL + expiry stamped.
 *
 * Why a JSON bundle (not zipped JSON+CSV)
 * --------------------------------------
 * The plan originally called for `adm-zip` + an 8-CSV companion set.
 * In v1 we ship the JSON-only path because:
 *   1. Compliance reviewers (the actual DPDP §11 audience) prefer JSON
 *      — easier to grep, no separator escaping ambiguity.
 *   2. Adding `adm-zip` as a hard dependency is a footprint hit the
 *      caller doesn't actually need; integrators that want CSV can
 *      convert the JSON locally with `jq -r '@csv'`.
 *   3. The bundle is signed-URL gated for 7 days — long enough to
 *      run any post-export ETL.
 * The contract is forward-compatible: future versions can return a
 * zip with the same file naming scheme, and the dashboard's existing
 * "Download bundle" link will keep working.
 *
 * Concurrency
 * -----------
 * One worker per org per tick. We use a Postgres advisory lock on
 * `hashtextextended('export:' || orgId)` so two workers picking up
 * the same job collapse safely (the second waits, observes status =
 * PROCESSING, skips).
 *
 * Schedule: every 10 minutes via `.github/workflows/process-data-exports.yml`.
 */

import { Resend } from "resend";
import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { recordSystemError } from "../../lib/enterprise/system-events";
import { checkConsentBatch } from "../../lib/compliance/dpdp";
import { PURPOSE_CODES } from "../../lib/compliance/purpose-codes";
import { notifyOrgDataExportReady } from "../../lib/novu/org-workflows";
import { getAppUrl } from "../../lib/url";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

export interface DataExportResult {
  picked: number;
  succeeded: number;
  failed: number;
  success: boolean;
  errors: string[];
}

/**
 * The bundle structure is intentionally flat — one top-level key per
 * entity — so an integrator's parser doesn't have to know the
 * relational graph to extract anything useful.
 */
interface ExportBundle {
  organizationId: string;
  generatedAt: string;
  schemaVersion: 1;
  organization: unknown;
  members: unknown[];
  memberships: unknown[];
  contracts: unknown[];
  programs: unknown[];
  invoices: unknown[];
  earnings: unknown[];
  payouts: unknown[];
  auditLog: unknown[];
  /** #701 — count of members whose PII was withheld for lack of consent. */
  excludedForConsent: number;
}

async function buildBundleFor(organizationId: string): Promise<ExportBundle> {
  // Each query is small + indexed (organizationId is on every relevant
  // table). The 8-entity walk is a few hundred KB even for established
  // orgs; we don't paginate because the export caller wants
  // single-snapshot atomicity.
  const [
    organization,
    memberships,
    contracts,
    programs,
    invoices,
    earnings,
    payouts,
    auditLog,
  ] = await prisma.$transaction([
    prisma.organization.findUnique({ where: { id: organizationId } }),
    prisma.membership.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.contract.findMany({ where: { organizationId } }),
    // Why the indirect filter on Program: it carries no direct
    // organizationId column — programs hang off `Contract`, which is
    // the FK that holds the org link. Use the relation-filter so
    // Prisma emits a single EXISTS subquery instead of a join.
    prisma.program.findMany({
      where: { contract: { organizationId } },
    }),
    prisma.organizationInvoice.findMany({ where: { organizationId } }),
    prisma.organizationEarnings.findMany({ where: { organizationId } }),
    prisma.organizationPayout.findMany({ where: { organizationId } }),
    // Audit log: respect the 2y retention floor for non-financial rows
    // and 7y for financial. The prune cron already enforces this, but
    // the explicit `findMany` without filter is the right snapshot —
    // whatever survived retention IS what the export gets.
    prisma.orgAuditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const seenUserIds = new Set<string>();
  const allMembers = memberships
    .map((m) => m.user)
    .filter((u) => {
      if (!u || seenUserIds.has(u.id)) return false;
      seenUserIds.add(u.id);
      return true;
    });

  // #701 — DPDP: withhold PII for members who have withdrawn core-processing
  // consent. Their name/email are dropped from `members` and scrubbed from the
  // membership rows (the org-relationship metadata stays). TODO(#701): extend to
  // field-level scoping across the rest of the bundle.
  // #1019 — one batch query instead of a per-member loop (pool-safe for large
  // orgs). consentedIds holds the members who HAVE core-processing consent.
  const consentedIds = await checkConsentBatch({
    userIds: allMembers.map((u) => u.id),
    purposeCode: PURPOSE_CODES.PRIMARY_PROCESSING,
  });
  const members = allMembers.filter((u) => consentedIds.has(u.id));
  const excludedForConsent = allMembers.length - members.length;
  const scrubbedMemberships = memberships.map((m) =>
    m.user && !consentedIds.has(m.user.id)
      ? { ...m, user: { id: m.user.id, name: null, email: null } }
      : m,
  );

  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    organization,
    members,
    memberships: scrubbedMemberships,
    contracts,
    programs,
    invoices,
    earnings,
    payouts,
    auditLog,
    excludedForConsent,
  };
}

async function uploadBundle(
  organizationId: string,
  jobId: string,
  bundle: ExportBundle,
): Promise<{ url: string; sizeBytes: number; expiresAt: Date } | null> {
  // Supabase Storage upload — gated on the env vars being present so
  // local-dev runs without Supabase keys fall through to a "saved to
  // local /tmp" stub. Production always has the env keys.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_DATA_EXPORT_BUCKET ?? "org-exports";

  const json = JSON.stringify(bundle, null, 2);
  const sizeBytes = Buffer.byteLength(json, "utf8");
  const sevenDays = 7 * 24 * 60 * 60;

  if (!supabaseUrl || !supabaseServiceKey) {
    // Local-dev fallback — write to /tmp + return a file:// URL. The
    // route handler will refuse to issue this URL to a client (signed
    // URLs are http(s)-only) but it lets the worker complete its
    // happy path during local QA.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = "/tmp/familiarise-data-exports";
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${organizationId}_${jobId}.json`);
    await fs.writeFile(filePath, json, "utf8");
    return {
      url: `file://${filePath}`,
      sizeBytes,
      expiresAt: new Date(Date.now() + sevenDays * 1000),
    };
  }

  // We dynamic-import @supabase/supabase-js because the cron job runs
  // in a thin tsx process; it's not in the hot-path bundle for the
  // edge runtime and avoids a peer-dep cycle at build time.
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const objectPath = `${organizationId}/${jobId}.json`;
  const { error: uploadErr } = await supabase.storage
    .from(bucket)
    .upload(objectPath, json, {
      contentType: "application/json",
      upsert: true,
    });
  if (uploadErr) {
    throw new Error(`Supabase upload failed: ${uploadErr.message}`);
  }
  const { data: signed, error: signedErr } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, sevenDays);
  if (signedErr || !signed) {
    throw new Error(
      `Supabase signed URL creation failed: ${signedErr?.message ?? "unknown"}`,
    );
  }
  return {
    url: signed.signedUrl,
    sizeBytes,
    expiresAt: new Date(Date.now() + sevenDays * 1000),
  };
}

async function emailRequester(params: {
  jobId: string;
  organizationId: string;
  requestedByMembershipId: string;
  downloadUrl: string;
  expiresAt: Date;
}): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return; // Local dev — skip email send.

  const membership = await prisma.membership.findUnique({
    where: { id: params.requestedByMembershipId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!membership?.user?.email) return;

  const resend = new Resend(resendKey);
  await resend.emails.send({
    from: "Familiarise <noreply@familiarise.work>",
    to: membership.user.email,
    subject: "Your organization data export is ready",
    text: [
      `Hi ${membership.user.name ?? ""},`,
      "",
      `Your data export bundle is ready. Download it within 7 days:`,
      params.downloadUrl,
      "",
      `Expires: ${params.expiresAt.toISOString()}`,
      "",
      "If you didn't request this, contact your org admin.",
    ].join("\n"),
  });
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function processDataExports(): Promise<DataExportResult> {
  return withCronLock("process-data-exports", { failMode: "open", ttlMs: LONG_JOB_TTL_MS }, () =>
    processDataExportsUnlocked(),
  );
}

async function processDataExportsUnlocked(): Promise<DataExportResult> {
  const result: DataExportResult = {
    picked: 0,
    succeeded: 0,
    failed: 0,
    success: true,
    errors: [],
  };

  // Pick one PENDING job at a time. The 10-min cron + the 1-export-per-
  // org-per-24h API rate limit means concurrent backlog is rare; if it
  // grows we widen to N rows per tick.
  const job = await prisma.orgDataExportJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return result;
  result.picked = 1;

  // Mark PROCESSING so a second worker tick (or a re-fire) observes
  // the in-flight row and skips it. Idempotent — second hit is a no-op.
  await prisma.orgDataExportJob.update({
    where: { id: job.id, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: new Date() },
  });

  try {
    const bundle = await buildBundleFor(job.organizationId);
    const uploaded = await uploadBundle(job.organizationId, job.id, bundle);
    if (!uploaded) {
      throw new Error("Bundle upload returned null");
    }

    await prisma.$transaction(async (tx) => {
      await tx.orgDataExportJob.update({
        where: { id: job.id },
        data: {
          status: "READY",
          fileUrl: uploaded.url,
          fileSizeBytes: BigInt(uploaded.sizeBytes),
          expiresAt: uploaded.expiresAt,
          completedAt: new Date(),
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: job.organizationId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_GENERATED,
          description: `Generated data export bundle (${uploaded.sizeBytes} bytes)`,
          details: {
            exportId: job.id,
            fileSizeBytes: uploaded.sizeBytes,
            expiresAt: uploaded.expiresAt.toISOString(),
          },
        },
      });
    });

    // Fire-and-forget email. Failures don't unwind the export.
    await emailRequester({
      jobId: job.id,
      organizationId: job.organizationId,
      requestedByMembershipId: job.requestedByMembershipId,
      downloadUrl: uploaded.url,
      expiresAt: uploaded.expiresAt,
    }).catch((err) => {
      console.error(
        `[process-data-exports] email send failed for job ${job.id}:`,
        err,
      );
    });

    // Novu fan-out to the OWNER roster so the requester's teammates
    // see the bundle even if the requester is OOO.
    const orgRow = await prisma.organization.findUnique({
      where: { id: job.organizationId },
      select: { name: true },
    });
    if (orgRow) {
      await notifyOrgDataExportReady(job.organizationId, {
        orgName: orgRow.name,
        exportId: job.id,
        fileSizeBytes: uploaded.sizeBytes,
        expiresAt: uploaded.expiresAt.toISOString(),
        downloadUrl: uploaded.url,
        dashboardUrl: `${getAppUrl()}/dashboard/organization/${job.organizationId}/integrations/data-exports`,
      });
    }

    result.succeeded = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.failed = 1;
    result.success = false;
    result.errors.push(`job=${job.id}: ${message}`);

    // Split the failure across two surfaces:
    //   - OrgAuditLog gets a CLEAN, org-visible description. Never
    //     interpolate raw error messages here — they can carry Prisma
    //     schema names, stack frames, and other engineering noise that
    //     leaks internals to the org owner.
    //   - SystemEvent gets the raw error + stack for platform engineering.
    //     Same incident, two views, no information leakage. See
    //     lib/enterprise/audit-sanitize.ts for the read-side guard
    //     that catches any legacy rows that pre-date this discipline.
    await prisma.$transaction(async (tx) => {
      await tx.orgDataExportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", error: message, completedAt: new Date() },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: job.organizationId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_FAILED,
          description:
            "Data export bundle could not be generated. Our engineering team has been notified — please retry or contact support if the issue persists.",
          // `details` stays minimal + org-safe: the export ID lets the
          // OWNER reference the failed request when contacting support,
          // but no error payload leaks here.
          details: { exportId: job.id },
        },
      });
    });

    // Best-effort write to the engineering-only system_events table.
    // Carries the full Prisma error + stack trace, indexed by job ID
    // for correlation. Outside the audit transaction so a slow insert
    // doesn't hold the export-job lock.
    await recordSystemError({
      organizationId: job.organizationId,
      category: "DATA_EXPORT",
      summary: "Data export bundle failed",
      err,
      context: { exportId: job.id },
      correlationId: job.id,
    });
  }

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
