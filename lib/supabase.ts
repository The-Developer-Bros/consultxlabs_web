import "server-only";
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FileObject, SearchOptions } from "@supabase/storage-js"; // Import FileObject type

// Define types for image transformation and the enhanced file object
interface TransformOptions {
  width?: number;
  height?: number;
  resize?: "cover" | "contain" | "fill";
  quality?: number;
  // format is not a direct option here; Supabase handles it via accept headers or URL extension
}

export interface SupabaseImageFile extends FileObject {
  url: string; // Original public URL
  transformedUrl: string; // Transformed URL (will be same as url if no transformOptions)
}

// Rich result for document-style uploads (signed/public, carries file metadata).
interface DocumentUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  error?: string;
}

// Slim result for image-style uploads (success + url + path only).
interface AssetUploadResult {
  success: boolean;
  fileUrl?: string;
  storagePath?: string;
  error?: string;
}

// #1270 — the clients and the two storage primitives now live in a leaf module
// with NO `server-only` marker, so a cron process can reach them. Re-exported
// below so `@/lib/supabase` keeps exactly the surface it had.
import {
  supabase,
  supabaseAdmin,
  ensureBucketExists,
  generateStorageFileName,
  deleteAsset,
  deleteAppointmentDocument,
  type BucketOptions,
} from "./supabase-storage-core";

// ---------------------------------------------------------------------------
// Generic storage core
//
// One validate-size → validate-MIME → ensureBucket → [pre-delete] → upload →
// URL/sign pipeline, shared by every upload family. Per-family differences
// (bucket, folder template, size cap, MIME list, public-vs-signed, signing
// client, upsert, folder-replace, error copy) are passed in as options.
// ---------------------------------------------------------------------------

// List files in a folder (thin wrapper; default opts == omit).
const listAssets = (bucket: string, folder: string, opts?: SearchOptions) =>
  supabase.storage.from(bucket).list(folder, opts);

// Public CDN URL for an object, optionally transformed.
const getPublicAssetUrl = (
  bucket: string,
  path: string,
  transform?: TransformOptions,
): string => {
  const { data } = supabase.storage
    .from(bucket)
    .getPublicUrl(path, transform ? { transform } : undefined);
  return data.publicUrl;
};

// Signed URL for a private object. Defaults to the admin client (RLS bypass).
const getSignedAssetUrl = (
  bucket: string,
  path: string,
  ttl = 3600,
  client: SupabaseClient = supabaseAdmin ?? supabase,
) => client.storage.from(bucket).createSignedUrl(path, ttl);

