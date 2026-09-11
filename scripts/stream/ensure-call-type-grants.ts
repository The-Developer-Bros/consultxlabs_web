/**
 * #1134 P0-1 — move `join-call` off the plain `user` role.
 *
 * Stream's `default` call type grants `join-call` to `user`, which means any
 * holder of a valid token for the app can join any call by id. Our call ids are
 * deterministic (`slot-<anchorSlotId>`) and slot ids travel in availability
 * payloads, so a signed-in stranger could open a private consultation from
 * devtools. The app-side check was a React conditional and stopped nothing.
 *
 * This moves `join-call` to `call_member`. Combined with the members named at
 * creation (`provisionAppointmentMeeting` in actions/stream/meetings) and the
 * membership that app/api/meetings/[meetingId]/join grants server-side after
 * resolveMeetingAccess passes, Stream refuses a non-member itself. There are no
 * call-scoped tokens: the video client is an app-wide singleton holding one user
 * token, so `call_cids` would have meant a second client per meeting.
 *
 * #1270 — run scripts/stream/backfill-call-member-role.ts BEFORE this. Calls
 * minted before that change named their members `host`/`user`, neither of which
 * survives this write; the pre-flight below refuses to apply until at least one
 * member of an open call actually holds `call_member`.
 *
 * We harden `default` in place rather than minting a bespoke type because a
 * call's type is immutable: a new type would protect only future calls and leave
 * every existing one open.
 *
 * It also revokes `end-call` and recording control from `call_member`, which the
 * join route hands to every participant. Both are server-side now
 * (`/api/meetings/[meetingId]/end`, `/api/stream/recordings/{start,stop}`), so
 * the grants buy nothing legitimate and let any attendee end a paid session or
 * defeat the pre-join recording-consent gate.
 *
 * Idempotent and reversible. Dry-run is the default — pass `--apply` to write.
 * Reverting is the same script with `--restore-user-join`.
 *
 *   npx tsx scripts/stream/ensure-call-type-grants.ts
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --routes-are-deployed
 *   npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getStreamVideoClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { STREAM_CALL_TYPE } from "../../lib/stream/call-cid";
// One implementation of the drift comparison, not three. This file,
// ensure-call-type-settings.ts and ensure-app-settings.ts each had their own;
// they must agree, because this is the check that decides whether an operator
// is told a production config was just wiped.
import { canonical } from "../../lib/stream/config-fingerprint";
// The role every participant is given by /api/meetings/[meetingId]/join, by the
// server-side mint, and by the backfill. Imported rather than restated: a typo
// in this one string is a total video outage, and the two scripts have to agree
// about it or the pre-flight below checks for a role nothing assigns.
import {
  anyOpenCallMemberHolds,
  MEMBER_ROLE,
} from "./backfill-call-member-role";

const JOIN_CALL = "join-call";

/**
 * Roles that lose `join-call`. Verified against the LIVE call type, not assumed:
 * the `default` grants map has exactly six keys — guest, user, call_member,
 * admin, global_read_only, global_admin. There is no `host` and no `moderator`
 * key, so an earlier draft that tried to "protect" those was a no-op.
 *
 * `guest` matters as much as `user`. It holds `join-call`, and the app has
 * `guest_user_creation_disabled: false` — guest sessions are creatable
 * client-side with nothing but the public API key, which we ship as
 * NEXT_PUBLIC_STREAM_API_KEY. Stripping only `user` would have left the hole
 * wide open behind a fix that claimed to close it.
 */
const JOIN_REVOKED_ROLES = ["user", "guest"];

/**
 * Recording control is server-only here: RecordingControls.tsx posts to
 * /api/stream/recordings/start and /stop, and there is not one client-side
 * `call.startRecording()` in the tree. So the grant buys nothing legitimate, and
 * it costs the pre-join consent gate its teeth — that gate guards our endpoint,
 * not a direct SDK call.
 *
 * Revoked from `call_member` as well as `user`/`guest`, which is the whole point.
 * The join route assigns `call_member` to EVERY participant, and the live type
 * gives `call_member` all three of these permissions — so stripping them from
 * `user` alone, as an earlier draft did, changed precisely nothing.
 */
const RECORDING_PERMISSIONS = ["start-recording", "stop-recording"];

