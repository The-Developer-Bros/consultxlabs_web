/**
 * Delete phantom DM channels — `messaging` channels with fewer than two members.
 *
 * ## Where they came from
 *
 * `ChannelSearch` used to open a search result with
 * `client.channel("messaging", id).watch()` on a browser-computed id. In
 * `stream-chat`, `watch()` posts to the channel **query** endpoint, which is the
 * same endpoint `create()` posts to — `channel.create()` is literally
 * `query({ created_by_id })`. So watching an id that did not exist created it,
 * with the caller as `created_by` and **no members**.
 *
 * The app paths that did that are gone, and `ensure-chat-type-grants.ts` revokes
 * `create-channel` from `user`/`guest` so Stream itself refuses. Neither helps
 * with the ones already on the app: a phantom is a real channel, it accepts real
 * messages, and it is billed like any other. Dev, preview and production share
 * one Stream app, so every environment's phantoms are in the same place.
 *
 * ## Why "< 2 members" is the right predicate
 *
 * A DM is a pair by construction. `getDmChannelId` refuses a self-pair and every
 * server-side creator passes both ids in the `members` array atomically, so a
 * healthy DM has exactly two. One member means the second was never added; zero
 * means it was created by `watch()`.
 *
 * `team` channels are deliberately out of scope. A webinar channel legitimately
 * sits at one member — its host — between creation and the first registration.
 *
 * And `messaging` alone is NOT sufficient to identify a DM. Collaborator
 * channels (`collab-<webinar|class>-<planId>`) are `messaging` too, as are the
 * admin-created custom ones, and a collab channel can legitimately sit at one
 * member while co-host invitations are still pending. Deleting those would
 * destroy live conversations in the name of cleaning up phantoms. The id prefix
 * is the discriminator, via the same `isDMChannel` the app uses — which is why
 * `dmo-` and `dmh-` had to be registered there first.
 *
 * ## Safety
 *
 * Dry run is the default and prints every candidate with its member count,
 * message count and age. `--apply` deletes, hard, in batches. A pre-image of
 * everything deleted is written first, to a stable path, so a mistake is
 * reconstructible.
 *
 *   npx tsx scripts/stream/purge-memberless-dms.ts
 *   npx tsx scripts/stream/purge-memberless-dms.ts --apply
 *   npx tsx scripts/stream/purge-memberless-dms.ts --apply --purge-with-messages
 *
 * NOTE: a dry run READS production. An apply DELETES from production.
 */
import "dotenv/config";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  getStreamChatClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { isDMChannel } from "../../lib/stream-channel-ids";

type StreamChatClient = ReturnType<typeof getStreamChatClient>;

/**
 * Stream caps `queryChannels` at 30 per call regardless of the `limit` passed.
 * A `do…while (page.length === PAGE_SIZE)` loop with PAGE_SIZE = 100 exits after
 * one page and silently processes only the first 30 — the bug that made
 * `syncUserEventChannels` reconcile a third of a roster. Page at the real cap.
 */
const PAGE_SIZE = 30;

/** Stream's documented ceiling for `deleteChannels`. */
const DELETE_BATCH = 100;

/** Where the pre-image goes. Stable, not pid-suffixed, so a later run finds it. */
const PRE_IMAGE_PATH = join(
  process.cwd(),
  ".stream-backups",
  "purged-memberless-dms.json",
);

interface Options {
  apply: boolean;
  /** Skip channels that hold messages, however broken they look. */
  purgeWithMessages: boolean;
}

interface Candidate {
  cid: string;
  id: string;
  memberIds: string[];
  createdById?: string;
  createdAt?: string;
  lastMessageAt?: string;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    purgeWithMessages: argv.includes("--purge-with-messages"),
  };
}

/**
 * Should this channel be deleted, and if so what do we record about it?
 *
 * Returns null for anything that must be left alone. Order matters: the prefix
 * test comes before the member count, because only `dm-`/`dmo-`/`dmh-` ids are
 * pair conversations. A `collab-<webinar|class>-<planId>` channel is `messaging`
 * too and legitimately sits at one member while co-host invitations are pending
 * — checking members first would put it on the delete list.
 */
function toCandidate(
  channel: Awaited<ReturnType<StreamChatClient["queryChannels"]>>[number],
  opts: Options,
): Candidate | null {
  if (!isDMChannel(channel.id)) return null;

  const memberIds = Object.keys(channel.state?.members ?? {});
  if (memberIds.length >= 2) return null;

  const messageCount = channel.state?.messages?.length ?? 0;
  // Message-bearing channels are KEPT by default (PR #1188 review): a
  // one-member DM can be the residue of a live conversation whose counterpart
  // was evicted, and hard delete is irreversible. Only an explicit operator
  // opt-in destroys history.
  if (messageCount > 0 && !opts.purgeWithMessages) return null;

  const data = channel.data as Record<string, unknown> | undefined;
  return {
    cid: channel.cid,
    id: channel.id ?? "",
    memberIds,
    createdById:
      typeof data?.created_by_id === "string"
        ? data.created_by_id
        : ((data?.created_by as { id?: string } | undefined)?.id ?? undefined),
    createdAt:
      typeof data?.created_at === "string" ? data.created_at : undefined,
    lastMessageAt:
      typeof data?.last_message_at === "string"
        ? data.last_message_at
        : undefined,
  };
}

