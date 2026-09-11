/**
 * Move channel creation and membership changes off the client, on Stream's side.
 *
 * The chat counterpart of `ensure-call-type-grants.ts`. That script found that
 * Stream's `default` call type grants `join-call` to the plain `user` role, so
 * any signed-in account could join any call by id. The chat side has the same
 * shape of hole and nothing in this repo has ever touched it: the only
 * `updateAppSettings` call we make is `ensure-webhook-subscription.ts`, and it
 * writes `event_hooks` alone. Chat channel-type permissions are therefore
 * whatever Stream ships by default, which for `messaging` and `team` includes
 * `create-channel` for `user`.
 *
 * That default is what let a browser mint a channel. `ChannelSearch` called
 * `channel.watch()` on a client-computed id; `watch()` posts to the channel
 * query endpoint, which creates the channel when it is absent, with the caller
 * as `created_by` and no members. The result was a conversation titled with its
 * own raw id, reporting "No members", that accepted a message and vanished on
 * reload. `POST /api/stream/channels/open` fixes the app path. This closes the
 * door behind it, so a leaked token or a future component cannot reopen it.
 *
 * `guest` matters as much as `user`, for the same reason the call-type script
 * gives: the app has `guest_user_creation_disabled: false`, so guest sessions
 * are creatable client-side with nothing but the public API key we ship as
 * `NEXT_PUBLIC_STREAM_API_KEY`. Stripping only `user` would leave the hole open
 * behind a fix that claims to close it.
 *
 * Also sets `user_search_disallowed_roles`, which stops a client-side
 * `queryUsers` from enumerating the user base. Stream's own docs note that
 * `queryUsers` requires no special permission by default.
 *
 * Existing channels are unaffected — grants are evaluated per request against
 * the channel TYPE, not baked in at creation. That is the opposite of the call
 * type's immutability problem, and it is why this hardens the built-in types in
 * place rather than minting bespoke ones.
 *
 * Idempotent and reversible. Dry-run is the default.
 *
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --open-route-is-deployed
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --restore-user-create
 *   npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --rebaseline
 *
 * NOTE: dev, preview and production share one Stream app. A dry run here reads
 * production. An apply writes it.
 */
import "dotenv/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  getStreamChatClient,
  isStreamConfigured,
} from "../../lib/stream-client";

/** The two built-in channel types this app uses. Nothing else is in play. */
const CHANNEL_TYPES = ["messaging", "team"] as const;

/**
 * Roles that lose the ability to create channels and rewrite membership.
 *
 * Not `admin`: ADMIN/STAFF map to Stream's `admin` role via `mapRoleToStream`,
 * and the support surfaces rely on it. Not `channel_moderator` either — an
 * event host holds it and legitimately manages their own roster through
 * `addMemberToChannel`, which is server-side and bypasses these grants anyway.
 */
const REVOKED_ROLES = ["user", "guest"] as const;

/**
 * `create-channel` is the one that matters; `update-channel-members` is the
 * follow-up. Without the second, a user who is already in a channel can still
 * add anyone they like to it — which is how a private DM becomes a group.
 *
 * Stream's permission names are kebab-case in the grants arrays.
 */
const REVOKED_PERMISSIONS = [
  "create-channel",
  "update-channel-members",
] as const;

/** Roles barred from client-side `queryUsers`. Same reasoning as above. */
const USER_SEARCH_DISALLOWED_ROLES = ["user", "guest"];

/**
 * Where the pre-image lives. Committed to a stable, repo-relative path rather
 * than a pid-suffixed temp file, because `--restore-user-create` reads it back
 * on a LATER invocation — a path only the writing process could name made the
 * rollback flag unusable in practice.
 */
const PRE_IMAGE_PATH = join(
  process.cwd(),
  ".stream-backups",
  "chat-type-grants.json",
);

interface Options {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
  /** Overwrite an existing pre-image with the CURRENT live state. */
  rebaseline: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-create"),
    deployConfirmed: argv.includes("--open-route-is-deployed"),
    rebaseline: argv.includes("--rebaseline"),
  };
}

/** Code-unit ordering. Passed explicitly everywhere, never `localeCompare`. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable stringify for comparing two independent reads.
 *
 * Plain `JSON.stringify` preserves key insertion order, and the snapshots come
 * from separate responses — so an identical configuration whose keys arrived in
 * a different order would report as drift and tell the operator Stream
 * discarded settings it never touched. A false alarm on this check is
 * expensive: it is the thing that says whether a production config wipe just
 * happened.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            byCodeUnit(a, b),
          ),
        )
      : val,
  );
}

/** What we snapshot before writing, and read back to roll forward from. */
interface PreImage {
  capturedAt: string;
  channelTypes: Record<string, Record<string, string[]>>;
  userSearchDisallowedRoles: string[];
}

function readPreImage(): PreImage | null {
  if (!existsSync(PRE_IMAGE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(PRE_IMAGE_PATH, "utf8")) as PreImage;
  } catch {
    return null;
  }
}

