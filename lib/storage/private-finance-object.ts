/**
 * Private finance-document storage — upload, existence check and signed URL.
 *
 * #1354 — these three helpers started life inside `lib/pdf/storage.ts`, which
 * gets its client from `lib/supabase.ts`. That module opens with
 * `import "server-only"`, a marker package whose main entry does nothing but
 * `throw`, so any scheduled job whose import graph reaches it dies during
 * module evaluation before a line of its own code runs (#1270). The quarterly
 * TDS return export is exactly such a job: it writes its CSV from a bare
 * `tsx jobs/...` process.
 *
 * So the storage primitives live here instead, sourcing the admin client from
 * the marker-free `lib/supabase-storage-core.ts`. `lib/pdf/storage.ts`
 * re-exports every name below unchanged, so the request-scoped invoice callers
 * keep their `server-only` guard and no existing call site had to move.
 *
 * Bucket: `org-invoices` (private, and self-provisioning — see
 * `ensurePrivateFinanceBucket`). It holds the org invoice PDFs under
 * `<orgId>/<invoiceId>.pdf` and the quarterly TDS return CSVs under
 * `compliance/tds/`.
 */

import { supabaseAdmin } from "@/lib/supabase-storage-core";

const BUCKET = "org-invoices";

/**
 * Everything written here is a rendered document — an invoice PDF or a
 * quarterly return CSV — so single-digit megabytes is the realistic size and
 * 25MB is generous headroom. It also sits under the 50MB per-object ceiling the
 * Supabase FREE plan clamps every bucket to (#1314), so this is the limit
 * actually in force rather than a number the plan silently overrides.
 *
 * No MIME allow-list on purpose: the bucket already carries two unrelated
 * content types, and a stale list rejects an upload with a 415 that reads like
 * a credentials failure.
 */
const BUCKET_FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

/**
 * #1354 — the bucket had never been created on the live project. The E2E run of
 * the TDS return export on 2026-09-04 died inside `uploadPrivateFinanceObject`
 * with `Bucket not found`, and the org invoice PDF route had been latently
 * broken the same way since the name was introduced: the comment here used to
 * say "must exist, create it via the Supabase dashboard" and nobody ever did.
 *
 * Deliberately not `ensureBucketExists` from the same core module. That helper
 * probes with the ANON client via an object list, which cannot answer reliably
 * for a bucket that is private by design, and it reports failure as `false` —
 * so a caller would fail later at the upload with the same opaque error.
 * `getBucket` on the admin client is a management-API read and answers directly.
 */
let bucketReady: Promise<void> | null = null;

async function provisionPrivateFinanceBucket(): Promise<void> {
  const client = requireAdminClient();
  if ((await client.storage.getBucket(BUCKET)).data) return;

  const { error } = await client.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: BUCKET_FILE_SIZE_LIMIT_BYTES,
  });
  if (!error) return;

  // Re-probe instead of matching the message: a concurrent writer that won the
  // race leaves us exactly the bucket we wanted, and the wording of Supabase's
  // duplicate error is not part of its contract.
  if (!(await client.storage.getBucket(BUCKET)).data) {
    throw new Error(`Failed to create bucket ${BUCKET}: ${error.message}`);
  }
}

/**
 * Create the private finance bucket when it is missing. Idempotent, and
 * memoized per process so the second document of a run skips the round trip. A
 * rejection is deliberately NOT memoized: caching it would pin a transient
 * Supabase failure for the whole life of the process.
 */
export function ensurePrivateFinanceBucket(): Promise<void> {
  bucketReady ??= provisionPrivateFinanceBucket().catch((error: unknown) => {
    bucketReady = null;
    throw error;
  });
  return bucketReady;
}

function requireAdminClient() {
  if (!supabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required to read or write private finance documents. Add it to .env.local; see lib/supabase-storage-core.ts for the warning printed at startup.",
    );
  }
  return supabaseAdmin;
}

/**
 * Upload (or overwrite) an object in the private finance bucket.
 *
 * `upsert` is always on: every caller regenerates a document whose identity is
 * its path, so a re-run must replace rather than fail on conflict.
 */
export async function uploadPrivateFinanceObject(args: {
  storagePath: string;
  body: Buffer;
  contentType: string;
  /** Browser cache seconds; the bucket is private so this only affects the signed hop. */
  cacheControl?: string;
}): Promise<void> {
  await ensurePrivateFinanceBucket();

  const { error } = await requireAdminClient()
    .storage.from(BUCKET)
    .upload(args.storagePath, args.body, {
      contentType: args.contentType,
      cacheControl: args.cacheControl ?? "0",
      upsert: true,
    });

  if (error) {
    throw new Error(
      `Failed to upload ${args.storagePath} to ${BUCKET}: ${error.message}`,
    );
  }
}

/** True when the object exists; used to answer 404 before minting a URL. */
export async function privateFinanceObjectExists(
  storagePath: string,
): Promise<boolean> {
  const slash = storagePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : storagePath.slice(0, slash);
  const name = storagePath.slice(slash + 1);
  const { data, error } = await requireAdminClient()
    .storage.from(BUCKET)
    .list(dir, { search: name });
  if (error) {
    throw new Error(
      `Failed to stat ${storagePath} in ${BUCKET}: ${error.message}`,
    );
  }
  // `search` is a prefix match, so confirm the exact name.
  return (data ?? []).some((o) => o.name === name);
}

export async function createPrivateFinanceSignedUrl(
  storagePath: string,
  ttlSeconds: number,
): Promise<string> {
  const { data, error } = await requireAdminClient()
    .storage.from(BUCKET)
    .createSignedUrl(storagePath, ttlSeconds);
  if (error || !data?.signedUrl) {
    throw new Error(
      `Failed to create signed URL for ${storagePath}: ${error?.message ?? "unknown"}`,
    );
  }
  return data.signedUrl;
}
