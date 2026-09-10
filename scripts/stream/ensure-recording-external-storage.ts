/**
 * Register a bucket with Stream as recording external storage, and prove it works.
 *
 * This is the script that settles #1314. Stream's docs list only S3, GCS and
 * Azure, and getstream/protocol#371 reads as though S3-compatible third parties
 * are an unimplemented feature request — but `s3_custom_endpoint_url` is in the
 * public OpenAPI spec, so any S3-compatible vendor should work. "Should" is not
 * "does": `/video/external_storage/{name}/check` uploads a real test object and
 * is the only honest answer.
 *
 * Two vendors are worth checking, for opposite reasons:
 *
 *   r2       — the recommendation. Supports both virtual-hosted and path-style
 *              addressing, so the one real compatibility risk does not apply.
 *   supabase — the incumbent, and a genuine coin-flip. It is path-style ONLY
 *              (its TLS wildcard `*.storage.supabase.co` matches one label, so a
 *              bucket subdomain cannot be certified) AND its endpoint carries a
 *              `/storage/v1/s3` path prefix that some S3 clients drop when
 *              signing SigV4. If `check` passes, staying on one vendor is live
 *              again and worth re-deciding on cost alone.
 *
 * Credentials come from the environment and are never echoed. A custom endpoint
 * forces static key/secret — IAM-role auth is AWS-only — so whatever is passed
 * here is a long-lived credential Stream will hold with no documented rotation
 * path. Scope it to the one bucket.
 *
 * Usage:
 *   npx tsx scripts/stream/ensure-recording-external-storage.ts --provider r2
 *   npx tsx scripts/stream/ensure-recording-external-storage.ts --provider r2 --apply
 *   npx tsx scripts/stream/ensure-recording-external-storage.ts --provider r2 --check
 *   npx tsx scripts/stream/ensure-recording-external-storage.ts --list
 *   npx tsx scripts/stream/ensure-recording-external-storage.ts --provider r2 --delete
 *
 * Env, per provider:
 *   R2_BUCKET R2_S3_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
 *   SUPABASE_S3_BUCKET SUPABASE_S3_ENDPOINT SUPABASE_S3_REGION
 *     SUPABASE_S3_ACCESS_KEY_ID SUPABASE_S3_SECRET_ACCESS_KEY
 */

import "dotenv/config";
import { getStreamVideoClient, isStreamConfigured } from "@/lib/stream-client";
import { RECORDING_MAX_OBJECT_BYTES } from "@/lib/stream/recording-storage";

/** Where Stream writes inside the bucket. Keeps recordings out of the root. */
const PATH_PREFIX = "recordings/";

interface Provider {
  /** The `name` Stream knows this config by, and what `startRecording` passes. */
  storageName: string;
  bucket: string | undefined;
  endpoint: string | undefined;
  /** R2 ignores region but the field is required; Supabase wants the real one. */
  region: string;
  accessKeyId: string | undefined;
  secret: string | undefined;
  /** Why this one is worth checking, printed so a dry run explains itself. */
  note: string;
}

function providers(): Record<string, Provider> {
  return {
    r2: {
      storageName: "r2-recordings",
      bucket: process.env.R2_BUCKET,
      endpoint: process.env.R2_S3_ENDPOINT,
      region: "auto",
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secret: process.env.R2_SECRET_ACCESS_KEY,
      note: "dual addressing support — the low-risk option",
    },
    supabase: {
      storageName: "supabase-recordings",
      bucket: process.env.SUPABASE_S3_BUCKET ?? "recordings",
      endpoint: process.env.SUPABASE_S3_ENDPOINT,
      region: process.env.SUPABASE_S3_REGION ?? "ap-south-1",
      accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID,
      secret: process.env.SUPABASE_S3_SECRET_ACCESS_KEY,
      note: "path-style only, and a /storage/v1/s3 prefix under SigV4 — the coin-flip",
    },
  };
}

/** Never print a secret; the length is enough to tell "set" from "typo". */
function redact(value: string | undefined): string {
  return value ? `set (${value.length} chars)` : "MISSING";
}

function missingEnv(p: Provider): string[] {
  const missing: string[] = [];
  if (!p.bucket) missing.push("bucket");
  if (!p.endpoint) missing.push("endpoint");
  if (!p.accessKeyId) missing.push("access key id");
  if (!p.secret) missing.push("secret");
  return missing;
}

