/**
 * Orphaned Recording Reconciliation — Core Logic (#1270)
 *
 * A recording reaches our database exactly one way in normal operation: Stream
 * delivers `call.recording_ready` and the webhook writes a `Recording` row.
 * When that delivery is lost — a narrowed subscription, a missing webhook
 * secret, a 5xx from our own route during a deploy — nothing notices. The
 * `MeetingSession` still carries `recordingStartedAt`, because the START of the
 * recording was written by our own code rather than by a webhook, so the
 * database says a recording was made and simply has no row for it.
 *
 * The only existing repair was `RecordingService.syncRecordingsFor*`, reachable
 * solely through `POST /api/stream/recordings/sync`, which a consultant has to
 * click. That is not a backstop, because the person who would click it is the
 * person who does not yet know anything is missing.
 *
 * The deadline is what makes this urgent rather than untidy. Stream keeps a
 * recording for fourteen days and then deletes the file. A dropped webhook is
 * therefore a silent, permanent loss of the customer's recording on a
 * fourteen-day fuse, and #1134 established that dropped webhooks here were not
 * hypothetical: for the entire period the webhook secret was unset in
 * production, every single delivery was lost.
 *
 * This sweep asks Stream directly for the recordings of any session that claims
 * to have one and has no row, and writes what it finds through the same single
 * writer the user-triggered sync uses.
 *
 * Imported by:
 * - jobs/stream/reconcile-orphaned-recordings.ts (GitHub Actions)
 * - app/api/admin/system-jobs/run/route.ts (operator surface)
 */

import prisma from "../../lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  RecordingService,
  type SyncableSession,
} from "@/lib/stream/recording-service";
import { isStreamConfigured } from "@/lib/stream-client";
import type { RecordingRow } from "@/lib/stream/recording-types";

export interface OrphanedRecordingResult {
  /** Sessions that claim a recording and have no `Recording` row. */
  scanned: number;
  /** `Recording` rows created from what Stream actually held. */
  recovered: number;
  /** Sessions Stream had nothing for — the file is gone, or never existed. */
  stillMissing: number;
  /** Sessions already past Stream's retention, reported and not retried. */
  unrecoverable: number;
  /**
   * Sessions that already had at least one `Recording` and were re-examined
   * anyway, because having SOME recordings does not mean having ALL of them.
   */
  partialScanned: number;
  /** Rows created by that second pass — segments an earlier run never saw. */
  partialRecovered: number;
  success: boolean;
  errors: string[];
}

/**
 * Stream deletes a recording fourteen days after the call. Looking further back
 * than that only produces `listRecordings` calls that can never return
 * anything, so the window is the retention period itself. Anything older is
 * counted as unrecoverable and reported rather than retried forever.
 */
const STREAM_RETENTION_DAYS = 14;

/**
 * How long to let the normal path finish before treating a session as orphaned.
 *
 * `call.recording_ready` is not immediate — Stream has to finish the egress and
 * upload the file, which takes minutes for a long session. Sweeping too early
 * would race the webhook and issue a `listRecordings` for a file that is still
 * being written, so this is generous: a recording that has not arrived two
 * hours after the call is not late, it is lost.
 */
const MIN_AGE_HOURS = 2;

/** Bounded per run so one backlog cannot hold the workflow open. */
const MAX_SESSIONS_PER_RUN = 200;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Re-ask Stream what it holds for each session, and create whatever rows are
 * missing.
 *
 * Shared by both passes. `syncSessionRecordings` is idempotent — it skips any
 * `streamRecordingId` that already has a row — so this is safe to run over a
 * session that is already complete, and the two passes differ only in which
 * sessions they select and how the result is counted.
 *
 * One failing session must not abort the rest: a Stream 500 on one call says
 * nothing about the next, and this job's whole purpose is to notice recordings
 * that are quietly missing.
 */