// Remove every object under a folder. Returns false on list/remove error,
// true when the folder is already empty or fully cleared.
const deleteAssetFolder = async (
  bucket: string,
  folder: string,
): Promise<boolean> => {
  try {
    const { data: files, error: listError } = await listAssets(bucket, folder);
    if (listError) {
      console.error("Error listing storage folder:", listError);
      return false;
    }
    if (!files || files.length === 0) {
      return true;
    }
    const filesToDelete = files.map((f) => `${folder}/${f.name}`);
    const { error: deleteError } = await supabase.storage
      .from(bucket)
      .remove(filesToDelete);
    if (deleteError) {
      console.error("Error deleting storage folder:", deleteError);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error deleting storage folder:", error);
    return false;
  }
};

interface UploadAssetErrors {
  // type may interpolate the rejected MIME; evaluated only after the file is
  // present + over the type gate, so a null file never reaches it.
  size?: string;
  type?: string | ((fileType: string) => string);
  bucketNotReady?: string;
  signFailed?: string;
}

interface UploadAssetOptions {
  bucket: string;
  folder: string;
  file: File;
  maxBytes: number;
  allowedMime: string[];
  access: "public" | "signed";
  signedTtl?: number;
  upsert?: boolean;
  replaceFolder?: boolean;
  cacheControl?: string;
  ensureBucket?: BucketOptions;
  fileNameFor?: (mimeType: string) => string;
  signWith?: SupabaseClient;
  errors?: UploadAssetErrors;
}

/**
 * Validate, (optionally clear the folder), upload, and resolve a URL for a file.
 * Returns the rich DocumentUploadResult; image callers narrow it to the slim shape.
 */
const uploadAsset = async (
  opts: UploadAssetOptions,
): Promise<DocumentUploadResult> => {
  const {
    bucket,
    folder,
    file,
    maxBytes,
    allowedMime,
    access,
    signedTtl = 3600,
    upsert = false,
    replaceFolder = false,
    cacheControl = "3600",
    ensureBucket,
    fileNameFor = generateStorageFileName,
    signWith,
    errors,
  } = opts;

  try {
    if (!file) {
      return { success: false, error: "No file provided" };
    }

    if (file.size > maxBytes) {
      return {
        success: false,
        error:
          errors?.size ??
          `File size exceeds ${Math.round(maxBytes / 1048576)}MB limit`,
      };
    }

    if (!allowedMime.includes(file.type)) {
      const typeErr = errors?.type;
      return {
        success: false,
        error:
          typeof typeErr === "function"
            ? typeErr(file.type)
            : (typeErr ?? "File type not supported"),
      };
    }

    const bucketReady = await ensureBucketExists(bucket, ensureBucket);
    if (!bucketReady) {
      return {
        success: false,
        error:
          errors?.bucketNotReady ?? `Storage bucket '${bucket}' not found.`,
      };
    }

    const fileName = fileNameFor(file.type);
    const storagePath = `${folder}/${fileName}`;

    // Folder-replace: best-effort clear of prior assets so the folder holds a
    // single current file. Errors are swallowed — a failed cleanup must not
    // block the new upload.
    if (replaceFolder) {
      try {
        const { data: existingFiles } = await listAssets(bucket, folder);
        if (existingFiles && existingFiles.length > 0) {
          const filesToDelete = existingFiles.map((f) => `${folder}/${f.name}`);
          await supabase.storage.from(bucket).remove(filesToDelete);
        }
      } catch {
        // Ignore errors when cleaning up old files
      }
    }

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, file, { cacheControl, upsert });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), {
        tags: { subsystem: "storage" },
      });
      return { success: false, error: uploadError.message };
    }

    let fileUrl: string;
    if (access === "signed") {
      const { data: signedUrlData, error: signedUrlError } =
        await getSignedAssetUrl(bucket, storagePath, signedTtl, signWith);
      if (signedUrlError || !signedUrlData?.signedUrl) {
        console.error("Failed to create signed URL:", signedUrlError);
        // Upload succeeded but signing failed — best-effort remove the now-orphaned
        // object so a failed upload doesn't leave a dangling file. (#945 review)
        await deleteAsset(bucket, storagePath);
        Sentry.captureException(
          signedUrlError instanceof Error
            ? signedUrlError
            : new Error("Failed to create signed URL"),
          { tags: { subsystem: "storage" } },
        );
        return {
          success: false,
          error: errors?.signFailed ?? "Failed to generate document URL",
        };
      }
      fileUrl = signedUrlData.signedUrl;
    } else {
      fileUrl = getPublicAssetUrl(bucket, storagePath);
    }

    return {
      success: true,
      fileUrl,
      storagePath,
      fileName,
      fileSize: file.size,
      mimeType: file.type,
    };
  } catch (error) {
    console.error("Error uploading asset:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "storage" } },
    );
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

// Narrow the rich upload result down to the slim image shape.
const toAssetResult = (result: DocumentUploadResult): AssetUploadResult =>
  result.success
    ? {
        success: true,
        fileUrl: result.fileUrl,
        storagePath: result.storagePath,
      }
    : { success: false, error: result.error };

const fetchImagesFromSupabaseStorage = async (
  bucket: string,
  path: string,
  transformOptions?: TransformOptions,
): Promise<SupabaseImageFile[]> => {
  try {
    const { data: files, error: listError } = await supabase.storage
      .from(bucket)
      .list(path, {
        limit: 10, // Consider making limit and offset parameters if more flexibility is needed
        offset: 0,
        sortBy: { column: "name", order: "asc" }, // Sorting can be removed if not strictly necessary for minor perf gain
      });

    if (listError) {
      console.error(
        `Error listing images from Supabase bucket '${bucket}', path '${path}':`,
        listError,
      );
      return [];
    }

    if (!files || files.length === 0) {
      return [];
    }

    return files.map((file) => {
      const { data: originalUrlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(`${path}/${file.name}`);

      let transformedPublicUrl = originalUrlData.publicUrl; // Default to original

      // Apply transformations if options are provided
      if (transformOptions && Object.keys(transformOptions).length > 0) {
        const { data: tUrlData } = supabase.storage
          .from(bucket)
          .getPublicUrl(`${path}/${file.name}`, {
            transform: transformOptions,
          });
        transformedPublicUrl = tUrlData.publicUrl;
      }

      return {
        ...file, // Spread the original file properties (id, name, metadata, etc.)
        url: originalUrlData.publicUrl,
        transformedUrl: transformedPublicUrl,
      };
    });
  } catch (error) {
    console.error("Unexpected error in fetchImagesFromSupabaseStorage:", error);
    return [];
  }
};

// Allowed MIME types for documents (shared across plan-material + consultant uploads)
const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/zip",
  "application/x-rar-compressed",
];

// Shared "File type '<x>' not supported" copy for plan-material + consultant.
const documentTypeError = (fileType: string): string =>
  `File type '${fileType}' not supported. Allowed types: PDF, Word, Excel, PowerPoint, images, text files, and archives.`;

// Document upload types
interface DocumentUploadOptions {
  appointmentId: string;
  consulteeId: string;
  description?: string;
  file: File;
}

/**
 * Upload document to Supabase storage with organized folder structure.
 * Structure: appointments/{appointmentId}/consultee-{consulteeId}/{filename}
 * Signed URL via admin client (falls back to anon).
 */
const uploadAppointmentDocument = (
  options: DocumentUploadOptions,
): Promise<DocumentUploadResult> => {
  const { appointmentId, consulteeId, file } = options;
  return uploadAsset({
    bucket: "documents",
    folder: `appointments/${appointmentId}/consultee-${consulteeId}`,
    file,
    maxBytes: 10 * 1024 * 1024,
    allowedMime: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/gif",
      "text/plain",
    ],
    access: "signed",
    ensureBucket: { public: false },
    errors: {
      bucketNotReady:
        "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard (private), or add SUPABASE_SERVICE_ROLE_KEY to your environment variables for automatic bucket creation.",
    },
  });
};