interface Options {
  provider: string | null;
  apply: boolean;
  check: boolean;
  list: boolean;
  remove: boolean;
}

function parseArgs(argv: string[]): Options {
  const at = argv.indexOf("--provider");
  return {
    provider: at >= 0 ? (argv[at + 1] ?? null) : null,
    apply: argv.includes("--apply"),
    check: argv.includes("--check"),
    list: argv.includes("--list"),
    remove: argv.includes("--delete"),
  };
}

export async function ensureRecordingExternalStorage(
  opts: Options,
): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }
  const client = getStreamVideoClient();

  if (opts.list) {
    const res = await client.listExternalStorage();
    const names = Object.keys(res.external_storages ?? {});
    console.log(
      names.length
        ? `configured external storage: ${names.join(", ")}`
        : "no external storage configured on this app",
    );
    for (const [name, cfg] of Object.entries(res.external_storages ?? {})) {
      console.log(`  ${name}  type=${cfg.type}  bucket=${cfg.bucket}  path=${cfg.path}`);
    }
    return 0;
  }

  const all = providers();
  const provider = opts.provider ? all[opts.provider] : undefined;
  if (!provider) {
    console.error(
      `Pass --provider <${Object.keys(all).join("|")}>, or --list.\n`,
    );
    return 1;
  }

  if (opts.remove) {
    await client.deleteExternalStorage({ name: provider.storageName });
    console.log(`deleted external storage "${provider.storageName}"`);
    return 0;
  }

  console.log(`Provider: ${opts.provider}  (${provider.note})`);
  console.log(`  storage name : ${provider.storageName}`);
  console.log(`  bucket       : ${provider.bucket ?? "MISSING"}`);
  console.log(`  endpoint     : ${provider.endpoint ?? "MISSING"}`);
  console.log(`  region       : ${provider.region}`);
  console.log(`  access key   : ${redact(provider.accessKeyId)}`);
  console.log(`  secret       : ${redact(provider.secret)}`);
  console.log(`  path prefix  : ${PATH_PREFIX}`);

  // `check` re-uses whatever is already registered, so it needs no credentials.
  if (opts.check && !opts.apply) return runCheck(client, provider);

  const missing = missingEnv(provider);
  if (missing.length > 0) {
    console.error(
      `\n🛑 Cannot register — missing ${missing.join(", ")}.` +
        `\n   Set the env vars listed in this file's header, then re-run.\n`,
    );
    return 1;
  }

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to register this with Stream)");
    return 0;
  }

  await client.createExternalStorage({
    name: provider.storageName,
    storage_type: "s3",
    bucket: provider.bucket!,
    path: PATH_PREFIX,
    aws_s3: {
      s3_region: provider.region,
      s3_custom_endpoint_url: provider.endpoint!,
      s3_api_key: provider.accessKeyId!,
      s3_secret: provider.secret!,
    },
  });
  console.log(`\n✅ registered "${provider.storageName}"`);

  return runCheck(client, provider);
}

/**
 * The only answer that counts. Stream uploads a real object to the bucket, so a
 * pass means credentials, endpoint, addressing style and permissions all work
 * together — none of which can be inferred from the config being accepted.
 */
async function runCheck(
  client: ReturnType<typeof getStreamVideoClient>,
  provider: Provider,
): Promise<number> {
  console.log(`\nChecking "${provider.storageName}" — Stream uploads a test file…`);
  try {
    await client.checkExternalStorage({ name: provider.storageName });
    console.log(
      `✅ CHECK PASSED — Stream can write to this bucket directly.` +
        `\n   Recording can be pointed at it with` +
        ` StartRecordingRequest.recording_external_storage = "${provider.storageName}",` +
        `\n   and the download-then-reupload transfer pipeline becomes redundant.\n`,
    );
    return 0;
  } catch (error) {
    console.error(
      `❌ CHECK FAILED — ${(error as Error).message}` +
        `\n   Stream cannot write here. Recordings would have to keep going through` +
        `\n   the transfer pipeline, capped at ` +
        `${Math.round(RECORDING_MAX_OBJECT_BYTES / 1024 / 1024)}MB.\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  ensureRecordingExternalStorage(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
