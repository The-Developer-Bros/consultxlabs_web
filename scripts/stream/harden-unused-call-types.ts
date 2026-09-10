/**
 * Make the call types this app does not use unusable by end users.
 *
 * We use exactly one call type: `STREAM_CALL_TYPE`, hardcoded in call-cid.ts.
 * But the Stream app also carries three built-ins — `livestream`, `audio_room`
 * and `development` — and Stream ships them permissive. On `development` the
 * plain `user` role holds thirty-six permissions including `create-call`,
 * `start-recording`, `start-transcription` and `start-broadcasting`; on all
 * three, `guest` and `anonymous` hold `join-call`.
 *
 * That matters because video tokens here are app-wide. `generateVideoToken`
 * mints `generateUserToken` with no `call_cids` claim (deliberately — the
 * call-scoped wrapper was removed as unused), so one token authorises every
 * call type in the app.
 *
 * #1285 closed the exploit route at the webhook boundary: a call minted on a
 * foreign type can no longer collide with a real MeetingSession. This closes
 * the other half — the ability to mint one at all, and with it the billable
 * capabilities (`start-recording`, `start-transcription`, broadcasting) that a
 * participant could otherwise trigger on the account.
 *
 * Deleting the types would be simpler and is not possible: all three are Stream
 * built-ins.
 *
 * Blast radius is zero at the time of writing: `video_query_calls` reports no
 * calls have ever existed on any of the three, verified two ways with a
 * `default` control query.
 *
 *   npx tsx scripts/stream/harden-unused-call-types.ts
 *   npx tsx scripts/stream/harden-unused-call-types.ts --apply
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { getStreamVideoClient } from "@/lib/stream-client";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";

const BACKUP_DIR = ".stream-backups";

/** Every built-in type except the one the app actually resolves calls against. */
export const UNUSED_TYPES = [
  "livestream",
  "audio_room",
  "development",
] as const;

/**
 * Roles an end user can hold. `admin` and `global_admin` are platform staff and
 * keep their grants — an operator needs to be able to inspect and end a call on
 * any type, and staff hold `admin` via `mapRoleToStream`. `global_read_only` is
 * read-only already.
 */
export const END_USER_ROLES = [
  "user",
  "guest",
  "anonymous",
  "speaker",
  "host",
  "call_member",
];

/**
 * Reaching a call at all. Stripping these is what makes the type unusable;
 * everything else a role holds is unreachable without one of them.
 *
 * The `-any-team` variants matter because `call_member` on `development` holds
 * `join-call-any-team`, which is broader than the plain grant.
 */
export const REACH_PERMISSIONS = [
  "create-call",
  "create-call-any-team",
  "join-call",
  "join-call-any-team",
  "join-backstage",
  "join-backstage-any-team",
  "join-ended-call",
  "join-ended-call-any-team",
];

/**
 * Billable, and startable by anyone holding them. Stripped from end-user roles
 * as well, so that a future change re-granting reach does not silently re-arm
 * the meter (#1160).
 */
export const BILLABLE_PERMISSIONS = [
  "start-recording",
  "start-frame-recording",
  "start-transcription",
  "start-closed-captions",
  "start-broadcasting",
];

const STRIP = new Set([...REACH_PERMISSIONS, ...BILLABLE_PERMISSIONS]);

interface Options {
  apply: boolean;
}

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

/**
 * Strip the end-user grants from one call type. Returns whether anything was
 * pending, so the caller can report a dry run honestly.
 */
async function hardenOne(
  client: ReturnType<typeof getStreamVideoClient>,
  typeName: string,
  apply: boolean,
): Promise<{ changed: boolean; failed: boolean }> {
  const before = await client.video.getCallType({ name: typeName });
  const grants: Record<string, string[]> = { ...before.grants };

  const removals: string[] = [];
  for (const role of END_USER_ROLES) {
    const held = grants[role];
    if (!held) continue;
    const kept = held.filter((perm) => !STRIP.has(perm));
    if (kept.length === held.length) continue;
    removals.push(
      `  ${typeName}/${role}: -${held.length - kept.length} (${held
        .filter((p) => STRIP.has(p))
        .join(", ")})`,
    );
    grants[role] = kept;
  }

  if (removals.length === 0) {
    console.log(`✅ ${typeName} — already hardened`);
    return { changed: false, failed: false };
  }

  console.log(`\n${typeName}:`);
  for (const line of removals) console.log(line);
  if (!apply) return { changed: true, failed: false };

  // Only now — a dry run must leave the working tree exactly as it found it,
  // and creating the backup directory before the apply check did not.
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const preImage = `${BACKUP_DIR}/call-type-${typeName}.grants.${stamp}.json`;
  writeFileSync(preImage, JSON.stringify(before.grants, null, 2));
  console.log(`  pre-image → ${preImage}`);

  await client.video.updateCallType({ name: typeName, grants });

  // Read back rather than trusting the write. A grants map is exactly the thing
  // that is catastrophic to get wrong and invisible when you do.
  const after = await client.video.getCallType({ name: typeName });
  const leaked = END_USER_ROLES.flatMap((role) =>
    (after.grants[role] ?? [])
      .filter((perm) => STRIP.has(perm))
      .map((perm) => `${role}:${perm}`),
  );
  if (leaked.length > 0) {
    console.error(
      `  🚨 still granted after the write: ${leaked.join(", ")}` +
        `\n     restore from ${preImage}`,
    );
    return { changed: true, failed: true };
  }
  console.log(`  ✅ verified`);
  return { changed: true, failed: false };
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const client = getStreamVideoClient();

  if ((UNUSED_TYPES as readonly string[]).includes(STREAM_CALL_TYPE)) {
    console.error(
      `\n🚨 ${STREAM_CALL_TYPE} is the type this app USES and is in the strip list.` +
        `\n   Refusing — this would lock every user out of every call.`,
    );
    return 1;
  }

  let changedTypes = 0;

  for (const typeName of UNUSED_TYPES) {
    const { changed, failed } = await hardenOne(client, typeName, opts.apply);
    if (failed) return 1;
    if (changed) changedTypes++;
  }

  if (changedTypes === 0) {
    console.log("\nNothing to do.");
    return 0;
  }
  if (!opts.apply) {
    console.log(
      `\n(dry run — re-run with --apply to write these to ${changedTypes} call type(s))`,
    );
  }
  return 0;
}

// Only when invoked as a script, so the constants above can be unit-tested
// without the import opening a Stream client.
if (process.argv[1] && /harden-unused-call-types/.test(process.argv[1])) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
