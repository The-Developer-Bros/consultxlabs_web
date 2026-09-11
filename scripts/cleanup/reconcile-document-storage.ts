/**
 * Document Storage Reconciliation - Core Logic
 *
 * Reconciles document records in database with files in Supabase storage.
 * - Finds orphaned files (in storage but not in DB)
 * - Finds missing files (in DB but not in storage)
 * - Deletes orphaned files after grace period
 *
 * This catches cases where:
 * - File uploaded but DB record creation failed
 * - DB record created but file upload failed
 * - File manually deleted from storage
 * - System errors during upload/delete operations
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-document-storage.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-document-storage/route.ts (API endpoint)
 *
 * Schedule: Daily
 */

import prisma from "../../lib/prisma";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

// Grace period before deleting orphaned files (days)
const ORPHAN_GRACE_PERIOD_DAYS = 7;

// Buckets to check
const BUCKETS_TO_CHECK = ["documents", "support-attachments"];

export interface DocumentReconciliationResult {
  success: boolean;
  orphanedFilesFound: number;
  orphanedFilesDeleted: number;
  missingFilesFound: number;
  missingFilesMarked: number;
  errors: string[];
  timestamp: string;
}

interface OrphanedFile {
  bucket: string;
  path: string;
  name: string;
  createdAt?: Date;
}

/**
 * Get Supabase admin client for storage operations
 */