// Plan material upload types
export type PlanType = "consultation" | "subscription" | "webinar" | "class";

interface PlanMaterialUploadOptions {
  planType: PlanType;
  planId: string;
  file: File;
  description?: string;
}

// Consultant document upload types (for response documents)
interface ConsultantDocumentUploadOptions {
  appointmentId: string;
  consultantId: string;
  file: File;
  responseToDocumentId?: string;
  description?: string;
}

/**
 * Upload plan material to Supabase storage.
 * Structure: plans/{planType}-plans/{planId}/{filename}
 * Signed URL via anon client only.
 */
const uploadPlanMaterial = (
  options: PlanMaterialUploadOptions,
): Promise<DocumentUploadResult> => {
  const { planType, planId, file } = options;
  return uploadAsset({
    bucket: "documents",
    folder: `plans/${planType}-plans/${planId}`,
    file,
    maxBytes: 10 * 1024 * 1024,
    allowedMime: ALLOWED_DOCUMENT_TYPES,
    access: "signed",
    signWith: supabase, // anon-only signing (preserve)
    ensureBucket: { public: false },
    errors: {
      type: documentTypeError,
      bucketNotReady:
        "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard.",
    },
  });
};

/**
 * Delete plan material from Supabase storage
 */
const deletePlanMaterial = (storagePath: string): Promise<boolean> =>
  deleteAsset("documents", storagePath);

/**
 * Upload consultant document (response document) to Supabase storage.
 * Structure: appointments/{appointmentId}/consultant-{consultantId}/{filename}
 * Signed URL via anon client only.
 */
const uploadConsultantDocument = (
  options: ConsultantDocumentUploadOptions,
): Promise<DocumentUploadResult> => {
  const { appointmentId, consultantId, file } = options;
  return uploadAsset({
    bucket: "documents",
    folder: `appointments/${appointmentId}/consultant-${consultantId}`,
    file,
    maxBytes: 10 * 1024 * 1024,
    allowedMime: ALLOWED_DOCUMENT_TYPES,
    access: "signed",
    signWith: supabase, // anon-only signing (preserve)
    ensureBucket: { public: false },
    errors: {
      type: documentTypeError,
      bucketNotReady:
        "Document storage bucket not found. Please create a 'documents' bucket in your Supabase dashboard.",
    },
  });
};

