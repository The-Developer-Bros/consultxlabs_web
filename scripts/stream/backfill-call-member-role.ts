/**
 * #1270 — give every member of every still-open call the `call_member` role.
 *
 * ## Why this has to run before the grants script
 *
 * `scripts/stream/ensure-call-type-grants.ts` moves `join-call` off `user` and
 * `guest` and onto `call_member`. After that write, holding `call_member` is the
 * only thing that admits anyone to a call.
 *
 * Nothing in the app has ever assigned that role at CREATION time. The mint
 * stamped `host` on the consultant and `user` on everyone else — and `host` is
 * not even a role key on the live `default` type, so those consultants held no
 * grants at all. Only `POST /api/meetings/[meetingId]/join` assigns
 * `call_member`, and it does so one participant at a time, on their next join.
 *
 * So on the day the grants script is applied, every call minted before this
 * change has members who hold a role that can no longer join. The join route
 * repairs each of them on their next request — but that request is the one that
 * has to work, and a session already in progress does not get to make it. This
 * script does the repair up front, for everyone, in one pass.
 *
 * ## Idempotent
 *
 * A member already holding `call_member` is skipped, so a second run over its
 * own output reports zero changes and writes nothing. `updateCallMembers` is
 * itself an upsert on the role, so a partial run is simply resumed.
 *
 * ## Scope
 *
 * Calls that have already ENDED are left alone. Nobody joins them again, the
 * role there is inert, and the list of them only grows.
 *
 *   npx tsx scripts/stream/backfill-call-member-role.ts
 *   npx tsx scripts/stream/backfill-call-member-role.ts --apply
 *
 * NOTE: a dry run READS production. An apply WRITES member roles to production.
 */
import "dotenv/config";