function getSupabaseAdmin(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn("Supabase credentials not configured for admin operations");
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

/**
 * Recursively list all files in a bucket path
 */
async function listAllFilesInBucket(
  supabase: SupabaseClient,
  bucket: string,
  path = "",
): Promise<{ path: string; name: string; createdAt?: Date }[]> {
  const allFiles: { path: string; name: string; createdAt?: Date }[] = [];

  try {
    const { data: items, error } = await supabase.storage
      .from(bucket)
      .list(path, { limit: 1000 });

    if (error) {
      console.error(`Error listing files in ${bucket}/${path}:`, error);
      return allFiles;
    }

    if (!items) return allFiles;

    for (const item of items) {
      const itemPath = path ? `${path}/${item.name}` : item.name;

      // If it's a folder (no metadata), recurse into it
      if (!item.metadata) {
        const subFiles = await listAllFilesInBucket(supabase, bucket, itemPath);
        allFiles.push(...subFiles);
      } else {
        // It's a file
        allFiles.push({
          path: itemPath,
          name: item.name,
          createdAt: item.created_at ? new Date(item.created_at) : undefined,
        });
      }
    }
  } catch (error) {
    console.error(`Error listing bucket ${bucket}:`, error);
  }

  return allFiles;
}

/**
 * Find orphaned files in documents bucket
 */
async function findOrphanedDocuments(
  supabase: SupabaseClient,
): Promise<OrphanedFile[]> {
  const orphanedFiles: OrphanedFile[] = [];

  console.log("\n🔍 Checking documents bucket...");

  // List all files in storage
  const storageFiles = await listAllFilesInBucket(supabase, "documents");
  console.log(`   Found ${storageFiles.length} files in storage`);

  if (storageFiles.length === 0) return orphanedFiles;

  // Get all document records from DB
  const dbDocuments = await prisma.appointmentDocument.findMany({
    select: { storagePath: true },
  });
  const dbPaths = new Set(dbDocuments.map((d) => d.storagePath));
  console.log(`   Found ${dbPaths.size} document records in DB`);

  // Find files not in DB
  for (const file of storageFiles) {
    if (!dbPaths.has(file.path)) {
      orphanedFiles.push({
        bucket: "documents",
        path: file.path,
        name: file.name,
        createdAt: file.createdAt,
      });
    }
  }

  console.log(`   Found ${orphanedFiles.length} orphaned files`);
  return orphanedFiles;
}

interface MissingFile {
  id: string;
  storagePath: string;
  isStorageMissing: boolean; // #694 — prior flag state, to skip redundant updates
}

/**
 * Find missing files (in DB but not in storage), plus rows previously flagged
 * as missing whose file is present again (recovered) so the flag can be cleared.
 */
async function findMissingFiles(
  supabase: SupabaseClient,
): Promise<{ missingFiles: MissingFile[]; recoveredIds: string[] }> {
  const missingFiles: MissingFile[] = [];
  const recoveredIds: string[] = [];

  console.log("\n🔍 Checking for missing files...");

  // Get all document records with storage paths
  const dbDocuments = await prisma.appointmentDocument.findMany({
    select: { id: true, storagePath: true, isStorageMissing: true },
  });

  console.log(`   Checking ${dbDocuments.length} document records...`);

  // Check each file exists in storage
  for (const doc of dbDocuments) {
    let present = false;
    try {
      const { data, error } = await supabase.storage
        .from("documents")
        .download(doc.storagePath);
      present = !error && !!data;
    } catch {
      present = false;
    }

    if (present) {
      // #694 — file is back; clear a stale missing flag if one was set.
      if (doc.isStorageMissing) recoveredIds.push(doc.id);
    } else {
      missingFiles.push({
        id: doc.id,
        storagePath: doc.storagePath,
        isStorageMissing: doc.isStorageMissing,
      });
    }
  }

  console.log(`   Found ${missingFiles.length} missing files`);
  return { missingFiles, recoveredIds };
}

/**
 * #694 — persist the missing-storage state: flag newly-missing rows and clear
 * the flag on recovered rows. Returns the count of rows freshly marked missing.
 */
async function persistMissingState(
  missingFiles: MissingFile[],
  recoveredIds: string[],
): Promise<number> {
  // Only flag (and count) rows whose flag flips false → true. Batch the writes
  // into two updateMany calls instead of one query per row (avoids the N+1).
  const newlyMissingIds = missingFiles
    .filter((doc) => !doc.isStorageMissing)
    .map((doc) => doc.id);

  if (newlyMissingIds.length > 0) {
    await prisma.appointmentDocument.updateMany({
      where: { id: { in: newlyMissingIds } },
      data: { isStorageMissing: true, missingDetectedAt: new Date() },
    });
  }

  if (recoveredIds.length > 0) {
    await prisma.appointmentDocument.updateMany({
      where: { id: { in: recoveredIds } },
      data: { isStorageMissing: false, missingDetectedAt: null },
    });
    console.log(
      `   ♻️ Cleared missing flag on ${recoveredIds.length} recovered files`,
    );
  }

  return newlyMissingIds.length;
}

/**
 * Delete orphaned files older than grace period
 */
async function deleteOrphanedFiles(
  supabase: SupabaseClient,
  orphanedFiles: OrphanedFile[],
): Promise<number> {
  const graceDate = new Date(
    Date.now() - ORPHAN_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  let deleted = 0;

  console.log(
    `\n🗑️ Deleting orphaned files older than ${ORPHAN_GRACE_PERIOD_DAYS} days...`,
  );

  // Group by bucket
  const byBucket = orphanedFiles.reduce(
    (acc, file) => {
      if (!acc[file.bucket]) acc[file.bucket] = [];
      acc[file.bucket].push(file);
      return acc;
    },
    {} as Record<string, OrphanedFile[]>,
  );

  for (const [bucket, files] of Object.entries(byBucket)) {
    const filesToDelete = files.filter(
      (f) => f.createdAt && f.createdAt < graceDate,
    );

    if (filesToDelete.length === 0) {
      console.log(`   No files to delete in ${bucket}`);
      continue;
    }

    console.log(`   Deleting ${filesToDelete.length} files from ${bucket}...`);

    const paths = filesToDelete.map((f) => f.path);

    // Delete in batches
    const batchSize = 100;
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      const { error } = await supabase.storage.from(bucket).remove(batch);

      if (error) {
        console.error(`   Error deleting batch from ${bucket}:`, error);
      } else {
        deleted += batch.length;
      }
    }
  }

  console.log(`   ✅ Deleted ${deleted} orphaned files`);
  return deleted;
}

/**
 * Main function to reconcile document storage
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
export async function reconcileDocumentStorage(): Promise<DocumentReconciliationResult> {
  return withCronLock("reconcile-document-storage", { failMode: "open", ttlMs: LONG_JOB_TTL_MS }, () =>
    reconcileDocumentStorageUnlocked(),
  );
}

async function reconcileDocumentStorageUnlocked(): Promise<DocumentReconciliationResult> {
  const errors: string[] = [];
  let orphanedFilesFound = 0;
  let orphanedFilesDeleted = 0;
  let missingFilesFound = 0;
  let missingFilesMarked = 0;

  console.log("📂 Starting document storage reconciliation...");
  console.log(`   Buckets to check: ${BUCKETS_TO_CHECK.join(", ")}`);
  console.log(`   Orphan grace period: ${ORPHAN_GRACE_PERIOD_DAYS} days`);

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    errors.push(
      "Supabase admin client not available - cannot reconcile storage",
    );
    return {
      success: false,
      orphanedFilesFound,
      orphanedFilesDeleted,
      missingFilesFound,
      missingFilesMarked,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  // Probe storage health before proceeding — if Supabase Storage is transiently
  // unreachable (e.g. during migration), the reconciliation would falsely mark
  // valid files as orphaned and delete them.
  try {
    const { error: probeError } = await supabase.storage
      .from("documents")
      .list("", { limit: 1 });
    if (probeError) {
      const msg = `Storage health probe failed: ${probeError.message}. Aborting to prevent false deletions.`;
      console.warn(`⚠️ ${msg}`);
      errors.push(msg);
      return {
        success: false,
        orphanedFilesFound,
        orphanedFilesDeleted,
        missingFilesFound,
        missingFilesMarked,
        errors,
        timestamp: new Date().toISOString(),
      };
    }
    console.log("   ✅ Storage health probe passed");
  } catch (probeErr) {
    const msg = `Storage unreachable: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}. Aborting to prevent false deletions.`;
    console.warn(`⚠️ ${msg}`);
    errors.push(msg);
    return {
      success: false,
      orphanedFilesFound,
      orphanedFilesDeleted,
      missingFilesFound,
      missingFilesMarked,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    // Find orphaned files in documents bucket
    const orphanedDocuments = await findOrphanedDocuments(supabase);
    orphanedFilesFound = orphanedDocuments.length;

    if (orphanedDocuments.length > 0) {
      console.log("\n📋 Orphaned files:");
      orphanedDocuments.slice(0, 10).forEach((f) => {
        console.log(
          `   - ${f.bucket}/${f.path} (created: ${f.createdAt?.toISOString() || "unknown"})`,
        );
      });
      if (orphanedDocuments.length > 10) {
        console.log(`   ... and ${orphanedDocuments.length - 10} more`);
      }

      // Delete orphaned files older than grace period
      orphanedFilesDeleted = await deleteOrphanedFiles(
        supabase,
        orphanedDocuments,
      );
    }

    // Find missing files (and rows whose file has returned)
    const { missingFiles: missingDocuments, recoveredIds } =
      await findMissingFiles(supabase);
    missingFilesFound = missingDocuments.length;

    // #694 — persist the missing-storage flag instead of only logging it, so
    // the UI/ops can surface broken downloads; clears the flag on recovery.
    missingFilesMarked = await persistMissingState(
      missingDocuments,
      recoveredIds,
    );

    if (missingDocuments.length > 0) {
      console.log("\n⚠️ Missing files (in DB but not in storage):");
      missingDocuments.slice(0, 10).forEach((d) => {
        console.log(`   - ${d.id}: ${d.storagePath}`);
      });
      if (missingDocuments.length > 10) {
        console.log(`   ... and ${missingDocuments.length - 10} more`);
      }

      // Note: We don't automatically delete DB records for missing files
      // This should be handled manually or through a separate cleanup process
      console.log("\n   ℹ️ Missing file records should be reviewed manually");
    }
  } catch (error) {
    const msg = `Failed to reconcile document storage: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  // Summary
  console.log("\n📊 Document Storage Reconciliation Summary:");
  console.log(`   Orphaned files found: ${orphanedFilesFound}`);
  console.log(`   Orphaned files deleted: ${orphanedFilesDeleted}`);
  console.log(`   Missing files found: ${missingFilesFound}`);
  console.log(`   Missing files newly marked: ${missingFilesMarked}`);

  if (missingFilesFound > 0) {
    console.log("\n⚠️ ACTION REQUIRED:");
    console.log("   Some DB records reference missing files!");
  }

  return {
    success: errors.length === 0,
    orphanedFilesFound,
    orphanedFilesDeleted,
    missingFilesFound,
    missingFilesMarked,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
