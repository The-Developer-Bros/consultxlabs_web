#!/usr/bin/env node

/**
 * Cleanup Empty Folders Script
 *
 * This script cleans up empty folders in Supabase storage.
 * It runs daily via GitHub Actions to maintain clean storage structure.
 *
 * Folder structure being maintained:
 * documents/
 *   appointments/
 *     {appointmentId}/
 *       consultee-{consulteeId}/
 *         {files}
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { FileObject } from "@supabase/storage-js";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";

interface FolderItem {
  name: string;
  fullPath: string;
}

// Initialize Supabase client with service role key for admin operations
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("Missing required environment variables:");
  console.error("- NEXT_PUBLIC_SUPABASE_URL:", !!supabaseUrl);
  console.error("- SUPABASE_SERVICE_ROLE_KEY:", !!supabaseServiceKey);
  process.exit(1);
}

const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);

/**
 * Check if a folder is empty (contains no files)
 */
async function isFolderEmpty(
  bucketName: string,
  folderPath: string,
): Promise<boolean> {
  try {
    const { data: files, error } = await supabase.storage
      .from(bucketName)
      .list(folderPath, {
        limit: 1, // We only need to check if there's at least one item
      });

    if (error) {
      console.error(`Error checking folder ${folderPath}:`, error);
      return false; // Don't delete if we can't verify
    }

    // Folder is empty if no files are returned
    return !files || files.length === 0;
  } catch (error) {
    console.error(`Error checking folder ${folderPath}:`, error);
    return false;
  }
}

/**
 * Get all folders at a specific level
 */
async function getFoldersInPath(
  bucketName: string,
  path: string,
): Promise<FolderItem[]> {
  try {
    const { data: items, error } = await supabase.storage
      .from(bucketName)
      .list(path);

    if (error) {
      console.error(`Error listing folders in ${path}:`, error);
      return [];
    }

    if (!items) {
      return [];
    }

    // Filter for folders only (items without file extensions or with specific folder markers)
    // In Supabase, folders are typically identified by not having file extensions
    const folders = items.filter(
      (item: FileObject) => !item.name.includes(".") || item.metadata?.isFolder,
    );

    return folders.map(
      (folder: FileObject): FolderItem => ({
        name: folder.name,
        fullPath: path ? `${path}/${folder.name}` : folder.name,
      }),
    );
  } catch (error) {
    console.error(`Error listing folders in ${path}:`, error);
    return [];
  }
}

/**
 * Delete an empty folder
 */
async function deleteEmptyFolder(
  bucketName: string,
  folderPath: string,
): Promise<boolean> {
  try {
    // Note: Supabase doesn't have explicit folder deletion
    // Empty folders typically get cleaned up automatically
    // But we can try to remove any placeholder files or empty markers

    console.log(`Attempting to clean up empty folder: ${folderPath}`);

    // List any remaining items in the folder
    const { data: items, error } = await supabase.storage
      .from(bucketName)
      .list(folderPath);

    if (error) {
      console.error(`Error listing items in ${folderPath}:`, error);
      return false;
    }

    if (!items) {
      return true;
    }

    // Remove any placeholder or empty marker files
    const placeholderFiles = items.filter(
      (item: FileObject) =>
        item.name === ".keep" ||
        item.name === ".gitkeep" ||
        item.name === "placeholder" ||
        item.metadata?.size === 0,
    );

    if (placeholderFiles.length > 0) {
      const filesToDelete = placeholderFiles.map(
        (file: FileObject) => `${folderPath}/${file.name}`,
      );

      const { error: deleteError } = await supabase.storage
        .from(bucketName)
        .remove(filesToDelete);

      if (deleteError) {
        console.error(
          `Error deleting placeholder files from ${folderPath}:`,
          deleteError,
        );
        return false;
      }

      console.log(
        `✓ Cleaned up ${filesToDelete.length} placeholder files from ${folderPath}`,
      );
    }

    return true;
  } catch (error) {
    console.error(`Error deleting empty folder ${folderPath}:`, error);
    return false;
  }
}

/**
 * Main cleanup function
 */
// #1169 — the one scheduled job that ran with no cron lock at all. Fail-open:
// storage-only, repeat-safe; the lock only stops schedule overlap double-runs.
async function cleanupEmptyFolders(): Promise<void> {
  return withCronLock("cleanup-empty-folders", { failMode: "open" }, () =>
    cleanupEmptyFoldersUnlocked(),
  );
}

