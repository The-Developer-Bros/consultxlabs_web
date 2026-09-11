/**
 * Orphaned Meeting Session Reconciliation Job
 *
 * Finds MeetingSession records where endedAt IS NULL and the linked
 * slot's endsAt is >1 hour ago. For each, queries Stream API to check
 * actual call status and reconciles accordingly.
 *
 * Runs every 30 minutes via cleanup API route.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL + STREAM_API_KEY
// are undefined, PrismaClient throws on first query, and the Stream
// client fails to initialize. See
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import { transitionSlotCompletion } from "@/lib/booking/transitions";
import prisma from "../../lib/prisma";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "../../lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "../../lib/stream/call-cid";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import { withCronLock } from "../../lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "../../lib/observability/job-sentry";

export interface ReconciliationResult {
  processed: number;
  reconciled: number;
  streamNotFound: number;
  errors: number;
  success: boolean;
  details: string[];
}

// #476 — entry-level cron lock; fail-open (repeat-safe side effects).
export async function reconcileOrphanedSessions(): Promise<ReconciliationResult> {
  return withCronLock("reconcile-orphaned-sessions", { failMode: "open" }, () =>
    reconcileOrphanedSessionsUnlocked(),
  );
}

async function reconcileOrphanedSessionsUnlocked(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    processed: 0,
    reconciled: 0,
    streamNotFound: 0,
    errors: 0,
    success: true,
    details: [],
  };

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Find orphaned sessions: endedAt is null and slot ended >1 hour ago
  const orphanedSessions = await prisma.meetingSession.findMany({
    where: {
      endedAt: null,
      slotOfAppointment: {
        endsAt: { lt: oneHourAgo },
      },
    },
    include: {
      slotOfAppointment: true,
    },
    take: 100, // Process in batches to avoid overwhelming Stream API
  });

  if (orphanedSessions.length === 0) {
    result.details.push("No orphaned sessions found");
    return result;
  }

  console.log(
    `[reconcile-orphaned-sessions] Found ${orphanedSessions.length} orphaned sessions`,
  );

  for (const session of orphanedSessions) {
    result.processed++;

    try {
      let endedAt: Date;
      let endedReason: string;

      if (isStreamConfigured()) {
        try {
          // #1134 P1-5 — this was the one site that did NOT normalise the cid.
          // `streamCallId` stores the bare id, but three other sites defensively
          // split on ":" while this passed the raw value straight through, so a
          // prefixed value always 404'd here and the session was silently
          // recorded UNVERIFIED. One helper now owns the split.
          const client = getStreamVideoClient();
          const call = client.video.call(
            STREAM_CALL_TYPE,
            toCallId(session.streamCallId),
          );
          // #473 — a Stream outage otherwise means 100 sequential 30s timeouts
          // per run. Fast-fail into the slot-end fallback instead.
          const response = await withStreamCircuitBreaker(() => call.get());

          if (response.call.ended_at) {
            // Stream confirms the call ended
            endedAt = new Date(response.call.ended_at);
            endedReason = "reconciled";
            result.reconciled++;
          } else {
            // Call exists in Stream but no ended_at — use slot end time
            endedAt = new Date(session.slotOfAppointment.endsAt);
            endedReason = "reconciled_no_end";
            result.reconciled++;
          }
        } catch (streamError) {
          // Stream API error or call not found — use slot end time
          endedAt = new Date(session.slotOfAppointment.endsAt);
          endedReason = "stream_not_found";
          result.streamNotFound++;

          console.warn(
            `[reconcile-orphaned-sessions] Stream lookup failed for ${session.streamCallId}:`,
            streamError instanceof Error
              ? streamError.message
              : JSON.stringify(streamError),
          );
        }
      } else {
        // Stream not configured — use slot end time
        endedAt = new Date(session.slotOfAppointment.endsAt);
        endedReason = "stream_not_configured";
        result.streamNotFound++;
      }

      const completionStatus =
        endedReason === "reconciled" ? "COMPLETED" : "UNVERIFIED";

      const moved = await prisma.$transaction(async (tx) => {
        await tx.meetingSession.update({
          where: { id: session.id },
          data: { endedAt, endedReason },
        });
        // CAS (#1319): never overwrite a CANCELLED slot; zero rows is a
        // legitimate outcome for a reconciler and is reported below.
        return transitionSlotCompletion(tx, {
          where: { id: session.slotOfAppointmentId },
          to: completionStatus,
          data: { completedAt: endedAt },
          allowZero: true,
        });
      });

      result.details.push(
        `Session ${session.id} (call: ${session.streamCallId}): ${endedReason}${moved === 0 ? " (slot not completable, left as is)" : ""}`,
      );
    } catch (error) {
      result.errors++;
      result.success = false;
      const msg = error instanceof Error ? error.message : String(error);
      result.details.push(`Session ${session.id} FAILED: ${msg}`);
      console.error(
        `[reconcile-orphaned-sessions] Failed to reconcile session ${session.id}:`,
        msg,
      );
    }
  }

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Allow direct execution
if (require.main === module) {
  runJob("reconcile-orphaned-sessions", async () => {
    await abortIfMaintenance("reconcile-orphaned-sessions");
    Sentry.logger.info("job:reconcile-orphaned-sessions started");
    console.log("Starting orphaned session reconciliation...");

    try {
      const result = await reconcileOrphanedSessions();
      console.log("\nReconciliation Results:");
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Reconciled: ${result.reconciled}`);
      console.log(`  Stream Not Found: ${result.streamNotFound}`);
      console.log(`  Errors: ${result.errors}`);
      console.log(`  Success: ${result.success}`);

      Sentry.logger.info("job:reconcile-orphaned-sessions finished", {
        processed: result.processed,
        reconciled: result.reconciled,
        streamNotFound: result.streamNotFound,
        errors: result.errors,
      });
      if (!result.success) process.exitCode = 1;
    } finally {
      await disconnectDatabase();
    }
  });
}