/**
 * `end-call` is now revoked from `call_member` too. This is the deploy the
 * previous revision of this comment was waiting for.
 *
 * The hole: the join route assigns `call_member` to EVERY participant, and the
 * live `default` type grants that role `end-call`. Stream's roles do not
 * separate host from participant here — host-ness is `custom.consultantUserId`,
 * an application concept Stream knows nothing about — so any attendee could end
 * a paid consultation for both sides from devtools. `EndCallButton`'s `isHost`
 * is a React conditional; it decides what renders, not what Stream permits.
 *
 * It could not be closed until the client stopped needing the grant.
 * `EndCallButton.tsx` used to call `call.endCall()` directly, so revoking would
 * have taken the host's own control down with it and left the hole open anyway.
 *
 * #1270 built the replacement and it is on `dev`:
 * `POST /api/meetings/[meetingId]/end` resolves access server-side, requires the
 * hosting side, and ends the call with the server client.
 * `app/meetings/[id]/components/EndCallButton.tsx` posts to it behind an
 * `endingRef` guard and a 10s bound, and no longer touches the SDK.
 *
 * So the revocation is safe the moment that bundle is serving traffic — and
 * unsafe before it, in exactly the same way and for exactly the same reason as
 * the `join-call` move above: hosts still on the old bundle would lose End Call
 * with nothing to replace it. `--routes-are-deployed` gates both, because both
 * ship in the same deploy — and the flag is plural for a reason, see parseArgs.
 */
const END_CALL = "end-call";

/** Everything an ordinary participant can hold, recording-wise. */
const RECORDING_REVOKED_ROLES = [...JOIN_REVOKED_ROLES, MEMBER_ROLE];

/**
 * Who loses `end-call`. Same set as recording: nobody joining as an ordinary
 * participant has a legitimate reason to hold it now that the button goes
 * through the server.
 */
const END_CALL_REVOKED_ROLES = RECORDING_REVOKED_ROLES;

interface Options {
  apply: boolean;
  restore: boolean;
  deployConfirmed: boolean;
}

function parseArgs(argv: string[]): Options {
  return {
    apply: argv.includes("--apply"),
    restore: argv.includes("--restore-user-join"),
    // #1301 follow-up — the flag is what an operator types from memory; the
    // refusal message is what they read only AFTER being refused. Naming it
    // after the join route alone was a trap: verified on 2026-09-01, the join
    // route IS on prod and the END route is NOT, so an operator asserting
    // truthfully about the join route would have stripped `end-call` and taken
    // End Call away from every host — prod's `EndCallButton` still calls
    // `call.endCall()` client-side.
    //
    // The old spelling stays a working alias so any runbook, shell history or
    // pasted command keeps functioning. Being refused because you typed the
    // documented flag would be its own small outage.
    deployConfirmed:
      argv.includes("--routes-are-deployed") ||
      argv.includes("--join-route-is-deployed"),
  };
}

/**
 * The order this script runs in relative to the deploy is load-bearing, and
 * getting it wrong locks every user out of every call.
 *
 * Applying strips `join-call` from the `user` role. Nobody can then join except
 * as a `call_member`, and the only things that make anyone a `call_member` are
 * the server-side mint and `POST /api/meetings/[meetingId]/join` — and the mint
 * only ever runs once per session, when the room is first created, so the route
 * is what every EXISTING call depends on. Run this before that route is live and
 * there is a window in which no one can join anything.
 *
 * The post-apply guard below does not catch it. That guard checks whether
 * Stream stored `join-call` on `call_member`, which it will have — the grant is
 * present, there is simply nobody holding the role. It passes, and reports
 * success, for exactly the failure that matters here.
 *
 * This cannot be verified automatically. Every route on the production origin
 * answers 404 to an unauthenticated request, deployed or not, so there is no
 * external probe that distinguishes them. So the operator asserts it, with a
 * flag named after the thing being asserted.
 */
function requireDeployConfirmation(opts: Options): boolean {
  if (!opts.apply || opts.restore || opts.deployConfirmed) return true;

  console.error(
    "\n🛑 Refusing to apply.\n" +
      "\nThis write depends on TWO routes already serving production traffic.\n" +
      "\n1. It strips `join-call` from the `user` role. After it, the only way to\n" +
      "   join a call is to hold `call_member`, and the only thing that grants\n" +
      "   that is POST /api/meetings/[meetingId]/join. If that route is not live\n" +
      "   RIGHT NOW, every user is locked out of every call the moment this\n" +
      "   lands.\n" +
      "\n2. It strips `end-call` from `call_member`. Hosts still running an old\n" +
      "   bundle call `call.endCall()` directly and will silently lose End Call;\n" +
      "   the replacement is POST /api/meetings/[meetingId]/end.\n" +
      "\nBoth ship in the same deploy, so one flag asserts both.\n" +
      "\nDeploy first. Confirm the route is live. Then re-run with:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --routes-are-deployed\n" +
      "\nIf you get it wrong, the rollback is:\n" +
      "  npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join\n",
  );
  return false;
}

