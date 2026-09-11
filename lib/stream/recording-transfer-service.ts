/**
 * Recording Transfer Service
 * Handles transferring recordings from Stream S3 to Supabase for permanent storage
 */

import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import type { RecordingRow } from "./recording-types";
import { streamLogger } from "@/lib/stream-logger";
import { recordSystemError } from "@/lib/enterprise/system-events";
// #1270 — the leaf module, NOT `@/lib/supabase`. That one opens with
// `import "server-only"`, which throws outside Next's `react-server` resolution
// condition, so every cron that reaches this service — mark-expired-recordings,
// cleanup-old-stream-recordings, transfer-expiring-recordings and
// sweep-stuck-webhook-events — died during module evaluation and none had ever
// completed a run. Same clients, same helpers, no marker.
import {
  ensureBucketExists,
  generateStorageFileName,
} from "@/lib/supabase-storage-core";
import {
  RECORDINGS_BUCKET,
  RECORDING_MAX_OBJECT_BYTES,
  RECORDING_MIME_TYPES,
  storageClient,
} from "./recording-storage";

// #899 — uploads stream (no in-memory buffering), so the pre-flight reject is
// not about memory. It exists to fail fast instead of burning a full upload
// into a server 413, which only works while it matches what the bucket accepts
// — hence one shared constant rather than a second copy of the number.

// STR-2/3 — page engineering once a recording has burned through this many
// transfer attempts. Below the threshold, retries are normal (transient S3 /
// Supabase blips); at/above it the recording is likely stuck and at risk of
// silently expiring, so it warrants a system_events alert.
const TRANSFER_FAILURE_ALERT_THRESHOLD = 3;


/**
 * Recording Transfer Service for moving recordings to permanent storage
 */
/**
 * Build Prisma where-clause to filter recordings by their plan's storage policy.
 * Joins through Recording → MeetingSession → SlotOfAppointment → Appointment → Event → Plan.
 */
