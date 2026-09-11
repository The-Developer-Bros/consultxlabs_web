/**
 * Nightly purge of soft-deleted appointment documents.
 *
 * Soft delete (#doc-versions) tombstones the row and defers storage removal
 * so an accidental click is recoverable for a grace window. This job finishes
 * what the DELETE route deferred: remove the Supabase object first (DPDP —
 * bytes must not outlive their tombstone), then hard-delete the row. Rows
 * whose object is already gone (isStorageMissing) skip straight to deletion.
 *
 * Drains MULTIPLE batches per run (a backlog must not grow by exactly one
 * batch/night) and never lets one bad row stall the queue: rows whose storage
 * delete fails — or whose DB delete throws unexpectedly — are logged, counted,
 * and retried on a later run instead of aborting the sweep.
 */
import prisma from "@/lib/prisma";
// #1270 — the leaf module, not `@/lib/supabase`. That one carries an
// `import "server-only"` marker whose main entry throws outside Next's
// `react-server` resolution condition, so the purge-deleted-documents cron
// died during module evaluation and had never completed a run.
import { deleteAppointmentDocument } from "@/lib/supabase-storage-core";

const BATCH_SIZE = 50;
/** Hard ceiling so a pathological run cannot sweep unbounded. */
const MAX_BATCHES_PER_RUN = 20;

export async function purgeExpiredDeletedDocuments(
  graceDays: number,
): Promise<{ purged: number; failedStorage: number; failedRows: number }> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  let purged = 0;
  let failedStorage = 0;
  let failedRows = 0;
  // Rows already attempted this run — excluded from subsequent fetches so a
  // failing row cannot spin the drain loop forever.
  const attempted = new Set<string>();

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const candidates = await prisma.appointmentDocument.findMany({
      where: {
        deletedAt: { lt: cutoff },
        ...(attempted.size > 0 ? { id: { notIn: [...attempted] } } : {}),
      },
      select: { id: true, storagePath: true, isStorageMissing: true },
      orderBy: { deletedAt: "asc" },
      take: BATCH_SIZE,
    });
    if (candidates.length === 0) break;

    for (const doc of candidates) {
      attempted.add(doc.id);

      let storageCleared = doc.isStorageMissing;
      if (!storageCleared) {
        try {
          storageCleared = await deleteAppointmentDocument(doc.storagePath);
        } catch (error) {
          console.error(
            `[purge-deleted-documents] storage delete threw for ${doc.id}:`,
            error,
          );
          storageCleared = false;
        }
      }

      if (!storageCleared) {
        // Retry next night rather than orphaning the row without its bytes
        // being provably gone.
        failedStorage += 1;
        continue;
      }

      try {
        await prisma.appointmentDocument.delete({ where: { id: doc.id } });
        purged += 1;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: string }).code === "P2025"
        ) {
          // Cascade-deleted by its appointment mid-run — same outcome.
          purged += 1;
        } else {
          // One broken row must not discard the remaining candidates'
          // progress; skip and surface.
          console.error(
            `[purge-deleted-documents] DB delete failed for ${doc.id}:`,
            error,
          );
          failedRows += 1;
        }
      }
    }
  }

  return { purged, failedStorage, failedRows };
}