// Support ticket attachment types
interface SupportAttachmentUploadOptions {
  ticketId: string;
  file: File;
}

/**
 * Upload support ticket attachment to Supabase storage (public URL).
 */
const uploadSupportTicketAttachment = (
  options: SupportAttachmentUploadOptions,
): Promise<DocumentUploadResult> => {
  const { ticketId, file } = options;
  return uploadAsset({
    bucket: "support-attachments",
    folder: `support-tickets/${ticketId}`,
    file,
    maxBytes: 10 * 1024 * 1024,
    allowedMime: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "text/plain",
    ],
    access: "public",
    errors: {
      bucketNotReady:
        "Support attachments storage bucket not found. Please create a 'support-attachments' bucket in your Supabase dashboard with public access enabled.",
    },
  });
};

/**
 * Delete support ticket attachment from Supabase storage
 */
const deleteSupportTicketAttachment = (storagePath: string): Promise<boolean> =>
  deleteAsset("support-attachments", storagePath);

/**
 * Get manual bucket creation instructions
 */
const getManualBucketInstructions = (bucketName: string): string => {
  return `
To manually create the '${bucketName}' bucket:

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Navigate to Storage > Buckets
4. Click "Create Bucket"
5. Set bucket name: "${bucketName}"
6. Enable "Public bucket" option
7. Click "Create bucket"

OR

Add SUPABASE_SERVICE_ROLE_KEY environment variable for automatic bucket creation.
You can find this key in: Dashboard > Settings > API > service_role key
`.trim();
};

// Plan image upload types.
//
// All four plan models carry `imageUrl`, but only these two buckets existed, so
// a consultation or subscription could never actually be given a cover image
// however the form was built. The storage path is `{planType}/{planId}`, so
// adding a type needs no bucket provisioning — only ownership verification,
// which lives in app/api/plans/image/route.ts.
export type TPlanImageType =
  | "webinar-plans"
  | "class-plans"
  | "consultation-plans"
  | "subscription-plans";

interface IPlanImageUploadOptions {
  planType: TPlanImageType;
  planId: string;
  file: File;
}

/**
 * Upload plan cover image to Supabase storage (public URL, upsert-single-file).
 * Structure: plan-images/{planType}/{planId}/{filename}
 */
const uploadPlanImage = async (
  options: IPlanImageUploadOptions,
): Promise<AssetUploadResult> => {
  const { planType, planId, file } = options;
  const result = await uploadAsset({
    bucket: "plan-images",
    folder: `${planType}/${planId}`,
    file,
    maxBytes: 5 * 1024 * 1024,
    allowedMime: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
    access: "public",
    upsert: true,
    replaceFolder: true,
    errors: {
      type: "File type not supported. Please use JPEG, PNG, or WebP.",
      bucketNotReady:
        "Plan images storage bucket not found. Please create a 'plan-images' bucket in your Supabase dashboard.",
    },
  });
  return toAssetResult(result);
};

/**
 * Delete plan cover image from Supabase storage
 */
const deletePlanImage = (
  planType: TPlanImageType,
  planId: string,
): Promise<boolean> =>
  deleteAssetFolder("plan-images", `${planType}/${planId}`);

// Profile display image upload types (square image for Explore Experts page)
interface ProfileDisplayImageUploadOptions {
  userId: string;
  file: File;
}

// Allowed MIME types for profile display images
const ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

const PROFILE_DISPLAY_IMAGE_MAX_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Upload profile display image to Supabase storage (square image for Explore Experts).
 * Structure: profile-images/display/{userId}/{filename}
 */
const uploadProfileDisplayImage = async (
  options: ProfileDisplayImageUploadOptions,
): Promise<AssetUploadResult> => {
  const { userId, file } = options;
  const result = await uploadAsset({
    bucket: "profile-images",
    folder: `display/${userId}`,
    file,
    maxBytes: PROFILE_DISPLAY_IMAGE_MAX_SIZE,
    allowedMime: ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES,
    access: "public",
    upsert: true,
    replaceFolder: true,
    errors: {
      type: "File type not supported. Please use JPEG, PNG, or WebP.",
      bucketNotReady:
        "Profile images storage bucket not found. Please create a 'profile-images' bucket in your Supabase dashboard.",
    },
  });
  return toAssetResult(result);
};