/**
 * Page every `messaging` channel and collect the deletable ones.
 *
 * Filtered locally rather than server-side because Stream's channel filters
 * have no `member_count` operator — `members: { $in: [...] }` needs ids we do
 * not have, and there is no "fewer than N members" query.
 */
async function scanForCandidates(
  client: StreamChatClient,
  opts: Options,
): Promise<{ scanned: number; dmScanned: number; candidates: Candidate[] }> {
  const candidates: Candidate[] = [];
  let scanned = 0;
  let dmScanned = 0;
  let offset = 0;

  for (;;) {
    const page = await client.queryChannels(
      { type: "messaging" },
      { created_at: 1 },
      { limit: PAGE_SIZE, offset, state: true, watch: false, presence: false },
    );
    if (page.length === 0) break;
    scanned += page.length;

    for (const channel of page) {
      if (isDMChannel(channel.id)) dmScanned++;
      const candidate = toCandidate(channel, opts);
      if (candidate) candidates.push(candidate);
    }

    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }

  return { scanned, dmScanned, candidates };
}

/** Print every candidate in full. This is what an operator reads before applying. */
function reportCandidates(
  candidates: Candidate[],
  scanned: number,
  dmScanned: number,
): void {
  console.log(
    `Scanned ${scanned} messaging channels (${dmScanned} were DM-prefixed).`,
  );
  console.log(`Found ${candidates.length} with fewer than 2 members:\n`);
  for (const c of candidates) {
    console.log(
      `  ${c.cid}\n` +
        `    members: ${c.memberIds.length === 0 ? "(none)" : c.memberIds.join(", ")}\n` +
        `    created_by: ${c.createdById ?? "unknown"}   created: ${c.createdAt ?? "?"}\n` +
        `    last_message_at: ${c.lastMessageAt ?? "never"}`,
    );
  }
}

/** Snapshot, then delete in batches. Returns how many were deleted. */
async function deleteCandidates(
  client: StreamChatClient,
  candidates: Candidate[],
): Promise<number> {
  // Written BEFORE the delete. Unlike the grants script — where the pre-image
  // only matters if a write succeeded — a delete is unrecoverable, so the
  // snapshot has to exist even if the delete then fails halfway.
  mkdirSync(dirname(PRE_IMAGE_PATH), { recursive: true });
  // Write-then-rename, matching ensure-chat-type-grants. An interrupted write
  // would otherwise leave a truncated pre-image where a previous run's valid
  // one used to be — losing the record of what an EARLIER purge deleted, which
  // is the only thing that makes this reversible at all.
  // Per-RUN file, not a shared path: a retry after a partial batch failure
  // scans only the remaining channels, so overwriting one stable filename
  // would replace the record of what the EARLIER batches deleted. Each run's
  // snapshot is preserved alongside the others.
  const runPreImagePath = `${PRE_IMAGE_PATH}.${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  const tmpPath = `${runPreImagePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(candidates, null, 2));
  renameSync(tmpPath, runPreImagePath);
  console.log(`\nPre-image written to ${runPreImagePath}`);

  let deleted = 0;
  for (let i = 0; i < candidates.length; i += DELETE_BATCH) {
    const batch = candidates.slice(i, i + DELETE_BATCH).map((c) => c.cid);
    await client.deleteChannels(batch, { hard_delete: true });
    deleted += batch.length;
    console.log(`  deleted ${deleted}/${candidates.length}`);
  }
  return deleted;
}

export async function purgeMemberlessDms(
  opts: Options,
): Promise<{ scanned: number; candidates: number; deleted: number; ok: boolean }> {
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    // A failed cleanup must not read as a completed no-op to CI or an operator.
    return { scanned: 0, candidates: 0, deleted: 0, ok: false };
  }

  const client = getStreamChatClient();
  const { scanned, dmScanned, candidates } = await scanForCandidates(
    client,
    opts,
  );

  reportCandidates(candidates, scanned, dmScanned);

  if (candidates.length === 0) return { scanned, candidates: 0, deleted: 0, ok: true };

  if (!opts.apply) {
    console.log(
      `\n(dry run — pass --apply to delete these ${candidates.length})`,
    );
    return { scanned, candidates: candidates.length, deleted: 0, ok: true };
  }

  const deleted = await deleteCandidates(client, candidates);
  return { scanned, candidates: candidates.length, deleted, ok: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Purging memberless DMs (${opts.apply ? "LIVE" : "DRY RUN"}` +
      `${opts.purgeWithMessages ? ", INCLUDING any with messages" : ", keeping any with messages"})...`,
  );
  const result = await purgeMemberlessDms(opts);
  console.log("\nDone:", result);
  process.exit(result.ok ? 0 : 1);
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