import {
  getStreamVideoClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";

type StreamVideoClient = ReturnType<typeof getStreamVideoClient>;

/** The role every participant must hold once `join-call` moves onto it. */
export const MEMBER_ROLE = "call_member";

/**
 * Stream's documented maximum for `queryCalls`, and the only page size that
 * works — because its cursor pagination does not.
 *
 * Measured against the live app on 2026-09-01, after `--apply` refused with an
 * API error rather than a verdict:
 *
 *   limit=25  -> 25 calls, next present
 *   limit=50  -> 50 calls, next present
 *   limit=100 -> 84 calls, NO next
 *   limit=250 -> "limit must be 100 or less"
 *
 *   any request carrying `next`
 *     -> "cannot specify sort and next/prev at the same time"
 *
 * That last one is unconditional. Dropping `limit`, dropping the filter, and
 * passing `sort: []` or `sort: undefined` all fail identically — the server
 * sees a default sort on every request the SDK builds, so the `next` cursor can
 * never be used from here.
 *
 * The old size of 25 therefore guaranteed the failure: 84 open calls meant a
 * second page, and the second page always throws. `anyOpenCallMemberHolds`
 * fails closed, so `ensure-call-type-grants.ts --apply` was IMPOSSIBLE TO RUN —
 * the whole call-type hardening rollout was blocked and the refusal read like a
 * transient Stream problem.
 *
 * At 100 the current 84 fit in one page with no cursor. Past 100 there is no
 * supported way to continue, so the traversal reports truncation instead of
 * pretending, and each consumer decides what that means.
 */
const CALL_PAGE_SIZE = 100;

/** Members come back on their own cursor, for a webinar with a long roster. */
const MEMBER_PAGE_SIZE = 100;

/** A call and the roles its members currently hold. */
export interface OpenCall {
  id: string;
  type: string;
  members: Array<{ userId: string; role: string | null }>;
}

/**
 * Every call that has not ended, with its members.
 *
 * A generator rather than an array, and that is the point: the backfill below
 * consumes all of it, while the pre-flight assertion in
 * `ensure-call-type-grants.ts` stops at the first call that answers its
 * question. One traversal, two very different appetites, no second copy of the
 * pagination to drift.
 *
 * `ended_at: null` is Stream's documented filter for a live call. The members
 * are fetched per call rather than read off the `queryCalls` response, because
 * that response caps its embedded member list and a truncated roster here would
 * silently leave the un-listed members behind — which is exactly the class of
 * bug this script exists to clean up.
 */
export async function* iterateOpenCalls(
  client: StreamVideoClient,
): AsyncGenerator<OpenCall> {
  const page = await client.video.queryCalls({
    filter_conditions: { ended_at: null },
    limit: CALL_PAGE_SIZE,
  });

  for (const entry of page.calls) {
    yield {
      id: entry.call.id,
      type: entry.call.type,
      members: await readAllMembers(client, entry.call.type, entry.call.id),
    };
  }

  // One page, deliberately — see CALL_PAGE_SIZE. A `next` here means there are
  // more than 100 open calls and no supported way to reach them, so the
  // traversal is a PREFIX of the answer. It is announced rather than silently
  // returned, because both consumers draw dangerous conclusions from a complete
  // scan: one decides whether it is safe to strip `join-call` from everyone.
  if (page.next) {
    throw new OpenCallScanTruncatedError(page.calls.length);
  }
}

/**
 * More open calls than one page can hold, and no way to page further.
 *
 * A distinct type so `anyOpenCallMemberHolds` can refuse specifically, instead
 * of the caller seeing an opaque Stream error and assuming an outage. If this
 * ever fires, the fix is upstream: reconcile the orphaned sessions so the open
 * count comes back under 100 (most of the current 84 are unreconciled rows, not
 * live meetings), or wait for Stream to accept `next` without a default sort.
 */
export class OpenCallScanTruncatedError extends Error {
  constructor(public readonly scanned: number) {
    super(
      `More than ${scanned} open calls: Stream caps queryCalls at 100 and its ` +
        `next-cursor rejects every request the SDK builds ("cannot specify sort ` +
        `and next/prev at the same time"), so the scan cannot be completed.`,
    );
    this.name = "OpenCallScanTruncatedError";
  }
}

/** Every member of one call, following the member cursor to the end. */
async function readAllMembers(
  client: StreamVideoClient,
  type: string,
  id: string,
): Promise<OpenCall["members"]> {
  const members: OpenCall["members"] = [];
  const call = client.video.call(type, id);
  let next: string | undefined;

  do {
    const page = await call.queryMembers({
      limit: MEMBER_PAGE_SIZE,
      ...(next ? { next } : {}),
    });
    for (const member of page.members) {
      members.push({ userId: member.user_id, role: member.role ?? null });
    }
    next = page.next;
  } while (next);

  return members;
}

/**
 * Does anyone, anywhere, hold this role on a call that is still open?
 *
 * The question `ensure-call-type-grants.ts` has to answer before it strips
 * `join-call` from `user`. Its own post-apply guard checks that the GRANT
 * landed on the role, which it always will — and says nothing about whether a
 * single human being holds that role, which is the condition that decides
 * between a security fix and a total video outage.
 *
 * #1270 review — EVERY member of EVERY open call, not merely one. An earlier
 * version stopped at the first hit, which defeated the whole point: a call with
 * three members where only one held `call_member` passed pre-flight, the apply
 * path then stripped `join-call` from `user` and `guest`, and the other two
 * were locked out of a call they were entitled to join. A guard against a
 * partial outage must not itself be satisfied by a partial result.
 *
 * Memberless open calls stay valid. They have no one to lock out, and the join
 * route is their only way in by design.
 *
 * Scans every open call, so this is O(open calls) rather than O(1) — acceptable
 * for a one-shot pre-flight run by a human before an irreversible grant change.
 */
export async function anyOpenCallMemberHolds(
  client: StreamVideoClient,
  role: string = MEMBER_ROLE,
): Promise<{
  found: boolean;
  callsScanned: number;
  /** Calls holding at least one member WITHOUT the role — the lockout set. */
  callsWithUncoveredMembers: string[];
  membersMissingRole: number;
}> {
  let callsScanned = 0;
  let membersWithRole = 0;
  let membersMissingRole = 0;
  const callsWithUncoveredMembers: string[] = [];

  for await (const call of iterateOpenCalls(client)) {
    callsScanned++;
    const missing = call.members.filter((member) => member.role !== role);
    membersWithRole += call.members.length - missing.length;
    if (missing.length > 0) {
      membersMissingRole += missing.length;
      callsWithUncoveredMembers.push(call.id);
    }
  }

  return {
    // Nobody is locked out only when no member anywhere lacks the role. A run
    // that saw no members at all is vacuously fine — see the note above.
    found:
      membersMissingRole === 0 && (membersWithRole > 0 || callsScanned > 0),
    callsScanned,
    callsWithUncoveredMembers,
    membersMissingRole,
  };
}

export interface Options {
  apply: boolean;
}

export interface BackfillResult {
  callsScanned: number;
  callsChanged: number;
  membersUpdated: number;
  /** Open calls that hold no members at all — the join route is their only way in. */
  memberlessCalls: string[];
  ok: boolean;
}

function parseArgs(argv: string[]): Options {
  return { apply: argv.includes("--apply") };
}

export async function backfillCallMemberRole(
  opts: Options,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    callsScanned: 0,
    callsChanged: 0,
    membersUpdated: 0,
    memberlessCalls: [],
    ok: false,
  };

  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    // A failed backfill must not read as a completed no-op to an operator who
    // is about to apply the grants script on the strength of it.
    return result;
  }

  const client = getStreamVideoClient();

  for await (const call of iterateOpenCalls(client)) {
    result.callsScanned++;

    if (call.members.length === 0) {
      result.memberlessCalls.push(`${call.type}:${call.id}`);
      continue;
    }

    const stale = call.members.filter((member) => member.role !== MEMBER_ROLE);
    if (stale.length === 0) continue;

    result.callsChanged++;
    result.membersUpdated += stale.length;

    console.log(
      `${call.type}:${call.id}\n` +
        stale
          .map((m) => `    ${m.userId}: ${m.role ?? "(none)"} → ${MEMBER_ROLE}`)
          .join("\n"),
    );

    if (!opts.apply) continue;

    await client.video.call(call.type, call.id).updateCallMembers({
      update_members: stale.map((member) => ({
        user_id: member.userId,
        role: MEMBER_ROLE,
      })),
    });
  }

  result.ok = true;
  return result;
}

function report(result: BackfillResult, opts: Options): void {
  console.log(
    `\nScanned ${result.callsScanned} open ${STREAM_CALL_TYPE}-type calls.`,
  );
  console.log(
    `${result.callsChanged} call(s) had ${result.membersUpdated} member(s) on the wrong role.`,
  );

  if (result.memberlessCalls.length > 0) {
    // Not an error, and worth saying out loud: these are joinable only through
    // POST /api/meetings/[id]/join, which grants membership itself. They are
    // the calls minted before members were named at all.
    console.log(
      `\n${result.memberlessCalls.length} open call(s) hold no members. ` +
        `They rely entirely on the join route:\n  ` +
        result.memberlessCalls.slice(0, 20).join("\n  ") +
        (result.memberlessCalls.length > 20 ? "\n  …" : ""),
    );
  }

  if (!opts.apply && result.membersUpdated > 0) {
    console.log(
      `\n(dry run — re-run with --apply to write these ${result.membersUpdated} role changes)`,
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Backfilling the ${MEMBER_ROLE} role (${opts.apply ? "LIVE" : "DRY RUN"})...`,
  );
  const result = await backfillCallMemberRole(opts);
  report(result, opts);
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