/**
 * The check the post-apply guard cannot make: does anybody actually HOLD
 * `call_member`?
 *
 * The guard at the bottom of this file re-reads the call type and confirms
 * Stream stored `join-call` on `call_member`. That is necessary and it is not
 * the failure that matters. The grant will be there — it is written a few lines
 * above — and it admits nobody if no member has been given the role. Until
 * #1270 nothing ever assigned it at creation: the mint stamped `host` on the
 * consultant (a role key the live `default` type does not even have) and `user`
 * on everyone else, and only the join route ever wrote `call_member`, one
 * participant at a time.
 *
 * So the blind spot was total: a green run, a correct-looking grants map, and
 * every person in every live call locked out at the same instant. This asks the
 * question directly, against real member records, and refuses to write if the
 * answer is no.
 *
 * A Stream outage must not be read as "nobody holds the role" — that would turn
 * a transient failure into a refusal to ever apply. It is reported as its own
 * failure instead.
 */
async function requireSomeoneHoldsMemberRole(
  client: ReturnType<typeof getStreamVideoClient>,
  opts: Options,
): Promise<boolean> {
  if (!opts.apply || opts.restore) return true;

  let scan: Awaited<ReturnType<typeof anyOpenCallMemberHolds>>;
  try {
    scan = await anyOpenCallMemberHolds(client, MEMBER_ROLE);
  } catch (err) {
    console.error(
      `\n🛑 Refusing to apply — could not read call members from Stream.` +
        `\n   This check is what stands between a security fix and a total` +
        `\n   video outage, so an unanswered question is a refusal.\n`,
      err,
    );
    return false;
  }

  // No open calls at all is not evidence of anything, and refusing there would
  // make this script unrunnable on a quiet app or a fresh environment. Say so
  // rather than passing silently.
  if (scan.callsScanned === 0) {
    console.log(
      `ℹ️  No open calls to check — nobody can be locked out of a call that does not exist.`,
    );
    return true;
  }

  if (scan.found) return true;

  // #1270 review — a PARTIAL result is a refusal too. The check used to pass on
  // one member anywhere holding the role, so a mixed roster satisfied it and the
  // members who lacked the role were locked out by this very write.
  console.error(
    `\n🛑 Refusing to apply.\n` +
      `\nScanned ${scan.callsScanned} open call(s). ${scan.membersMissingRole} member(s)` +
      `\nacross ${scan.callsWithUncoveredMembers.length} call(s) do NOT hold \`${MEMBER_ROLE}\`.` +
      `\nAfter this write that role is the only thing that admits anyone, so each` +
      `\nof those members is locked out of a call they are entitled to join.` +
      (scan.callsWithUncoveredMembers.length > 0
        ? `\n\nAffected calls: ${scan.callsWithUncoveredMembers.slice(0, 10).join(", ")}` +
          (scan.callsWithUncoveredMembers.length > 10
            ? ` … and ${scan.callsWithUncoveredMembers.length - 10} more`
            : ``)
        : ``) +
      `\n\nBackfill the role first, then re-run:` +
      `\n  npx tsx scripts/stream/backfill-call-member-role.ts` +
      `\n  npx tsx scripts/stream/backfill-call-member-role.ts --apply\n`,
  );
  return false;
}