function buildStoragePolicyFilter(
  policyFilter: "PERMANENT" | "ALL",
): object {
  if (policyFilter === "ALL") return {};

  return {
    meetingSession: {
      slotOfAppointment: {
        appointment: {
          OR: [
            {
              webinar: {
                webinarPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
            {
              class: {
                classPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
          ],
        },
      },
    },
  };
}

export class RecordingTransferService {
  /**
   * Queue a recording for transfer to Supabase.
   *
   * #899 — no broker: "queueing" is an immediate best-effort transfer,
   * fired from the recording_ready webhook so permanent recordings move
   * near-ready instead of near-expiry. Every failure path in
   * transferRecordingToSupabase reverts status to READY, and the stale-
   * TRANSFERRING sweep in processExpiringRecordings recovers kicks that die
   * mid-flight, so the 6-hourly cron always backstops this.
   * @param recordingId The recording ID to queue
   */
  static async queueRecordingTransfer(recordingId: string): Promise<boolean> {
    const { success, error } =
      await this.transferRecordingToSupabase(recordingId);
    if (!success) {
      streamLogger.warn("Ready-time transfer kick failed; cron will retry", {
        recordingId,
        error,
      });
    }
    return success;
  }

  /**
   * STR-2/3 — record a failed transfer attempt on the Recording row and, once
   * attempts cross the threshold, page engineering exactly once.
   *
   * Reverts status to READY (the existing retry contract — see
   * transferRecordingToSupabase docstring), bumps transferAttempts, stamps
   * lastTransferError. When the post-increment count >= the threshold and we
   * have not alerted before (transferFailureAlertedAt null), fires a
   * recordSystemError and stamps transferFailureAlertedAt to dedupe the page.
   */
  private static async recordTransferFailure(
    recordingId: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      const updated = await prisma.recording.update({
        where: { id: recordingId },
        data: {
          status: RecordingStatus.READY,
          transferAttempts: { increment: 1 },
          lastTransferError: errorMessage,
        },
        select: {
          organizationId: true,
          transferAttempts: true,
          transferFailureAlertedAt: true,
        },
      });

      if (
        updated.transferAttempts >= TRANSFER_FAILURE_ALERT_THRESHOLD &&
        !updated.transferFailureAlertedAt
      ) {
        await recordSystemError({
          organizationId: updated.organizationId ?? null,
          category: "RECORDING_TRANSFER",
          summary: `Recording transfer stuck after ${updated.transferAttempts} attempts`,
          err: new Error(errorMessage),
          context: { recordingId, transferAttempts: updated.transferAttempts },
          correlationId: recordingId,
        });

        // Stamp the dedupe marker only after the page is recorded, so a crash
        // mid-alert re-pages next failure rather than silently swallowing it.
        await prisma.recording.update({
          where: { id: recordingId },
          data: { transferFailureAlertedAt: new Date() },
        });
      }
    } catch (err) {
      // Best-effort: failing to record the failure must not mask the original
      // transfer error the caller is about to return.
      streamLogger.error("Failed to record transfer failure", err, {
        recordingId,
      });
    }
  }

  /**
   * Transfer a recording from Stream S3 to Supabase
   * @param recordingId The recording ID to transfer
   *
   * **Failure strategy:** All failure paths revert status to READY (not FAILED)
   * so that both the cron job and the manual /transfer API endpoint can retry.
   * A FAILED status would permanently dead-end the recording since the manual
   * transfer route only accepts READY recordings. The only exceptions are
   * "bucket missing" and "file too large" which also revert to READY since
   * the underlying issue is environmental, not permanent.
   */
  static async transferRecordingToSupabase(
    recordingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    let recording: RecordingRow | null = null;

    try {
      // Get the recording
      recording = await prisma.recording.findUnique({
        where: { id: recordingId },
      });

      if (!recording) {
        return { success: false, error: "Recording not found" };
      }

      if (!recording.recordingUrl) {
        return { success: false, error: "Recording URL not available" };
      }

      // Update status to TRANSFERRING
      await prisma.recording.update({
        where: { id: recordingId },
        data: { status: "TRANSFERRING" as RecordingStatus },
      });

      // Ensure the recordings bucket exists
      const bucketReady = await ensureBucketExists(RECORDINGS_BUCKET, {
        public: false,
        allowedMimeTypes: RECORDING_MIME_TYPES,
        fileSizeLimit: RECORDING_MAX_OBJECT_BYTES,
      });
      if (!bucketReady) {
        const error = `Recordings bucket not found. Please create a '${RECORDINGS_BUCKET}' bucket in Supabase.`;
        await this.recordTransferFailure(recordingId, error);
        return { success: false, error };
      }

      // Download the recording from Stream S3
      streamLogger.info("Downloading recording from Stream", {
        recordingId,
        url: recording.recordingUrl.substring(0, 50) + "...",
      });

      const response = await fetch(recording.recordingUrl);

      if (!response.ok) {
        // Revert to READY so cron and manual retries can re-attempt
        const error = `Failed to download recording: ${response.status} ${response.statusText}`;
        await this.recordTransferFailure(recordingId, error);
        return { success: false, error };
      }

      // Get file data
      const contentType = response.headers.get("content-type") || "video/mp4";
      const contentLength = response.headers.get("content-length");
      const fileSize = contentLength ? BigInt(contentLength) : null;
      const fileSizeNumber = contentLength ? parseInt(contentLength, 10) : null;

      // Check file size before attempting transfer to prevent OOM
      if (fileSizeNumber && fileSizeNumber > RECORDING_MAX_OBJECT_BYTES) {
        streamLogger.warn("Recording too large for direct transfer", {
          recordingId,
          fileSize: fileSizeNumber,
          maxSize: RECORDING_MAX_OBJECT_BYTES,
        });
        const error = `Recording is too large for direct transfer (${Math.round(fileSizeNumber / 1024 / 1024)}MB). Maximum is ${Math.round(RECORDING_MAX_OBJECT_BYTES / 1024 / 1024)}MB.`;
        await this.recordTransferFailure(recordingId, error);
        return { success: false, error };
      }

      // Validate content type
      if (!RECORDING_MIME_TYPES.includes(contentType)) {
        streamLogger.warn("Unexpected content type for recording", {
          recordingId,
          contentType,
        });
      }

      // Create file path: recordings/{year}/{month}/{recordingId}/{uuid}.{ext}
      const now = new Date();
      const year = now.getFullYear();
      const month = (now.getMonth() + 1).toString().padStart(2, "0");
      // Strip content-type params (e.g. "video/mp4; charset=utf-8" → "video/mp4")
      const mimeType = contentType.split(";")[0].trim();
      const filename = generateStorageFileName(mimeType);
      const storagePath = `recordings/${year}/${month}/${recordingId}/${filename}`;

      // Upload to Supabase
      streamLogger.info("Uploading recording to Supabase", {
        recordingId,
        storagePath,
      });

      // #899 — pipe the download straight into the storage upload instead of
      // materializing the file (response.blob() buffered up to 500MB in
      // memory). storage-js accepts ReadableStream and sets duplex:"half"
      // itself; blob() is only the fallback for a body-less response.
      const uploadBody = response.body ?? (await response.blob());

      const { error: uploadError } = await storageClient.storage
        .from(RECORDINGS_BUCKET)
        .upload(storagePath, uploadBody, {
          contentType,
          cacheControl: "31536000", // 1 year cache
          upsert: true,
        });

      if (uploadError) {
        // Revert to READY so cron and manual retries can re-attempt
        streamLogger.error("Failed to upload to Supabase", uploadError, {
          recordingId,
          storagePath,
        });
        await this.recordTransferFailure(recordingId, uploadError.message);
        return { success: false, error: uploadError.message };
      }

      // Store the path (NOT a public URL) — presigned URLs are generated on access.
      // Clear the failure trail so a recovered recording stops looking stuck.
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          storagePath: storagePath,
          storageType: "PLATFORM",
          status: "AVAILABLE" as RecordingStatus,
          transferredAt: new Date(),
          fileSize: fileSize,
          lastTransferError: null,
          transferFailureAlertedAt: null,
        },
      });

      streamLogger.info("Recording transferred successfully", {
        recordingId,
        storagePath,
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during transfer";
      streamLogger.error("Failed to transfer recording", error, {
        recordingId,
      });
      // Revert to READY + track the attempt so cron/manual retries can re-attempt
      // (only when the recording row was actually loaded — otherwise nothing to bump).
      if (recording) {
        await this.recordTransferFailure(recordingId, errorMessage);
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Process all recordings that are expiring soon
   * This should be run as a cron job
   * @param daysBeforeExpiry Days before expiry to start transferring
   * @param batchSize Maximum number of recordings to process in one batch
   */
  /**
   * Process expiring recordings that should be transferred to Supabase.
   * @param policyFilter - "PERMANENT" to only auto-transfer premium plans,
   *                       "ALL" to transfer everything (manual/legacy mode)
   */
  static async processExpiringRecordings(
    daysBeforeExpiry: number = 5,
    batchSize: number = 10,
    policyFilter: "PERMANENT" | "ALL" = "PERMANENT",
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    errors: string[];
  }> {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + daysBeforeExpiry);

    const results = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [] as string[],
    };

    try {
      // #899 — recover transfers killed mid-flight (serverless webhook kick,
      // crashed cron run): TRANSFERRING with no update for 2h is stuck, and
      // nothing else ever revisits it. Revert to READY so this sweep retries.
      const stale = await prisma.recording.updateMany({
        where: {
          status: "TRANSFERRING",
          storageType: "STREAM_S3",
          updatedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        data: { status: "READY" as RecordingStatus },
      });
      if (stale.count > 0) {
        streamLogger.warn("Reset stale TRANSFERRING recordings to READY", {
          count: stale.count,
        });
      }

      const expiringRecordings = await prisma.recording.findMany({
        where: {
          storageType: "STREAM_S3",
          status: "READY",
          streamUrlExpiresAt: {
            lte: expiryThreshold,
          },
          ...buildStoragePolicyFilter(policyFilter),
        },
        take: batchSize,
        orderBy: {
          streamUrlExpiresAt: "asc",
        },
      });

      streamLogger.info("Processing expiring recordings", {
        count: expiringRecordings.length,
        daysBeforeExpiry,
        policyFilter,
      });

      // #899 — network-bound transfers in chunks of 3: cuts sweep latency
      // without piling memory/connection pressure onto one invocation.
      // transferRecordingToSupabase never throws, so Promise.all is safe.
      const CONCURRENCY = 3;
      for (let i = 0; i < expiringRecordings.length; i += CONCURRENCY) {
        const chunk = expiringRecordings.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.all(
          chunk.map(async (recording) => ({
            id: recording.id,
            result: await this.transferRecordingToSupabase(recording.id),
          })),
        );

        for (const { id, result } of outcomes) {
          results.processed++;
          if (result.success) {
            results.succeeded++;
          } else {
            results.failed++;
            results.errors.push(
              `Recording ${id}: ${result.error || "Unknown error"}`,
            );
          }
        }
      }

      streamLogger.info("Finished processing expiring recordings", results);

      return results;
    } catch (error) {
      streamLogger.error("Failed to process expiring recordings", error);
      return results;
    }
  }

  /**
   * #899 — count permanent-policy recordings still on Stream S3 with less
   * than `hoursBeforeExpiry` of URL life left. Non-zero after a sweep means
   * the pipeline is falling behind or failing repeatedly; the transfer job
   * pages on it before the bytes lapse.
   */
  static async countAtRiskPermanentRecordings(
    hoursBeforeExpiry: number = 72,
  ): Promise<number> {
    const threshold = new Date(
      Date.now() + hoursBeforeExpiry * 60 * 60 * 1000,
    );
    return prisma.recording.count({
      where: {
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt: { lte: threshold, gt: new Date() },
        ...buildStoragePolicyFilter("PERMANENT"),
      },
    });
  }

  /**
   * Get STREAM_ONLY recordings that are expiring soon (for notification purposes).
   * These won't be auto-transferred but consultants should be warned.
   */
  static async getExpiringStreamOnlyRecordings(
    daysBeforeExpiry: number = 3,
  ): Promise<
    {
      recordingId: string;
      title: string;
      consultantUserId: string;
      expiresAt: Date;
    }[]
  > {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + daysBeforeExpiry);

    const recordings = await prisma.recording.findMany({
      where: {
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt: {
          lte: expiryThreshold,
          gt: new Date(), // Not yet expired
        },
        meetingSession: {
          slotOfAppointment: {
            appointment: {
              OR: [
                {
                  webinar: {
                    webinarPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
                {
                  class: {
                    classPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
              ],
            },
          },
        },
      },
      include: {
        meetingSession: {
          include: {
            slotOfAppointment: {
              include: {
                appointment: {
                  include: {
                    webinar: {
                      include: {
                        webinarPlan: {
                          include: { consultantProfile: true },
                        },
                      },
                    },
                    class: {
                      include: {
                        classPlan: {
                          include: { consultantProfile: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return recordings.map((r) => {
      const apt = r.meetingSession.slotOfAppointment.appointment;
      const consultantUserId =
        apt.webinar?.webinarPlan?.consultantProfile?.userId ||
        apt.class?.classPlan?.consultantProfile?.userId ||
        "";
      return {
        recordingId: r.id,
        title: r.title,
        consultantUserId,
        expiresAt: r.streamUrlExpiresAt!,
      };
    });
  }

  /**
   * Mark expired Stream S3 recordings
   * This should be run as a cron job to mark recordings whose URLs have expired
   */
  static async markExpiredRecordings(): Promise<number> {
    try {
      const now = new Date();

      const result = await prisma.recording.updateMany({
        where: {
          storageType: "STREAM_S3",
          status: "READY",
          streamUrlExpiresAt: {
            lt: now,
          },
        },
        data: {
          status: "EXPIRED" as RecordingStatus,
        },
      });

      if (result.count > 0) {
        streamLogger.warn("Marked recordings as expired", {
          count: result.count,
        });
      }

      return result.count;
    } catch (error) {
      streamLogger.error("Failed to mark expired recordings", error);
      return 0;
    }
  }

  /**
   * Delete a recording from Supabase storage
   * @param recordingId The recording ID to delete
   */
  static async deleteRecordingFromSupabase(
    recordingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const recording = await prisma.recording.findUnique({
        where: { id: recordingId },
      });

      if (!recording) {
        return { success: false, error: "Recording not found" };
      }

      if (!recording.storagePath) {
        return { success: false, error: "Recording not stored in Supabase" };
      }

      // Delete from Supabase
      const { error: deleteError } = await storageClient.storage
        .from(RECORDINGS_BUCKET)
        .remove([recording.storagePath]);

      if (deleteError) {
        streamLogger.error("Failed to delete from Supabase", deleteError, {
          recordingId,
          path: recording.storagePath,
        });
        return { success: false, error: deleteError.message };
      }

      // Update recording record
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          storageUrl: null,
          storagePath: null,
          storageType: "STREAM_S3",
          status:
            recording.streamUrlExpiresAt &&
            recording.streamUrlExpiresAt < new Date()
              ? "EXPIRED"
              : "READY",
        },
      });

      streamLogger.info("Recording deleted from Supabase", {
        recordingId,
        path: recording.storagePath,
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during deletion";
      streamLogger.error("Failed to delete recording from Supabase", error, {
        recordingId,
      });
      return { success: false, error: errorMessage };
    }
  }
}
