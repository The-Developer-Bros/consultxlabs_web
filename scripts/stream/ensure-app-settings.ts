/**
 * Close the guest door, and pin webhook payload compression off.
 *
 * Two APP-level settings. Everything else this subsystem hardens lives on the
 * `default` call type (`ensure-call-type-grants.ts`, `ensure-call-type-settings.ts`)
 * or on the unused call types (`harden-unused-call-types.ts`); these two do not,
 * so they need their own script rather than a fourth thing bolted onto one of
 * those.
 *
 *   guest_user_creation_disabled  false -> true
 *     Read live on 2026-09-01: `false`. Guest sessions are creatable from the
 *     browser with nothing but the public API key, which we ship as
 *     NEXT_PUBLIC_STREAM_API_KEY, and the `guest` role holds `join-call` on the
 *     `default` call type today. #1134 decided against guest access and nothing
 *     in the tree creates a guest, so this is an unused capability with the door
 *     left open. `ensure-call-type-grants.ts` strips the grant; this stops the
 *     accounts being mintable at all. Two independent locks, because the grants
 *     script has been wrong about which roles exist before.
 *
 *   enable_hook_payload_compression -> false
 *     Stream gzips webhook bodies when this is on, and the HMAC must be verified
 *     against the UNCOMPRESSED bytes. Applications created after 7 May 2026 have
 *     it on by default; ours was created 2026-01-21, and the key is absent from
 *     the live app response, so it is off. Pinning it makes that explicit rather
 *     than inherited, so a future Stream-side retrofit of the default cannot
 *     silently start failing every signature check.
 *
 *     ⚠️ This field is WRITE-ONLY. It is on `UpdateAppRequest` and NOT on
 *     `AppResponseFields`, so it cannot be read back, cannot be idempotency-
 *     checked, and cannot be verified after the write. This script therefore
 *     never claims it succeeded — it reports it as sent, not as confirmed. It
 *     rides along on the guest write rather than taking a write of its own,
 *     because the blast radius below is per-request, not per-field.
 *
 *     The real defence is in the code: `app/api/stream/webhooks/route.ts`
 *     handles a gzipped body whatever this setting says. This is belt and
 *     braces.
 *
 * ⚠️ The dangerous part is not either value.
 *
 * `updateApp` takes a partial, but Stream does not document whether the fields
 * it is NOT given are merged or replaced, and this app's `event_hooks` array is
 * the single most expensive thing in the account to lose: it is one hook,
 * carrying the nine video event types the whole webhook pipeline depends on. A
 * replace would silently unsubscribe us and the symptom would be indistinguishable
 * from the 2026-08-13 outage, where the pipeline had never processed one event.
 *
 * `updateCallType` was shown to MERGE by probing it (`ensure-call-type-settings.ts`,
 * 2026-08-30). That says nothing about `updateApp` — a different endpoint on a
 * different document — and the chat twin `channel.update()` is a full replace.
 *
 * So the same protocol: write a pre-image to disk, send a NO-OP probe that
 * rewrites one field with the value it already has, re-read, and compare
 * everything that matters. Only if nothing moved does the real write happen.
 *
 *   npx tsx scripts/stream/ensure-app-settings.ts
 *   npx tsx scripts/stream/ensure-app-settings.ts --apply
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import type { AppResponseFields } from "@stream-io/node-sdk";
import { getStreamVideoClient, isStreamConfigured } from "@/lib/stream-client";
import { canonical, diffFingerprints } from "@/lib/stream/config-fingerprint";

const BACKUP_DIR = ".stream-backups";

const TARGET = {
  guestUserCreationDisabled: true,
  enableHookPayloadCompression: false,
} as const;

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

/**
 * The fields a wipe would take with it, in the order they would hurt.
 *
 * `event_hooks` first: it is the live webhook subscription. `webhook_events` and
 * `webhook_url` are the v1 mechanism, still populated alongside `use_hook_v2`.
 * The rest are configuration nobody would notice losing until it mattered —
 * `revoke_tokens_issued_before` in particular, because losing a revocation
 * silently un-bans every token it covered.
 */
function fingerprint(app: AppResponseFields): Record<string, string> {
  return {
    event_hooks: canonical(app.event_hooks),
    webhook_events: canonical(app.webhook_events),
    webhook_url: canonical(app.webhook_url),
    permission_version: canonical(app.permission_version),
    revoke_tokens_issued_before: canonical(app.revoke_tokens_issued_before),
    multi_tenant_enabled: canonical(app.multi_tenant_enabled),
    moderation_enabled: canonical(app.moderation_enabled),
    cdn_expiration_seconds: canonical(app.cdn_expiration_seconds),
    geofences: canonical(app.geofences),
    file_upload_config: canonical(app.file_upload_config),
    image_upload_config: canonical(app.image_upload_config),
    push_notifications: canonical(app.push_notifications),
  };
}

