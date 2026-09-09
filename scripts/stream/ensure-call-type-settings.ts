/**
 * Turn off the `default` call type's billable and unused capabilities, and stop
 * a thirty-second empty room from ending a live session.
 *
 * Six changes, none of which need a deploy:
 *
 *   audio.noise_cancellation.mode  auto-on -> available
 *     Krisp bills per participant-minute. `auto-on` means the moment
 *     `@stream-io/audio-filters-web` ships, every call on the platform starts
 *     billing for it — registering the instance and switching on the charge are
 *     the same act (#1158). `available` keeps the capability and makes enabling
 *     it a deliberate client-side decision.
 *
 *   frame_recording.mode           available -> disabled
 *   individual_recording.mode      available -> disabled
 *   raw_recording.mode             available -> disabled
 *   ingress.enabled                true      -> false
 *     Stream ships permissive call-type defaults, so "we have not built it" and
 *     "it cannot be started" are different statements (#1160). Both are billable
 *     and entirely unused. `start-broadcast-call` was never revoked either, which
 *     is how a participant with the SDK could have livestreamed a private
 *     consultation.
 *
 *   session.inactivity_timeout_seconds  30 -> 900
 *     Stream fires `call.session_ended` this long after the LAST participant
 *     leaves. At thirty seconds, one party stepping out mid-appointment ended the
 *     session: both sides locked out, the slot marked complete, and in one
 *     direction an automatic full refund against a consultant who was three
 *     minutes late. #1277 fixed the consequences in code; this removes the event
 *     from the hot path entirely. The two fail independently, which is the point
 *     of doing both.
 *
 * NOT changed here, deliberately:
 *   limits.max_duration_seconds stays null. It counts from the first
 *     participant joining, not from `starts_at`, so setting it to the booked
 *     length would hard-terminate a session up to fifteen minutes early when a
 *     consultant joins to check their camera (#1144).
 *   backstage stays disabled — that is #1070's decision, not this script's.
 *   recording.layout stays `spotlight`. Switching to `grid` would change every
 *     recording, including webinars, for a 1:1 benefit that has not been shown.
 *
 * ⚠️ The dangerous part is not any of the values above.
 *
 * Stream does not document whether `updateCallType` merges or replaces the
 * top-level fields it is not given, and the chat twin (`channel.update()`) is a
 * FULL REPLACE. `ensure-call-type-grants.ts` raised the same question from the
 * other side and left it open. If a write carrying only `settings` replaces the
 * document, `grants` goes with it — and `user`, `guest` and `call_member` all
 * currently hold `join-call`, so losing the grants map is a total video outage.
 *
 * So this runs a NO-OP PROBE first: it writes the settings block back with the
 * values it already has, re-reads, and compares grants and notification_settings
 * against the pre-image. Only if nothing moved does it make the real change. A
 * full pre-image is written to disk before either write, so a wipe is
 * reconstructable rather than merely detectable.
 *
 * The probe answered it on 2026-08-30: top-level `settings` fields MERGE, and a
 * settings write leaves `grants` and `notification_settings` untouched. The
 * probe stays anyway — it costs one request and it is the only thing standing
 * between a future settings change and a silent grants wipe if Stream's
 * behaviour ever changes.
 *
 * Sub-objects are a different matter: they are validated as a whole, so `audio`
 * without `default_device` and `frame_recording` without a valid
 * `capture_interval_in_seconds` are both rejected. Each block is therefore
 * rebuilt from the live read rather than written from a literal.
 *
 *   npx tsx scripts/stream/ensure-call-type-settings.ts
 *   npx tsx scripts/stream/ensure-call-type-settings.ts --apply
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import type { CallSettingsResponse } from "@stream-io/node-sdk";
import { getStreamVideoClient } from "@/lib/stream-client";
import { canonical } from "@/lib/stream/config-fingerprint";
// The same constant the app itself resolves calls against, not an env var —
// `ensure-call-type-grants.ts` imports it from here too. Reading a separate
// env var would let the grants script and this one harden DIFFERENT call
// types, which is the divergence class this subsystem keeps repeating.
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";

const CALL_TYPE = STREAM_CALL_TYPE;
const BACKUP_DIR = ".stream-backups";

const TARGET = {
  noiseCancellation: "available",
  frameRecording: "disabled",
  individualRecording: "disabled",
  rawRecording: "disabled",
  ingressEnabled: false,
  inactivityTimeoutSeconds: 900,
} as const;

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

function describe(settings: CallSettingsResponse): string[] {
  return [
    `audio.noise_cancellation.mode      = ${settings.audio?.noise_cancellation?.mode}`,
    `frame_recording.mode               = ${settings.frame_recording?.mode}`,
    `individual_recording.mode          = ${settings.individual_recording?.mode}`,
    `raw_recording.mode                 = ${settings.raw_recording?.mode}`,
    `ingress.enabled                    = ${settings.ingress?.enabled}`,
    `session.inactivity_timeout_seconds = ${settings.session?.inactivity_timeout_seconds}`,
  ];
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const client = getStreamVideoClient();

  const before = await client.video.getCallType({ name: CALL_TYPE });
  const settingsBefore = before.settings;
  const grantsBefore = canonical(before.grants);
  const notificationsBefore = canonical(before.notification_settings);
  const settingsCanonBefore = canonical(before.settings);

  console.log(`Call type "${CALL_TYPE}" — current:`);
  for (const line of describe(settingsBefore)) console.log(`  ${line}`);

  const changes: string[] = [];
  if (
    settingsBefore.audio?.noise_cancellation?.mode !== TARGET.noiseCancellation
  )
    changes.push(
      `audio.noise_cancellation.mode: ${settingsBefore.audio?.noise_cancellation?.mode} -> ${TARGET.noiseCancellation}`,
    );
  if (settingsBefore.frame_recording?.mode !== TARGET.frameRecording)
    changes.push(
      `frame_recording.mode: ${settingsBefore.frame_recording?.mode} -> ${TARGET.frameRecording}`,
    );
  if (settingsBefore.individual_recording?.mode !== TARGET.individualRecording)
    changes.push(
      `individual_recording.mode: ${settingsBefore.individual_recording?.mode} -> ${TARGET.individualRecording}`,
    );
  if (settingsBefore.raw_recording?.mode !== TARGET.rawRecording)
    changes.push(
      `raw_recording.mode: ${settingsBefore.raw_recording?.mode} -> ${TARGET.rawRecording}`,
    );
  if (settingsBefore.ingress?.enabled !== TARGET.ingressEnabled)
    changes.push(
      `ingress.enabled: ${settingsBefore.ingress?.enabled} -> ${TARGET.ingressEnabled}`,
    );
  if (
    settingsBefore.session?.inactivity_timeout_seconds !==
    TARGET.inactivityTimeoutSeconds
  )
    changes.push(
      `session.inactivity_timeout_seconds: ${settingsBefore.session?.inactivity_timeout_seconds} -> ${TARGET.inactivityTimeoutSeconds}`,
    );

  if (changes.length === 0) {
    console.log("\n✅ already at the desired settings — no change");
    return 0;
  }

  console.log("\nPending changes:");
  for (const c of changes) console.log(`  ${c}`);

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  // `:` from toISOString is an illegal filename character on Windows, where
  // writeFileSync would throw before the probe had a chance to run.
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const preImagePath = `${BACKUP_DIR}/call-type-${CALL_TYPE}.${stamp}.json`;
  writeFileSync(
    preImagePath,
    JSON.stringify(
      {
        settings: before.settings,
        grants: before.grants,
        notification_settings: before.notification_settings,
      },
      null,
      2,
    ),
  );
  console.log(`\nPre-image written to ${preImagePath}`);

  // Probe: write the values back unchanged, then check that nothing ELSE moved.
  // If `updateCallType` replaces rather than merges, this is where we find out —
  // with no semantic change of our own riding on it.
  console.log("Probing merge-vs-replace with a no-op write...");
  await client.video.updateCallType({
    name: CALL_TYPE,
    settings: {
      session: {
        // Echo the current value back — the probe must be semantically a no-op.
        inactivity_timeout_seconds:
          settingsBefore.session.inactivity_timeout_seconds,
      },
    },
  });

  const probe = await client.video.getCallType({ name: CALL_TYPE });
  if (canonical(probe.grants) !== grantsBefore) {
    console.error(
      `\n🚨 GRANTS CHANGED after a no-op settings write. updateCallType REPLACES.` +
        `\n   Every role's permissions may be gone — this is a total video outage.` +
        `\n   Restore from: ${preImagePath}`,
    );
    return 1;
  }
  if (canonical(probe.settings) !== settingsCanonBefore) {
    console.error(
      `\n🚨 OTHER SETTINGS CHANGED after a no-op write — a partial settings payload` +
        `\n   does not merge. Do not proceed. Restore from: ${preImagePath}`,
    );
    return 1;
  }
  if (canonical(probe.notification_settings) !== notificationsBefore) {
    console.error(
      `\n🚨 notification_settings changed after a no-op write.` +
        `\n   Restore from: ${preImagePath}`,
    );
    return 1;
  }
  console.log(
    "  ✅ probe clean — partial settings writes merge, grants untouched",
  );

  // Sub-objects must be sent COMPLETE even though top-level fields merge: Stream
  // rejects `audio` without `default_device`, and `frame_recording` without a
  // valid `capture_interval_in_seconds`. So each block is rebuilt from what was
  // just read, with only the one field we mean to change substituted — never
  // hardcoded, or this script would quietly reset whatever it omitted.
  await client.video.updateCallType({
    name: CALL_TYPE,
    settings: {
      audio: {
        ...settingsBefore.audio,
        noise_cancellation: { mode: TARGET.noiseCancellation },
      },
      frame_recording: {
        ...settingsBefore.frame_recording,
        mode: TARGET.frameRecording,
      },
      individual_recording: { mode: TARGET.individualRecording },
      raw_recording: { mode: TARGET.rawRecording },
      ingress: { enabled: TARGET.ingressEnabled },
      session: {
        inactivity_timeout_seconds: TARGET.inactivityTimeoutSeconds,
      },
    } as never,
  });

  const after = await client.video.getCallType({ name: CALL_TYPE });
  const settingsAfter = after.settings;

  console.log("\nAfter:");
  for (const line of describe(settingsAfter)) console.log(`  ${line}`);

  if (canonical(after.grants) !== grantsBefore) {
    console.error(
      `\n🚨 GRANTS CHANGED. Restore immediately from ${preImagePath}`,
    );
    return 1;
  }
  console.log("\n✅ grants unchanged");

  const stillWrong = [
    settingsAfter.audio?.noise_cancellation?.mode !==
      TARGET.noiseCancellation && "noise_cancellation",
    settingsAfter.frame_recording?.mode !== TARGET.frameRecording &&
      "frame_recording",
    settingsAfter.individual_recording?.mode !== TARGET.individualRecording &&
      "individual_recording",
    settingsAfter.raw_recording?.mode !== TARGET.rawRecording &&
      "raw_recording",
    settingsAfter.ingress?.enabled !== TARGET.ingressEnabled && "ingress",
    settingsAfter.session?.inactivity_timeout_seconds !==
      TARGET.inactivityTimeoutSeconds && "inactivity_timeout_seconds",
  ].filter(Boolean);

  if (stillWrong.length > 0) {
    console.error(
      `\n⚠️ Stream did not store: ${stillWrong.join(", ")}. Investigate before trusting this run.`,
    );
    return 1;
  }

  console.log("✅ all settings stored as intended");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