/**
 * Ordering against the deploy is load-bearing, and getting it wrong breaks chat
 * for everyone.
 *
 * Applying revokes `create-channel` from `user`. After that, the ONLY thing
 * that can bring a missing channel into existence for an ordinary account is
 * `POST /api/stream/channels/open` (plus the booking-time server paths). Run
 * this before that route is live and any conversation whose channel does not
 * yet exist becomes unopenable — which is precisely the set of conversations
 * the bug report was about.
 *
 * A post-apply read cannot catch it: the grants will be exactly as requested.
 * What it cannot see is whether anything server-side is left that creates
 * channels. So the operator asserts it, with a flag named after the assertion.
 */
function requireDeployConfirmation(opts: Options): boolean {
  if (!opts.apply || opts.restore || opts.deployConfirmed) return true;

  console.error(
    "\n🛑 Refusing to apply.\n" +
      "\nThis revokes `create-channel` from the `user` and `guest` roles. After\n" +
      "it, a channel that does not already exist can only be created server-side\n" +
      "— by booking approval, payment success, or POST /api/stream/channels/open.\n" +
      "If that route is not deployed and serving traffic RIGHT NOW, every search\n" +
      "result whose channel was never created becomes a dead link.\n" +
      "\nDeploy first. Confirm the route is live. Then re-run with:\n" +
      "  npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --open-route-is-deployed\n" +
      "\nIf you get it wrong, the rollback is:\n" +
      "  npx tsx scripts/stream/ensure-chat-type-grants.ts --apply --restore-user-create\n",
  );
  return false;
}

/**
 * The grants this channel type should end up with.
 *
 * Restore returns the PRE-IMAGE verbatim, not "the current grants plus
 * everything we might have revoked". The difference matters: an earlier version
 * re-added every entry in `REVOKED_PERMISSIONS` to `user` and `guest`
 * unconditionally, so rolling back granted permissions those roles may never
 * have held. A rollback that can hand out more access than the change it is
 * undoing is worse than no rollback — and this script's entire justification is
 * that its production write is safely reversible.
 *
 * Restoring therefore requires a pre-image. If there is none, this returns null
 * and the caller refuses rather than guessing.
 */
function computeGrants(
  channelType: string,
  existingGrants: Record<string, string[]>,
  opts: Options,
  preImage: PreImage | null,
): Record<string, string[]> | null {
  if (opts.restore) {
    return preImage?.channelTypes?.[channelType] ?? null;
  }

  const grants: Record<string, string[]> = Object.fromEntries(
    Object.entries(existingGrants).map(([role, perms]) => [role, [...perms]]),
  );

  for (const role of REVOKED_ROLES) {
    // A role absent from this type's grants map is not an error — Stream's
    // built-in types do not all carry the same role keys, and inventing one
    // would grant permissions rather than remove them.
    if (!grants[role]) continue;
    grants[role] = grants[role].filter(
      (g) => !(REVOKED_PERMISSIONS as readonly string[]).includes(g),
    );
  }
  return grants;
}

/** Per-role before/after table for the permissions this script touches. */
function logGrantDiff(
  channelType: string,
  existingGrants: Record<string, string[]>,
  grants: Record<string, string[]>,
): void {
  console.log(`Channel type: ${channelType}`);
  for (const role of REVOKED_ROLES) {
    if (!existingGrants[role]) {
      console.log(`  ${role.padEnd(8)} (role absent on this channel type)`);
      continue;
    }
    for (const perm of REVOKED_PERMISSIONS) {
      const had = (existingGrants[role] ?? []).includes(perm);
      const now = (grants[role] ?? []).includes(perm);
      console.log(`  ${role.padEnd(8)} ${perm.padEnd(24)} ${had} → ${now}`);
    }
  }
}

/**
 * App-level user-search lockdown.
 *
 * Restore reinstates the pre-image value, NOT `[]`. Writing an empty array on
 * rollback would clear whatever the app already had before this script first
 * ran — undoing someone else's setting in the name of undoing ours.
 */
async function syncUserSearchSetting(
  client: ReturnType<typeof getStreamChatClient>,
  opts: Options,
  preImage: PreImage | null,
): Promise<boolean> {
  // Asymmetry in stream-chat v9's types, not in the API: the field is declared
  // on the READ shape (`AppSettingsAPIResponse.app`) but missing from the WRITE
  // shape (`AppSettings`). Stream's own docs show it being written via
  // `updateAppSettings`, so the write below carries a narrow cast.
  const settings = await client.getAppSettings();
  const current = settings.app?.user_search_disallowed_roles ?? [];

  const desired = opts.restore
    ? (preImage?.userSearchDisallowedRoles ?? null)
    : USER_SEARCH_DISALLOWED_ROLES;

  if (desired === null) {
    console.error(
      "🛑 Cannot restore user_search_disallowed_roles — no pre-image on disk.",
    );
    return false;
  }

  if (
    canonical([...current].sort(byCodeUnit)) ===
    canonical([...desired].sort(byCodeUnit))
  ) {
    console.log("✅ user_search_disallowed_roles already correct — no change");
    return false;
  }

  console.log(
    `App setting: user_search_disallowed_roles ` +
      `[${current.join(", ")}] → [${desired.join(", ")}]`,
  );
  if (opts.apply) {
    // NOTE: `updateAppSettings` REPLACES the field it is given rather than
    // merging — the trap documented at length in
    // ensure-webhook-subscription.ts. Only this one key is passed, so the
    // event_hooks that script manages are untouched.
    await client.updateAppSettings({
      user_search_disallowed_roles: desired,
    } as Parameters<typeof client.updateAppSettings>[0]);
    console.log("  written");
  }
  return true;
}

