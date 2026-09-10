/**
 * Stream Recording Retention Cron — Core Logic
 *
 * Tombstones recordings whose age exceeds the owning org's
 * `Organization.streamRecordingRetentionDays` (default 90). The
 * recording row stays in the DB (audit + financial-linkage continuity)
 * but its status flips to `EXPIRED` and the Stream S3 URL is no
 * longer surfaced through the dashboard.
 *
 * We DON'T call the Stream API to delete the underlying object —
 * Stream's S3 storage has its own 2-week expiry on the free tier, and
 * the paid tier's lifecycle policies are configured per-channel, not
 * per-recording. The local tombstone is what makes the dashboard
 * stop offering the URL; the underlying S3 object is Stream's problem.
 *
 * Supabase objects ARE ours, though (#899): recordings already moved to
 * the permanent bucket get their object deleted before the tombstone,
 * otherwise the bytes outlive the retention window (DPDP gap).
 *
 * Schedule: daily at 03:00 UTC (avoids the 02:00 abandoned-top-ups
 * slot + the 02:30 reconcile-ledgers slot — Prisma connection pool
 * contention).
 */

import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { deleteRecordingObject } from "@/lib/stream/recording-storage";

export interface StreamRetentionResult {
  scanned: number;
  expired: number;
  cutoffsByOrg: Array<{ organizationId: string; retentionDays: number; expiredCount: number }>;
  success: boolean;
  errors: string[];
}

type OrgRetention = { id: string; streamRecordingRetentionDays: number };
type RecordingCandidate = { id: string; storagePath: string | null };

function recordOrgOutcome(
  result: StreamRetentionResult,
  org: OrgRetention,
  expiredCount: number,
): void {
  result.cutoffsByOrg.push({
    organizationId: org.id,
    retentionDays: org.streamRecordingRetentionDays,
    expiredCount,
  });
}

// #899 — resolve which candidates are ready to tombstone. Rows without a
// Supabase object tombstone directly. Rows with one must have their storage
// object deleted first (DPDP) — an EXPIRED row with bytes still in the bucket is
// orphaned storage and a retention violation. The network-bound deletes run in
// bounded chunks (mirroring processExpiringRecordings' transfer sweep) so a large
// candidate set can't serialise into a timeout or exhaust the pool. A failed
// delete keeps its row un-tombstoned so tomorrow's run retries the pair together.
async function collectTombstoneIds(
  org: OrgRetention,
  candidates: RecordingCandidate[],
  result: StreamRetentionResult,
): Promise<string[]> {
  const tombstoneIds: string[] = [];

  // Rows without a Supabase object need no storage call — tombstone directly.
  for (const candidate of candidates) {
    if (!candidate.storagePath) {
      tombstoneIds.push(candidate.id);
    }
  }

  const supabaseCandidates = candidates.filter((c) => c.storagePath);
  const CONCURRENCY = 5;
  for (let i = 0; i < supabaseCandidates.length; i += CONCURRENCY) {
    const chunk = supabaseCandidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (candidate) => {
        // #899 — delete only the storage object here; the row's status flip
        // + audit log land together in the transaction below so a partial
        // failure can't tombstone the row before the audit write (which the
        // `notIn [EXPIRED]` candidate filter would then never retry).
        const del = await deleteRecordingObject(
          candidate.storagePath!,
        );
        if (del.success) {
          tombstoneIds.push(candidate.id);
        } else {
          result.success = false;
          result.errors.push(
            `org=${org.id} recording=${candidate.id}: ${del.error}`,
          );
        }
      }),
    );
  }

  return tombstoneIds;
}

// Tombstone + clear the now-deleted Supabase pointers atomically with the audit
// log (the storage object was removed above). storageType reflects that only
// Stream's S3 copy — if any — remains.
async function tombstoneRecordings(
  org: OrgRetention,
  tombstoneIds: string[],
  cutoff: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.recording.updateMany({
      where: { id: { in: tombstoneIds } },
      data: {
        status: "EXPIRED",
        storageUrl: null,
        storagePath: null,
        storageType: "STREAM_S3",
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: org.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_DELETED,
        description: `Tombstoned ${tombstoneIds.length} recording(s) past ${org.streamRecordingRetentionDays}d retention`,
        details: {
          cutoff: cutoff.toISOString(),
          retentionDays: org.streamRecordingRetentionDays,
          count: tombstoneIds.length,
        },
      },
    });
  });
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function cleanupOldStreamRecordings(): Promise<StreamRetentionResult> {
  return withCronLock("cleanup-old-stream-recordings", { failMode: "open" }, () =>
    cleanupOldStreamRecordingsUnlocked(),
  );
}

async function cleanupOldStreamRecordingsUnlocked(): Promise<StreamRetentionResult> {
  const result: StreamRetentionResult = {
    scanned: 0,
    expired: 0,
    cutoffsByOrg: [],
    success: true,
    errors: [],
  };

  // Per-org pass — each org may have its own retention window. We
  // accept the N+1 cost (org count is small, recording volume is
  // moderate) because a single global query would force a CASE WHEN
  // join on `organizations.streamRecordingRetentionDays` that the
  // Prisma client can't express.
  const orgs = await prisma.organization.findMany({
    select: { id: true, streamRecordingRetentionDays: true },
    where: {
      // Only orgs that actually have recordings — skip the org table
      // entries with zero footprint.
      recordingsByOrg: { some: {} },
    },
  });

  const now = Date.now();
  for (const org of orgs) {
    const retentionMs = org.streamRecordingRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now - retentionMs);

    const candidates = await prisma.recording.findMany({
      where: {
        organizationId: org.id,
        createdAt: { lt: cutoff },
        status: { notIn: ["EXPIRED", "FAILED"] },
      },
      select: { id: true, storagePath: true },
    });
    result.scanned += candidates.length;
    if (candidates.length === 0) {
      recordOrgOutcome(result, org, 0);
      continue;
    }

    // DPDP (#899) — purge the Supabase object before tombstoning the row.
    const tombstoneIds = await collectTombstoneIds(org, candidates, result);
    if (tombstoneIds.length === 0) {
      recordOrgOutcome(result, org, 0);
      continue;
    }

    try {
      await tombstoneRecordings(org, tombstoneIds, cutoff);
      result.expired += tombstoneIds.length;
      recordOrgOutcome(result, org, tombstoneIds.length);
    } catch (err) {
      result.success = false;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`org=${org.id}: ${msg}`);
    }
  }

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