/**
 * Delete profile display image from Supabase storage
 */
const deleteProfileDisplayImage = (userId: string): Promise<boolean> =>
  deleteAssetFolder("profile-images", `display/${userId}`);

// Allowed MIME types and max size for profile avatar images
const ALLOWED_PROFILE_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

const PROFILE_IMAGE_MAX_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Upload profile avatar image to Supabase storage (general avatar for Navbar/session).
 * Structure: profile-images/avatars/{userId}/{filename}
 */
const uploadProfileImage = async (options: {
  userId: string;
  file: File;
}): Promise<AssetUploadResult> => {
  const { userId, file } = options;
  const result = await uploadAsset({
    bucket: "profile-images",
    folder: `avatars/${userId}`,
    file,
    maxBytes: PROFILE_IMAGE_MAX_SIZE,
    allowedMime: ALLOWED_PROFILE_IMAGE_TYPES,
    access: "public",
    upsert: true,
    replaceFolder: true,
    errors: {
      type: "File type not supported. Please use JPEG, PNG, or WebP.",
      bucketNotReady:
        "Profile images storage bucket not found. Please create a 'profile-images' bucket in your Supabase dashboard.",
    },
  });
  return toAssetResult(result);
};

/**
 * Delete profile avatar image from Supabase storage
 */
const deleteProfileImage = (userId: string): Promise<boolean> =>
  deleteAssetFolder("profile-images", `avatars/${userId}`);

// Organization branding image upload types (logo + banner)
interface OrganizationBrandingUploadOptions {
  organizationId: string;
  file: File;
}

// Allowed MIME types for organization branding images.
// SVG is included so brand teams can upload crisp vector logos; JPEG/PNG/WebP
// cover photographic banners.
const ALLOWED_ORG_BRANDING_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/svg+xml",
];

const ORG_LOGO_MAX_SIZE = 2 * 1024 * 1024; // 2MB
const ORG_BANNER_MAX_SIZE = 5 * 1024 * 1024; // 5MB

const ORG_BRANDING_BUCKET = "organization-images";

// generateStorageFileName() relies on MIME_TO_EXT, which doesn't ship with
// SVG by default. Add the local mapping so SVG uploads get a .svg extension.
const ORG_BRANDING_MIME_TO_EXT: Record<string, string> = {
  "image/svg+xml": "svg",
};

const buildOrgBrandingFileName = (mimeType: string): string => {
  const localExt = ORG_BRANDING_MIME_TO_EXT[mimeType];
  if (localExt) {
    return `${globalThis.crypto.randomUUID()}.${localExt}`;
  }
  return generateStorageFileName(mimeType);
};

const uploadOrganizationBrandingImage = async (
  options: OrganizationBrandingUploadOptions,
  kind: "logo" | "banner",
): Promise<AssetUploadResult> => {
  const { organizationId, file } = options;
  const result = await uploadAsset({
    bucket: ORG_BRANDING_BUCKET,
    folder:
      kind === "logo" ? `logos/${organizationId}` : `banners/${organizationId}`,
    file,
    maxBytes: kind === "logo" ? ORG_LOGO_MAX_SIZE : ORG_BANNER_MAX_SIZE,
    allowedMime: ALLOWED_ORG_BRANDING_IMAGE_TYPES,
    access: "public",
    upsert: true,
    replaceFolder: true,
    fileNameFor: buildOrgBrandingFileName,
    ensureBucket: {
      public: true,
      allowedMimeTypes: ALLOWED_ORG_BRANDING_IMAGE_TYPES,
      fileSizeLimit: ORG_BANNER_MAX_SIZE,
    },
    errors: {
      type: "File type not supported. Please use JPEG, PNG, WebP, or SVG.",
      bucketNotReady: `Organization images storage bucket not found. Please create an '${ORG_BRANDING_BUCKET}' bucket in your Supabase dashboard.`,
    },
  });
  return toAssetResult(result);
};

/**
 * Upload organization logo image to Supabase storage.
 * Structure: organization-images/logos/{organizationId}/{filename}
 */