export async function ensureCallTypeGrants(opts: Options): Promise<number> {
  // Before anything else, including the read — a refusal should not depend on
  // Stream being reachable.
  if (!requireDeployConfirmation(opts)) return 1;

  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamVideoClient();

  if (!(await requireSomeoneHoldsMemberRole(client, opts))) return 1;
  const existing = await client.video.getCallType({ name: STREAM_CALL_TYPE });

  const grants: Record<string, string[]> = { ...existing.grants };

  const before = JSON.stringify(grants, null, 2);

  if (opts.restore) {
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants && !roleGrants.includes(JOIN_CALL)) {
        grants[role] = [...roleGrants, JOIN_CALL];
      }
    }
    // `call_member` gets `end-call` back as well, because this rollback exists
    // for one situation — the end route is not actually serving traffic — and in
    // that situation the host has no way to end a call at all. Restoring join
    // without it would fix the lockout and leave every host stranded in a room
    // they cannot close.
    const restoreMember = grants[MEMBER_ROLE];
    if (restoreMember && !restoreMember.includes(END_CALL)) {
      grants[MEMBER_ROLE] = [...restoreMember, END_CALL];
    }

    // Recording control is NOT restored, and `user`/`guest` get nothing back
    // beyond `join-call`. Those revocations carry no availability risk — there
    // is no client-side `call.startRecording()` in the tree to break — so
    // undoing them would only re-open holes this script closed.
  } else {
    // `user` and `guest` lose the lot — they should not be joining at all.
    for (const role of JOIN_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter(
          (g) =>
            g !== JOIN_CALL &&
            g !== END_CALL &&
            !RECORDING_PERMISSIONS.includes(g),
        );
      }
    }

    // `call_member` keeps join-call — it is what the join route assigns and the
    // only thing that admits anyone — but loses recording control and `end-call`.
    // Both are server-side now: /api/stream/recordings/{start,stop} and
    // /api/meetings/[meetingId]/end.
    for (const role of RECORDING_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter(
          (g) => !RECORDING_PERMISSIONS.includes(g),
        );
      }
    }

    for (const role of END_CALL_REVOKED_ROLES) {
      const roleGrants = grants[role];
      if (roleGrants) {
        grants[role] = roleGrants.filter((g) => g !== END_CALL);
      }
    }

    // call_member is what /api/meetings/[meetingId]/join assigns, so it MUST
    // keep join-call. It already holds it on the live type; assert rather than
    // assume, because getting this wrong locks every paying user out of every
    // call.
    const memberGrants = grants[MEMBER_ROLE] ?? [];
    if (!memberGrants.includes(JOIN_CALL)) {
      grants[MEMBER_ROLE] = [...memberGrants, JOIN_CALL];
    }
  }

  const after = JSON.stringify(grants, null, 2);

  if (before === after) {
    console.log(
      `✅ call type "${STREAM_CALL_TYPE}" already has the desired grants — no change`,
    );
    return 0;
  }

  console.log(`Call type: ${STREAM_CALL_TYPE}`);
  for (const role of [...JOIN_REVOKED_ROLES, MEMBER_ROLE, "admin"]) {
    const had = (existing.grants[role] ?? []).includes(JOIN_CALL);
    const now = (grants[role] ?? []).includes(JOIN_CALL);
    console.log(
      `  ${role.padEnd(12)} join-call: ${had} → ${now}` +
        (grants[role] ? "" : "   (role absent on this call type)"),
    );
  }
  for (const role of RECORDING_REVOKED_ROLES) {
    for (const perm of [...RECORDING_PERMISSIONS, END_CALL]) {
      const had = (existing.grants[role] ?? []).includes(perm);
      const now = (grants[role] ?? []).includes(perm);
      if (had === now && !had) continue;
      console.log(
        `  ${role.padEnd(12)} ${perm.padEnd(16)}: ${had} → ${now}` +
          (perm === END_CALL && role === MEMBER_ROLE
            ? "   (server-side now — POST /api/meetings/[meetingId]/end)"
            : ""),
      );
    }
  }

  // There used to be a guard here refusing to write a config where call_member
  // lacked join-call. It could never fire: the block above unconditionally adds
  // join-call to call_member a few lines earlier, so the condition was false by
  // construction — a safety net that read as protection and executed no
  // branches, which is the second time that exact shape has appeared in this
  // file. The check that matters is on the way back, against what Stream
  // actually stored, and it lives in the verification below.

  if (!opts.apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
    return 0;
  }

  // Stream does not document whether updateCallType merges or replaces the
  // top-level fields it is not given, and this codebase has already been bitten
  // by the chat twin: `channel.update()` is a FULL REPLACE that deletes every
  // custom field absent from the payload. The `default` type carries a large
  // `settings` block (recording layout, transcription, limits, backstage) and a
  // populated `notification_settings`, so a replace here would be a silent,
  // wide-blast-radius config wipe.
  //
  // Re-sending them is not the fix: `CallSettingsResponse` is not assignable to
  // `CallSettingsRequest` (every nested type differs), so echoing the read back
  // would mean casting data we have not verified is request-shaped — which could
  // corrupt the config on its own. Instead: snapshot, apply, re-read, compare.
  // A wipe becomes loud and recoverable rather than silent, and the first real
  // run settles the question for good.
  const settingsBefore = canonical(existing.settings);
  const notificationsBefore = canonical(existing.notification_settings);

  await client.video.updateCallType({ name: STREAM_CALL_TYPE, grants });

  const verify = await client.video.getCallType({ name: STREAM_CALL_TYPE });
  const settingsAfter = canonical(verify.settings);
  const notificationsAfter = canonical(verify.notification_settings);

  // The one invariant worth checking against real returned data rather than
  // against our own intent: the join route assigns `call_member`, so if Stream
  // did not store join-call on that role, every participant is locked out of
  // every call. Checked here, after the write, where it can genuinely fail.
  if (
    !opts.restore &&
    !(verify.grants[MEMBER_ROLE] ?? []).includes(JOIN_CALL)
  ) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} does NOT hold ${JOIN_CALL} on Stream after this write.` +
        `\n   Every participant is locked out of every call. Roll back NOW:` +
        `\n     npx tsx scripts/stream/ensure-call-type-grants.ts --apply --restore-user-join`,
    );
    return 1;
  }

  // The mirror of the check above, for the change this revision adds. Asserting
  // an ABSENCE against returned data matters as much as asserting the presence:
  // a silently-ignored revocation would leave every attendee able to end a paid
  // consultation while this script printed a green tick.
  if (!opts.restore && (verify.grants[MEMBER_ROLE] ?? []).includes(END_CALL)) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} still holds ${END_CALL} on Stream after this write.` +
        `\n   Every attendee can still end a consultation for both sides.` +
        `\n   The grants write did not take effect as sent — re-read the call type` +
        `\n   and do not report this run as successful.`,
    );
    return 1;
  }

  // The rollback needs verifying too, and used to get none: BOTH post-write
  // grant checks are gated on `!opts.restore`, so `--restore-user-join` reached
  // the settings comparison, found nothing moved, and returned 0 — reporting
  // success without ever asking whether the restoration landed.
  //
  // That is backwards. The rollback is the emergency path: it is reached when
  // the revocation has already locked people out, and "it worked" is the one
  // thing the operator cannot afford to be told wrongly. Only asserted when
  // this run actually intended to restore the grant, so a rollback of a call
  // type that never had it does not fail on a no-op.
  if (
    opts.restore &&
    (grants[MEMBER_ROLE] ?? []).includes(END_CALL) &&
    !(verify.grants[MEMBER_ROLE] ?? []).includes(END_CALL)
  ) {
    console.error(
      `\n🚨 ${MEMBER_ROLE} still lacks ${END_CALL} on Stream after the rollback.` +
        `\n   Hosts cannot end a call, which is the state this rollback exists to` +
        `\n   undo. Do NOT report this run as successful.`,
    );
    return 1;
  }

  if (
    settingsAfter !== settingsBefore ||
    notificationsAfter !== notificationsBefore
  ) {
    // Written to a file, not just stderr. This is the only copy of the config
    // Stream just discarded, the `settings` block is a couple of kilobytes of
    // recording layout, and an operator who scrolls away or closes the terminal
    // has lost the one thing that can undo this. Sentry is not the answer here:
    // nothing in .github/workflows runs this script, so it is always a human at
    // a laptop, where initJobSentry deliberately disables reporting (#901).
    const preImagePath = join(
      tmpdir(),
      `stream-call-type-${STREAM_CALL_TYPE}-preimage.json`,
    );
    const preImage = JSON.stringify(
      {
        callType: STREAM_CALL_TYPE,
        settings: existing.settings,
        notification_settings: existing.notification_settings,
      },
      null,
      2,
    );
    try {
      writeFileSync(preImagePath, preImage);
    } catch (err) {
      // Falling back to stderr is worse but not nothing.
      console.error(
        `(could not write the pre-image to ${preImagePath}:`,
        err,
        ")",
      );
      console.error(preImage);
    }

    console.error(
      `\n⚠️  updateCallType CHANGED configuration it was not given.` +
        `\n   settings changed:              ${settingsAfter !== settingsBefore}` +
        `\n   notification_settings changed: ${notificationsAfter !== notificationsBefore}` +
        `\n\n   The grants change applied. Restore the rest from the pre-image at:` +
        `\n     ${preImagePath}\n`,
    );
    return 1;
  }

  console.log(
    `\n✅ applied — settings and notification_settings verified unchanged.`,
  );
  console.log(`   Revert the grants with: --apply --restore-user-join`);
  return 0;
}

if (require.main === module) {
  ensureCallTypeGrants(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-call-type-grants failed:", err);
      process.exitCode = 1;
    });
}