export async function ensureAppSettings(opts: Options): Promise<number> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();
  const before = (await client.getApp()).app;

  console.log("App settings — current:");
  console.log(
    `  guest_user_creation_disabled    = ${before.guest_user_creation_disabled}`,
  );
  console.log(
    `  enable_hook_payload_compression = (write-only, not readable back)`,
  );
  console.log(
    `  event_hooks                     = ${before.event_hooks?.length ?? 0} hook(s)`,
  );

  if (
    before.guest_user_creation_disabled === TARGET.guestUserCreationDisabled
  ) {
    // The compression pin rides on this write and so is not re-sent here. That
    // is deliberate: it cannot be read back, so re-sending it on every run would
    // mean touching the document that holds `event_hooks` for a change nobody
    // can confirm. The code path handles compression either way.
    console.log(
      "\n✅ guest_user_creation_disabled is already true — no change, and no write.",
    );
    return 0;
  }

  console.log("\nPending changes:");
  console.log(
    `  guest_user_creation_disabled: ${before.guest_user_creation_disabled} -> ${TARGET.guestUserCreationDisabled}`,
  );
  console.log(
    `  enable_hook_payload_compression: (unknown) -> ${TARGET.enableHookPayloadCompression}  [sent, unverifiable]`,
  );

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  // `:` from toISOString is an illegal filename character on Windows, where
  // writeFileSync would throw before the probe had a chance to run.
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const preImagePath = `${BACKUP_DIR}/app-settings.${stamp}.json`;
  writeFileSync(preImagePath, JSON.stringify(before, null, 2));
  console.log(`\nPre-image written to ${preImagePath}`);

  // --- No-op probe -------------------------------------------------------
  // Rewrite one field with the value it already has. If `updateApp` replaces
  // rather than merges, this destroys the same things the real write would —
  // but we have not yet made the change we came for, so the pre-image restores
  // a state that is otherwise identical to the one we started in.
  console.log("Probing whether updateApp merges or replaces…");
  const fpBefore = fingerprint(before);

  // The probe is only a probe if it actually sends a field.
  //
  // `AppResponseFields` types `moderation_enabled` as a required boolean and
  // the live app returns `true` — but the type describes a contract, not a
  // runtime guarantee, and this subsystem has been burned by trusting the
  // declared shape over the live one before. If the field were ever absent,
  // `JSON.stringify({ moderation_enabled: undefined })` is `{}`: the request
  // would carry nothing, Stream would change nothing, the fingerprint would
  // match, and the probe would report CLEAN having tested nothing at all — then
  // license the real write against the document holding `event_hooks`.
  //
  // A probe that can silently pass is worse than no probe, so an absent field
  // is a refusal rather than a warning.
  if (typeof before.moderation_enabled !== "boolean") {
    console.error(
      `\n🛑 Refusing to apply — cannot build a meaningful no-op probe.` +
        `\n   \`moderation_enabled\` read back as ${String(before.moderation_enabled)},` +
        `\n   so the probe request would serialise to {} and prove nothing about` +
        `\n   whether updateApp merges or replaces. Nothing was written.` +
        `\n   Pre-image: ${preImagePath}\n`,
    );
    return 1;
  }

  await client.updateApp({ moderation_enabled: before.moderation_enabled });
  const probed = (await client.getApp()).app;
  const probeDrift = diffFingerprints(fpBefore, fingerprint(probed));

  if (probeDrift.length > 0) {
    console.error(
      `\n🚨 updateApp REPLACED configuration it was not given.` +
        `\n   Fields that changed on a no-op write: ${probeDrift.join(", ")}` +
        `\n\n   Nothing was applied. Restore from the pre-image at:` +
        `\n     ${preImagePath}` +
        `\n\n   If \`event_hooks\` is in that list the webhook pipeline is DOWN.` +
        `\n   Repair it with: npx tsx scripts/stream/ensure-webhook-subscription.ts --apply\n`,
    );
    return 1;
  }
  console.log("  probe clean — top-level fields merge.");

  // --- Real write --------------------------------------------------------
  await client.updateApp({
    guest_user_creation_disabled: TARGET.guestUserCreationDisabled,
    enable_hook_payload_compression: TARGET.enableHookPayloadCompression,
  });

  const after = (await client.getApp()).app;
  const drift = diffFingerprints(fpBefore, fingerprint(after));

  if (drift.length > 0) {
    console.error(
      `\n🚨 The real write changed configuration it was not given: ${drift.join(", ")}` +
        `\n   Restore from ${preImagePath}\n`,
    );
    return 1;
  }

  if (after.guest_user_creation_disabled !== TARGET.guestUserCreationDisabled) {
    console.error(
      `\n🚨 Stream did not store guest_user_creation_disabled — it reads back as` +
        `\n   ${after.guest_user_creation_disabled}. Guest accounts are still mintable.\n`,
    );
    return 1;
  }

  console.log(
    "\n✅ guest_user_creation_disabled = true, verified against Stream.",
  );
  console.log(
    "ℹ️  enable_hook_payload_compression = false was sent but CANNOT be verified —" +
      "\n   it is write-only. Treat the route's own gzip handling as the guarantee.",
  );
  return 0;
}

if (require.main === module) {
  ensureAppSettings(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