export async function ensureChatTypeGrants(opts: Options): Promise<number> {
  // Before the read — a refusal should not depend on Stream being reachable.
  if (!requireDeployConfirmation(opts)) return 1;

  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const preImage = readPreImage();
  if (opts.restore && !preImage) {
    console.error(
      `🛑 Cannot restore — no pre-image at ${PRE_IMAGE_PATH}.\n` +
        "Restoring without one would mean guessing which permissions each role\n" +
        "originally held, and guessing upward grants access nobody asked for.\n" +
        "Reinstate the grants from the Stream dashboard instead.",
    );
    return 1;
  }

  const client = getStreamChatClient();

  let changed = false;
  const captured: PreImage = {
    capturedAt: new Date().toISOString(),
    channelTypes: {},
    userSearchDisallowedRoles: [],
  };

  // Snapshot everything BEFORE writing anything. The previous version wrote the
  // pre-image after the last successful write, to a pid-suffixed path in
  // tmpdir — so a run that failed halfway left no snapshot at all, and even a
  // clean run left one that the next invocation could not find. A rollback file
  // that only exists when nothing went wrong is not a rollback file.
  for (const channelType of CHANNEL_TYPES) {
    const existing = await client.getChannelType(channelType);
    captured.channelTypes[channelType] = (existing.grants ?? {}) as Record<
      string,
      string[]
    >;
  }
  const settingsProbe = await client.getAppSettings();
  captured.userSearchDisallowedRoles =
    settingsProbe.app?.user_search_disallowed_roles ?? [];

  if (opts.apply && !opts.restore) {
    // An existing pre-image is NEVER silently overwritten.
    //
    // Applying twice would otherwise capture the already-modified state as the
    // rollback target — so the second run quietly redefines "before" as "after",
    // and `--restore-user-create` becomes a no-op that reports success. The
    // failure is invisible until the day someone actually needs to roll back.
    //
    // The second run does not need a new snapshot anyway: this script is
    // idempotent, so by then the live state either already matches the desired
    // one or the first pre-image is still the correct thing to return to.
    if (existsSync(PRE_IMAGE_PATH) && !opts.rebaseline) {
      console.log(
        `Pre-image already exists at ${PRE_IMAGE_PATH} — keeping it.\n` +
          `(pass --rebaseline to replace it with the current live state)\n`,
      );
    } else {
      mkdirSync(dirname(PRE_IMAGE_PATH), { recursive: true });
      // Write-then-rename, so an interrupted write cannot leave a truncated
      // pre-image where a valid one used to be. Same directory, so the rename
      // stays on one filesystem and is atomic.
      const tmpPath = `${PRE_IMAGE_PATH}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(captured, null, 2));
      renameSync(tmpPath, PRE_IMAGE_PATH);
      console.log(`Pre-image written to ${PRE_IMAGE_PATH}\n`);
    }
  }

  for (const channelType of CHANNEL_TYPES) {
    const existingGrants = captured.channelTypes[channelType];
    const grants = computeGrants(channelType, existingGrants, opts, preImage);

    if (!grants) {
      console.error(
        `🛑 No pre-image entry for channel type "${channelType}" — skipping.`,
      );
      continue;
    }

    if (canonical(existingGrants) === canonical(grants)) {
      console.log(
        `✅ channel type "${channelType}" already correct — no change`,
      );
      continue;
    }

    logGrantDiff(channelType, existingGrants, grants);
    changed = true;

    if (!opts.apply) continue;

    await client.updateChannelType(channelType, { grants });
    console.log(`  written`);
  }

  const settingChanged = await syncUserSearchSetting(client, opts, preImage);
  changed = changed || settingChanged;

  if (!changed) return 0;
  if (!opts.apply) {
    console.log("\n(dry run — pass --apply to write)");
    // Drift detected but nothing written: a scheduled/CI consumer must be able
    // to distinguish "in sync" from "drift found" by exit status.
    process.exitCode = 1;
  }

  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Stream chat grants (${opts.apply ? "LIVE" : "DRY RUN"}${opts.restore ? ", RESTORE" : ""})...`,
  );
  process.exit(await ensureChatTypeGrants(opts));
}

if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