async function cleanupEmptyFoldersUnlocked(): Promise<void> {
  console.log("🧹 Starting empty folder cleanup...");
  console.log("Timestamp:", new Date().toISOString());

  const bucketName = "documents";
  let foldersChecked = 0;
  let foldersDeleted = 0;

  try {
    // Get all appointment folders
    console.log("\n📁 Checking appointments folder...");
    const appointmentFolders = await getFoldersInPath(
      bucketName,
      "appointments",
    );

    console.log(`Found ${appointmentFolders.length} appointment folders`);

    for (const appointmentFolder of appointmentFolders) {
      foldersChecked++;
      console.log(
        `\n🔍 Checking appointment folder: ${appointmentFolder.name}`,
      );

      // Get consultee folders within this appointment folder
      const consulteeFolders = await getFoldersInPath(
        bucketName,
        appointmentFolder.fullPath,
      );

      if (consulteeFolders.length === 0) {
        console.log(
          `  📂 Appointment folder ${appointmentFolder.name} is empty`,
        );

        const isEmpty = await isFolderEmpty(
          bucketName,
          appointmentFolder.fullPath,
        );
        if (isEmpty) {
          const deleted = await deleteEmptyFolder(
            bucketName,
            appointmentFolder.fullPath,
          );
          if (deleted) {
            foldersDeleted++;
            console.log(
              `  ✅ Cleaned up empty appointment folder: ${appointmentFolder.name}`,
            );
          }
        }
        continue;
      }

      // Check each consultee folder
      let emptyConsulteeFolders = 0;
      for (const consulteeFolder of consulteeFolders) {
        foldersChecked++;
        const isEmpty = await isFolderEmpty(
          bucketName,
          consulteeFolder.fullPath,
        );

        if (isEmpty) {
          emptyConsulteeFolders++;
          const deleted = await deleteEmptyFolder(
            bucketName,
            consulteeFolder.fullPath,
          );
          if (deleted) {
            foldersDeleted++;
            console.log(
              `    ✅ Cleaned up empty consultee folder: ${consulteeFolder.name}`,
            );
          }
        } else {
          console.log(
            `    📄 Consultee folder ${consulteeFolder.name} contains files`,
          );
        }
      }

      // If all consultee folders were empty, check if appointment folder should be cleaned
      if (emptyConsulteeFolders === consulteeFolders.length) {
        const appointmentIsEmpty = await isFolderEmpty(
          bucketName,
          appointmentFolder.fullPath,
        );
        if (appointmentIsEmpty) {
          const deleted = await deleteEmptyFolder(
            bucketName,
            appointmentFolder.fullPath,
          );
          if (deleted) {
            foldersDeleted++;
            console.log(
              `  ✅ Cleaned up empty appointment folder: ${appointmentFolder.name}`,
            );
          }
        }
      }
    }

    // Check if appointments root folder is empty
    const appointmentsIsEmpty = await isFolderEmpty(bucketName, "appointments");
    if (appointmentsIsEmpty) {
      console.log("\n📂 Appointments root folder is empty");
      await deleteEmptyFolder(bucketName, "appointments");
    }

    console.log("\n🎉 Cleanup completed successfully!");
    console.log(`📊 Summary:`);
    console.log(`   - Folders checked: ${foldersChecked}`);
    console.log(`   - Folders cleaned: ${foldersDeleted}`);

    if (foldersDeleted > 0) {
      console.log(`\n🧽 Cleaned up ${foldersDeleted} empty folders`);
    } else {
      console.log(`\n✨ No empty folders found - storage is already clean!`);
    }
  } catch (error) {
    console.error("\n❌ Error during cleanup:", error);
    // Throw instead of process.exit: a hard exit inside the lock would skip
    // releaseLock's finally and leak the lock until TTL.
    throw error;
  }
}

/**
 * Handle script execution
 */
async function main(): Promise<void> {
  try {
    await cleanupEmptyFolders();
    console.log("\n✅ Cleanup script completed");
    process.exit(0);
  } catch (error) {
    if (error instanceof CronLockHeldError) {
      // Another run is in flight — a clean skip, not a pageable failure.
      console.log(`⏭️  ${error.message}`);
      process.exit(0);
    }
    console.error("\n❌ Cleanup script failed:", error);
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  main();
}

export { cleanupEmptyFolders };