async function runRecoveryPass(
  sessions: unknown[],
  errorLabel: string,
  result: OrphanedRecordingResult,
): Promise<{ created: number; empty: number }> {
  let created = 0;
  let empty = 0;

  for (const session of sessions) {
    const recovered: RecordingRow[] = [];
    const id = (session as { id: string }).id;
    let outcome;
    try {
      outcome = await RecordingService.syncSessionRecordings(
        session as SyncableSession,
        recovered,
      );
    } catch (error) {
      result.success = false;
      result.errors.push(
        `${errorLabel} ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    // `syncSessionRecordings` swallows Stream and persistence failures so one
    // bad session cannot abort a batch, which means the throw above almost never
    // fires in production. Reading a swallowed failure as "no recordings found"
    // is exactly the mistake this job exists to catch — an unreachable Stream
    // would have been counted as checked-and-empty, with the run still green.
    if (!outcome.ok) {
      result.success = false;
      result.errors.push(
        `${errorLabel} ${id}: sync failed (${outcome.reason})`,
      );
      continue;
    }

    if (recovered.length > 0) created += recovered.length;
    else empty++;
  }

  return { created, empty };
}

/**
 * The appointment shape `syncSessionRecordings` needs to title a recording and
 * to mirror the parent's org tag. Identical to the consultant sync path's
 * include, and it has to be: the two produce the same rows.
 */
const orphanedSessionInclude = {
  slotOfAppointment: {
    include: {
      appointment: {
        include: {
          consultation: { include: { consultationPlan: true } },
          subscription: { include: { subscriptionPlan: true } },
          webinar: { include: { webinarPlan: true } },
          class: { include: { classPlan: true } },
        },
      },
    },
  },
} as const;

export async function reconcileOrphanedRecordings(): Promise<OrphanedRecordingResult> {
  // #476 — entry-level cron lock, in the CORE so the Actions entry and the
  // operator surface both inherit it. Fail-open: the work is idempotent
  // (`syncSessionRecordings` skips a `streamRecordingId` it already has), so a
  // double run costs duplicate Stream reads and nothing else.
  return withCronLock(
    "reconcile-orphaned-recordings",
    { failMode: "open" },
    () => reconcileOrphanedRecordingsUnlocked(),
  );
}

async function reconcileOrphanedRecordingsUnlocked(): Promise<OrphanedRecordingResult> {
  const result: OrphanedRecordingResult = {
    scanned: 0,
    recovered: 0,
    stillMissing: 0,
    unrecoverable: 0,
    partialScanned: 0,
    partialRecovered: 0,
    success: true,
    errors: [],
  };

  if (!isStreamConfigured()) {
    // Not a quiet success. This job's entire purpose is to notice that
    // recordings are not arriving, and a run that could not ask Stream has
    // noticed nothing — reporting green would reproduce the failure mode.
    result.errors.push("Stream is not configured — cannot reconcile");
    result.success = false;
    return result;
  }

  const now = Date.now();
  const notBefore = new Date(now - STREAM_RETENTION_DAYS * DAY_MS);
  const notAfter = new Date(now - MIN_AGE_HOURS * HOUR_MS);

  // The indicator is `recordingStartedAt`, not `isRecording`. `isRecording` is
  // cleared when the call stops, so it is false for exactly the sessions this
  // job cares about; `recordingStartedAt` is the durable record that a
  // recording was started, and our own code wrote it rather than a webhook.
  const orphaned = await prisma.meetingSession.findMany({
    where: {
      recordingStartedAt: { gte: notBefore, lt: notAfter },
      streamCallId: { not: "" },
      recordings: { none: {} },
    },
    orderBy: { recordingStartedAt: "asc" },
    take: MAX_SESSIONS_PER_RUN,
    include: orphanedSessionInclude,
  });

  result.scanned = orphaned.length;

  // Past the retention window there is nothing left to fetch. Counted and
  // reported so the number is visible — it is the count of recordings this
  // platform has permanently lost, which is the figure that should drive
  // whether the webhook itself gets more attention.
  result.unrecoverable = await prisma.meetingSession.count({
    where: {
      recordingStartedAt: { lt: notBefore },
      streamCallId: { not: "" },
      recordings: { none: {} },
    },
  });

  // Select the partial candidates BEFORE the orphan pass runs.
  //
  // The orphan pass creates Recording rows. A session it repairs then matches
  // `recordings: { some: {} }`, so querying afterwards would hand this run its
  // own output — consuming the partial budget, inflating `partialScanned`, and
  // displacing a session that was genuinely short all along. Snapshotting first
  // means the two passes see disjoint sets.
  const partialBudget = MAX_SESSIONS_PER_RUN - orphaned.length;
  const partial =
    partialBudget > 0
      ? await prisma.meetingSession.findMany({
          where: {
            recordingStartedAt: { gte: notBefore, lt: notAfter },
            streamCallId: { not: "" },
            recordings: { some: {} },
          },
          orderBy: { recordingStartedAt: "asc" },
          take: partialBudget,
          include: orphanedSessionInclude,
        })
      : [];

  const orphanPass = await runRecoveryPass(orphaned, "session", result);
  result.recovered += orphanPass.created;
  result.stillMissing += orphanPass.empty;

  // Second pass: sessions that already have a Recording.
  //
  // `recordings: { none: {} }` above can only see a session that received
  // NOTHING. But Stream fires `call.recording_ready` once per FILE, and splits
  // any session over two hours into separate files — so a three-file session is
  // three deliveries. Lose the second and third and the session has one row,
  // fails `none: {}`, and is never looked at again. The missing segments are
  // silently gone at day fourteen.
  //
  // That is not hypothetical here: the webhook endpoint rejected every delivery
  // for months (it required a secret Stream does not issue), and exactly one
  // Stream event has been received since the fix. Partial delivery is the
  // expected shape of recovery, not an edge case.
  //
  // Shares the orphan pass's budget, so a session with nothing is always
  // preferred over one that merely might be short. `syncSessionRecordings` is
  // idempotent — it skips any `streamRecordingId` that already has a row — so
  // re-examining a complete session costs one Stream read and writes nothing.
  result.partialScanned = partial.length;
  if (partial.length > 0) {
    // Counted separately from `recovered`: a row created here means an earlier
    // delivery was lost for a session we already believed complete, which is a
    // different and more alarming signal than one that never arrived at all.
    // `empty` is not tracked — a complete session legitimately yields nothing.
    const partialPass = await runRecoveryPass(
      partial,
      "partial session",
      result,
    );
    result.partialRecovered += partialPass.created;
  }

  console.log(
    JSON.stringify({
      event: "reconcile_orphaned_recordings",
      scanned: result.scanned,
      recovered: result.recovered,
      stillMissing: result.stillMissing,
      unrecoverable: result.unrecoverable,
      partialScanned: result.partialScanned,
      partialRecovered: result.partialRecovered,
      errorCount: result.errors.length,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