const uploadOrganizationLogo = (
  options: OrganizationBrandingUploadOptions,
): Promise<AssetUploadResult> =>
  uploadOrganizationBrandingImage(options, "logo");

/**
 * Upload organization banner image to Supabase storage.
 * Structure: organization-images/banners/{organizationId}/{filename}
 */
const uploadOrganizationBanner = (
  options: OrganizationBrandingUploadOptions,
): Promise<AssetUploadResult> =>
  uploadOrganizationBrandingImage(options, "banner");

/**
 * Delete organization logo image from Supabase storage.
 */
const deleteOrganizationLogo = (organizationId: string): Promise<boolean> =>
  deleteAssetFolder(ORG_BRANDING_BUCKET, `logos/${organizationId}`);

/**
 * Delete organization banner image from Supabase storage.
 */
const deleteOrganizationBanner = (organizationId: string): Promise<boolean> =>
  deleteAssetFolder(ORG_BRANDING_BUCKET, `banners/${organizationId}`);

/**
 * Generic upload to Supabase storage (Buffer-based, explicit contentType).
 * Returns { url, error } - url is the signed (private) or public URL if successful.
 */
const uploadToSupabase = async (
  storagePath: string,
  buffer: Buffer,
  mimeType: string,
  bucketName: string = "documents",
): Promise<{ url: string | null; error: string | null }> => {
  try {
    // Ensure bucket exists — documents bucket is private
    const isPrivateBucket = bucketName === "documents";
    const bucketReady = await ensureBucketExists(
      bucketName,
      isPrivateBucket ? { public: false } : undefined,
    );
    if (!bucketReady) {
      return {
        url: null,
        error: `Bucket '${bucketName}' not found and could not be created`,
      };
    }

    // Upload file
    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      Sentry.captureException(new Error(uploadError.message), {
        tags: { subsystem: "storage" },
      });
      return { url: null, error: uploadError.message };
    }

    // Private buckets: generate a signed URL via admin client
    // Public buckets: use getPublicUrl for permanent, CDN-friendly links
    if (isPrivateBucket) {
      const { data: signedUrlData, error: signedUrlError } =
        await getSignedAssetUrl(bucketName, storagePath);

      if (signedUrlError || !signedUrlData?.signedUrl) {
        console.error("Failed to create signed URL:", signedUrlError);
        // Upload succeeded but signing failed — best-effort remove the now-orphaned
        // object so a failed upload doesn't leave a dangling file. (#945 review)
        await deleteAsset(bucketName, storagePath);
        Sentry.captureException(
          signedUrlError instanceof Error
            ? signedUrlError
            : new Error("Failed to create signed URL"),
          { tags: { subsystem: "storage" } },
        );
        return { url: null, error: "Failed to generate document URL" };
      }

      return { url: signedUrlData.signedUrl, error: null };
    }

    return { url: getPublicAssetUrl(bucketName, storagePath), error: null };
  } catch (error) {
    console.error("Error in uploadToSupabase:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "storage" } },
    );
    return {
      url: null,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
};

/**
 * Generic delete from Supabase storage
 */
const deleteFromSupabase = async (
  storagePath: string,
  bucketName: string = "documents",
): Promise<boolean> => {
  try {
    const { error } = await supabase.storage
      .from(bucketName)
      .remove([storagePath]);

    if (error) {
      console.error("Error deleting from Supabase:", error);
      Sentry.captureException(new Error(error.message), {
        tags: { subsystem: "storage" },
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error in deleteFromSupabase:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "storage" } },
    );
    return false;
  }
};

// ============================================================================
// Recording marketplace preview assets (#366)
// Preview clips + thumbnails are PUBLIC marketing assets: explore cards are
// ISR-cached and anonymous, so they can never depend on signed URLs. Full
// recordings stay in the private `recordings` bucket.
// ============================================================================

const RECORDING_PREVIEWS_BUCKET = "recordings-previews";
const RECORDING_PREVIEW_MAX_BYTES = 50 * 1024 * 1024; // 50MB clip
const RECORDING_PREVIEW_THUMB_MAX_BYTES = 5 * 1024 * 1024; // 5MB poster
const ALLOWED_RECORDING_PREVIEW_VIDEO_TYPES = ["video/mp4", "video/webm"];
const ALLOWED_RECORDING_PREVIEW_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

interface RecordingPreviewUpload {
  success: boolean;
  url?: string;
  storagePath?: string;
  error?: string;
}

/**
 * Upload a public preview asset for a recording listing. `kind` picks the
 * validation profile (clip = short video, thumb = poster image).
 *
 * Object names are DETERMINISTIC per recording (`<recordingId>/clip.<ext>`,
 * `<recordingId>/thumb.<ext>`) and the upload upserts: a re-upload overwrites
 * the previous bytes in place, so no orphaned public objects accumulate. (A
 * random per-upload filename here would strand the old clip forever — the
 * bucket is public and nothing sweeps it.)
 */
const uploadRecordingPreviewAsset = async (
  recordingId: string,
  kind: "clip" | "thumb",
  file: File,
): Promise<RecordingPreviewUpload> => {
  const isClip = kind === "clip";
  const ext = isClip
    ? file.type === "video/webm"
      ? "webm"
      : "mp4"
    : file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : "jpg";
  return uploadAsset({
    bucket: RECORDING_PREVIEWS_BUCKET,
    folder: recordingId,
    file,
    maxBytes: isClip
      ? RECORDING_PREVIEW_MAX_BYTES
      : RECORDING_PREVIEW_THUMB_MAX_BYTES,
    allowedMime: isClip
      ? ALLOWED_RECORDING_PREVIEW_VIDEO_TYPES
      : ALLOWED_RECORDING_PREVIEW_IMAGE_TYPES,
    access: "public",
    upsert: true,
    replaceFolder: false,
    cacheControl: "31536000",
    // Fixed stem ⇒ upsert overwrites; extension follows the declared MIME.
    fileNameFor: () => `${kind}.${ext}`,
    ensureBucket: { public: true },
    errors: {
      bucketNotReady: `Preview storage bucket '${RECORDING_PREVIEWS_BUCKET}' not found.`,
      size: isClip
        ? "Preview clip exceeds the 50MB limit"
        : "Thumbnail exceeds the 5MB limit",
      type: isClip
        ? (t) => `Unsupported preview format "${t}". Use MP4 or WebM.`
        : (t) => `Unsupported thumbnail format "${t}". Use JPG, PNG, or WebP.`,
    },
  });
};

/** Best-effort removal of a recording's whole public-preview folder. */
const deleteRecordingPreviewAssets = async (
  recordingId: string,
): Promise<void> => {
  try {
    await deleteAssetFolder(RECORDING_PREVIEWS_BUCKET, recordingId);
  } catch (error) {
    console.error("Failed to delete recording preview assets:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "storage" } },
    );
  }
};

export default supabase;
export {
  generateStorageFileName,
  fetchImagesFromSupabaseStorage,
  uploadAppointmentDocument,
  deleteAppointmentDocument,
  // Plan materials
  uploadPlanMaterial,
  deletePlanMaterial,
  // Consultant documents (response documents)
  uploadConsultantDocument,
  // Support ticket attachments
  uploadSupportTicketAttachment,
  deleteSupportTicketAttachment,
  // Plan images
  uploadPlanImage,
  deletePlanImage,
  // Profile display image (square image for Explore Experts)
  uploadProfileDisplayImage,
  deleteProfileDisplayImage,
  ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES,
  PROFILE_DISPLAY_IMAGE_MAX_SIZE,
  // Profile avatar image (general avatar for Navbar/session)
  uploadProfileImage,
  deleteProfileImage,
  ALLOWED_PROFILE_IMAGE_TYPES,
  PROFILE_IMAGE_MAX_SIZE,
  // Organization branding (logo + banner)
  uploadOrganizationLogo,
  uploadOrganizationBanner,
  deleteOrganizationLogo,
  deleteOrganizationBanner,
  ALLOWED_ORG_BRANDING_IMAGE_TYPES,
  ORG_LOGO_MAX_SIZE,
  ORG_BANNER_MAX_SIZE,
  // Generic upload/delete
  uploadToSupabase,
  deleteFromSupabase,
  // Recording marketplace previews (#366, public bucket)
  uploadRecordingPreviewAsset,
  deleteRecordingPreviewAssets,
  RECORDING_PREVIEWS_BUCKET,
  // Utility functions
  ensureBucketExists,
  getManualBucketInstructions,
  supabaseAdmin,
};
