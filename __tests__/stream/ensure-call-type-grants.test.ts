/**
 * @jest-environment node
 */

/**
 * #1134 P0-1 — the grants script, which is the half of the fix that lives in
 * Stream's config rather than in our code.
 *
 * Two rounds of this went wrong in ways reading the code could not show, so the
 * cases below are pinned against the LIVE grants map rather than against the
 * docs. Stream's published docs list five built-in roles including `host` and
 * `moderator` and spell the member role `call-member`; the live `default` type
 * has exactly six keys — `admin, call_member, global_admin, global_read_only,
 * guest, user` — with no `host`, no `moderator`, and an underscore. An earlier
 * draft trusted the docs, assigned `role: "host"`, and would have refused both
 * sides of every 1:1.
 */

const mockGetCallType = jest.fn();
const mockUpdateCallType = jest.fn();
const mockWriteFileSync = jest.fn();
// #1270 — the pre-flight assertion reads real member records before it will
// write. These back it.
const mockQueryCalls = jest.fn();
const mockQueryMembers = jest.fn();

// The drift branch writes the recovery pre-image to disk. Unmocked, every run of
// this suite would leave a real file in tmpdir — and the payload, which is the
// only copy of a config Stream just discarded, would go unasserted.
jest.mock("node:fs", () => ({
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      getCallType: mockGetCallType,
      updateCallType: mockUpdateCallType,
      queryCalls: mockQueryCalls,
      call: () => ({ queryMembers: mockQueryMembers }),
    },
  })),
}));

import { ensureCallTypeGrants } from "../../scripts/stream/ensure-call-type-grants";

/** The live `default` grants, trimmed to the permissions this script touches. */
const LIVE_GRANTS = (): Record<string, string[]> => ({
  admin: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "mute-users",
  ],
  call_member: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "send-audio",
  ],
  global_admin: ["read-call"],
  global_read_only: ["read-call"],
  guest: ["join-call", "send-audio"],
  user: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "send-audio",
  ],
});

/**
 * What the grants map should look like after a successful apply.
 *
 * The two settings-drift cases below need a verify-read that represents a write
 * that WORKED, so that they isolate the branch they are actually about. Feeding
 * them `LIVE_GRANTS()` would trip the post-write grants assertions first and
 * make them pass — or fail — for the wrong reason.
 */
const EXPECTED_GRANTS_AFTER = (): Record<string, string[]> => ({
  admin: [
    "join-call",
    "end-call",
    "start-recording",
    "stop-recording",
    "mute-users",
  ],
  call_member: ["join-call", "send-audio"],
  global_admin: ["read-call"],
  global_read_only: ["read-call"],
  guest: ["send-audio"],
  user: ["send-audio"],
});

const LIVE_SETTINGS = { recording: { mode: "available", quality: "720p" } };
const LIVE_NOTIFICATIONS = { enabled: true };

function mockCallType(grants: Record<string, string[]>) {
  return {
    name: "default",
    grants,
    settings: LIVE_SETTINGS,
    notification_settings: LIVE_NOTIFICATIONS,
  };
}

/** Grants as they end up on Stream after an --apply run. */
function applied(): Record<string, string[]> {
  const call = mockUpdateCallType.mock.calls.at(-1);
  if (!call) throw new Error("updateCallType was never called");
  return call[0].grants as Record<string, string[]>;
}

/**
 * A stateful fake, not a pair of canned responses. The script now re-reads the
 * call type after writing it, so a `getCallType` that keeps returning the
 * PRE-write state makes every apply look like a failed write. Storing what was
 * written is what the real server does; tests that need the two to diverge
 * override with `mockResolvedValueOnce`, which is consumed ahead of this.
 */
let stored: Record<string, string[]>;

/** One open call whose members hold the roles given. */
function openCallWithMembers(roles: Array<string | undefined>) {
  mockQueryCalls.mockResolvedValue({
    calls: [{ call: { id: "slot-A", type: "default" } }],
    next: undefined,
  });
  mockQueryMembers.mockResolvedValue({
    members: roles.map((role, i) => ({ user_id: `user-${i}`, role })),
    next: undefined,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = LIVE_GRANTS();
  mockGetCallType.mockImplementation(async () => mockCallType({ ...stored }));
  mockUpdateCallType.mockImplementation(
    async ({ grants }: { grants: Record<string, string[]> }) => {
      stored = { ...grants };
      return {};
    },
  );
  // A healthy app: the join route has been running and members hold the role
  // the write below is about to make load-bearing.
  openCallWithMembers(["call_member", "call_member"]);
});

describe("ensure-call-type-grants", () => {
  it("is a dry run by default and writes nothing", async () => {
    const code = await ensureCallTypeGrants({
      apply: false,
      restore: false,
      deployConfirmed: false,
    });

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("takes join-call off user AND guest", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    // `guest` matters as much as `user`: the app has
    // guest_user_creation_disabled: false, so guest sessions are creatable
    // client-side with nothing but NEXT_PUBLIC_STREAM_API_KEY. Stripping only
    // `user` leaves the devtools bypass fully intact.
    expect(applied().user).not.toContain("join-call");
    expect(applied().guest).not.toContain("join-call");
  });

  it("leaves call_member able to join — the whole system depends on it", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    // The join route assigns call_member to EVERY participant. If this role
    // cannot join, nobody can join anything.
    expect(applied().call_member).toContain("join-call");
  });

  it("takes recording control off call_member, not just off user", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    // The live type grants call_member start-recording and stop-recording, and
    // the join route hands call_member to everyone — so revoking these from
    // `user` alone changed nothing at all, while reading as a fix. Recording is
    // server-only here (RecordingControls posts to /api/stream/recordings/*;
    // there is no client-side call.startRecording in the tree), so the grant has
    // no legitimate use and its only effect is to let a participant walk around
    // the pre-join consent gate.
    for (const role of ["user", "guest", "call_member"]) {
      expect(applied()[role]).not.toContain("start-recording");
      expect(applied()[role]).not.toContain("stop-recording");
    }
  });

  it("revokes end-call from call_member, now that the end route exists", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    // The join route assigns `call_member` to EVERY participant, and Stream's
    // roles do not separate host from participant here — host-ness is
    // `custom.consultantUserId`, which Stream knows nothing about. So this grant
    // let any attendee end a paid consultation for both sides from devtools;
    // `EndCallButton`'s `isHost` only decides what renders.
    //
    // It could not be revoked until the client stopped needing it. #1270 moved
    // the button onto POST /api/meetings/[meetingId]/end, so it can now go.
    expect(applied().call_member).not.toContain("end-call");
    expect(applied().user).not.toContain("end-call");
    expect(applied().guest).not.toContain("end-call");

    // The one thing that must survive: call_member is what admits anyone at all.
    expect(applied().call_member).toContain("join-call");
  });

  it("leaves end-call on admin", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    // `admin` is not a role any participant is assigned by the join route, and
    // the server client acts outside the permission system anyway. Stripping it
    // would buy nothing and break operator tooling.
    expect(applied().admin).toContain("end-call");
  });

  it("does not touch admin", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(applied().admin).toEqual(LIVE_GRANTS().admin);
  });

  it("does not invent role keys the call type does not have", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    // Review suggested initialising `host` and `moderator`, on the strength of
    // Stream's docs. Neither key exists on this app's `default` type, and the
    // join route assigns neither, so creating them would add grants for roles
    // nobody is ever given.
    expect(Object.keys(applied()).sort()).toEqual(
      Object.keys(LIVE_GRANTS()).sort(),
    );
  });

  it("heals a call type that arrives without a joinable member role", async () => {
    delete (stored as Record<string, string[] | undefined>).call_member;

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(code).toBe(0);
    expect(applied().call_member).toContain("join-call");
  });

  it("fails loudly if Stream did not store join-call on call_member", async () => {
    // The pre-apply version of this check was unreachable — the transform adds
    // join-call to call_member a few lines earlier, so the condition was false
    // by construction. It only means anything against what Stream actually
    // stored, which is what this exercises: the write "succeeds" but the re-read
    // shows the role cannot join, i.e. every participant is locked out.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce({
        name: "default",
        grants: { ...LIVE_GRANTS(), call_member: ["send-audio"] },
        settings: LIVE_SETTINGS,
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(code).toBe(1);
  });

  it("is idempotent — a second run over its own output is a no-op", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(code).toBe(0);
    expect(mockUpdateCallType).not.toHaveBeenCalled();
  });

  it("verifies settings survived the write, and fails loudly if not", async () => {
    // Stream does not document whether updateCallType merges or replaces the
    // fields it is not given, and the chat twin (channel.update) is a full
    // replace that deletes everything absent from the payload. If that turns out
    // to be true here, the run must not report success.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce({
        name: "default",
        grants: EXPECTED_GRANTS_AFTER(),
        settings: {},
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(code).toBe(1);

    // The pre-image is the recovery path. It must carry the config as it was
    // BEFORE the write, or the operator has nothing to restore from.
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, payload] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("stream-call-type-default-preimage.json");
    expect(JSON.parse(payload)).toEqual({
      callType: "default",
      settings: LIVE_SETTINGS,
      notification_settings: LIVE_NOTIFICATIONS,
    });
  });

  it("does not report drift when only key ORDER differs", async () => {
    // Two independent getCallType reads. Key order between them is not
    // guaranteed, and a false positive here tells the operator Stream wiped a
    // config it never touched.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce({
        name: "default",
        grants: EXPECTED_GRANTS_AFTER(),
        // Same content, keys reversed.
        settings: { recording: { quality: "720p", mode: "available" } },
        notification_settings: LIVE_NOTIFICATIONS,
      });

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(code).toBe(0);
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  /**
   * #1270 — the blind spot in the post-apply guard.
   *
   * That guard confirms Stream STORED `join-call` on `call_member`, which it
   * always will, because the transform writes it a few lines earlier. It says
   * nothing about whether anybody HOLDS the role — and until the mint started
   * naming members `call_member`, the answer for every call created by the app
   * was no: the consultant was stamped `host` (not a role on this call type at
   * all) and everyone else `user`. A green run and a total video outage.
   */
  describe("pre-flight: somebody has to hold the role", () => {
    it("refuses to apply when no member of any open call holds call_member", async () => {
      openCallWithMembers(["host", "user"]);

      const code = await ensureCallTypeGrants({
        apply: true,
        restore: false,
        deployConfirmed: true,
      });

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("refuses a MIXED roster, where only some members hold it", async () => {
      // #1270 review — the check used to pass on one member anywhere holding
      // the role, which is exactly the shape that locks people out: `host` is
      // not a role on this call type at all, so after the write that member
      // cannot join a call they are entitled to. A guard against a partial
      // outage must not be satisfied by a partial result.
      openCallWithMembers(["host", "call_member"]);

      const code = await ensureCallTypeGrants({
        apply: true,
        restore: false,
        deployConfirmed: true,
      });

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("applies when EVERY member holds it", async () => {
      openCallWithMembers(["call_member", "call_member"]);

      const code = await ensureCallTypeGrants({
        apply: true,
        restore: false,
        deployConfirmed: true,
      });

      expect(code).toBe(0);
      expect(mockUpdateCallType).toHaveBeenCalled();
    });

    it("applies when there are no open calls to lock anyone out of", async () => {
      // A quiet app or a fresh environment. Refusing here would make the script
      // unrunnable rather than safe.
      mockQueryCalls.mockResolvedValue({ calls: [], next: undefined });

      const code = await ensureCallTypeGrants({
        apply: true,
        restore: false,
        deployConfirmed: true,
      });

      expect(code).toBe(0);
      expect(mockUpdateCallType).toHaveBeenCalled();
    });

    it("treats an unreadable roster as a refusal, not as an empty one", async () => {
      // A Stream outage must not be mistaken for "nobody holds the role", and
      // it must not be waved through either. The question went unanswered, so
      // the write does not happen.
      mockQueryCalls.mockRejectedValue(new Error("stream down"));

      const code = await ensureCallTypeGrants({
        apply: true,
        restore: false,
        deployConfirmed: true,
      });

      expect(code).toBe(1);
      expect(mockUpdateCallType).not.toHaveBeenCalled();
    });

    it("does not scan on a dry run", async () => {
      await ensureCallTypeGrants({
        apply: false,
        restore: false,
        deployConfirmed: false,
      });

      expect(mockQueryCalls).not.toHaveBeenCalled();
    });

    it("does not scan on a rollback", async () => {
      // --restore-user-join hands `join-call` BACK to `user`. It can only widen
      // access, so gating it on who holds `call_member` would block the very
      // command an operator reaches for when they are already locked out.
      openCallWithMembers(["host", "user"]);

      const code = await ensureCallTypeGrants({
        apply: true,
        restore: true,
        deployConfirmed: false,
      });

      expect(code).toBe(0);
      expect(mockQueryCalls).not.toHaveBeenCalled();
    });
  });

  it("restores join-call without handing back recording control", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: true,
      deployConfirmed: false,
    });

    expect(code).toBe(0);
    // Rolling the join change back is an availability rollback. Handing every
    // participant end-call and start-recording again is not part of that.
    expect(applied().user).toContain("join-call");
    expect(applied().user).not.toContain("start-recording");
    expect(applied().user).not.toContain("end-call");
  });

  it("restores end-call to call_member on a rollback, but only to call_member", async () => {
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });
    mockUpdateCallType.mockClear();

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: true,
      deployConfirmed: false,
    });

    expect(code).toBe(0);
    // This rollback exists for exactly one situation: the end route is not
    // actually serving traffic. In that situation a host has no way to close a
    // room at all, so restoring join without end-call would fix the lockout and
    // strand every host inside a call they cannot end.
    expect(applied().call_member).toContain("end-call");
    expect(applied().call_member).toContain("join-call");

    // Ordinary roles get join-call back and nothing else. Their end-call
    // revocation carried no availability risk, so undoing it would only re-open
    // the hole.
    expect(applied().user).not.toContain("end-call");
    expect(applied().guest).not.toContain("end-call");
    expect(applied().call_member).not.toContain("start-recording");
  });

  it("fails the ROLLBACK if Stream did not restore end-call to call_member", async () => {
    // Both post-write grant checks are gated on `!opts.restore`, so before this
    // the rollback path reached the settings comparison, found nothing moved,
    // and returned 0 — reporting success without asking whether the restoration
    // landed. That is the wrong way round: the rollback is the emergency path,
    // reached when the revocation has already locked people out.
    await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });
    mockGetCallType.mockClear();

    // A stale second read: Stream reports the post-revocation grants, i.e. the
    // restore did not take.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(EXPECTED_GRANTS_AFTER()))
      .mockResolvedValueOnce(mockCallType(EXPECTED_GRANTS_AFTER()));

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: true,
      deployConfirmed: false,
    });

    expect(code).toBe(1);
  });

  it("fails the run if Stream reads back end-call still on call_member", async () => {
    // The mirror of the join-call assertion. A silently-ignored revocation would
    // leave every attendee able to end a paid consultation while this script
    // printed a green tick — asserting the ABSENCE against returned data is the
    // only thing that catches it.
    mockGetCallType
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()))
      .mockResolvedValueOnce(mockCallType(LIVE_GRANTS()));

    const code = await ensureCallTypeGrants({
      apply: true,
      restore: false,
      deployConfirmed: true,
    });

    expect(code).toBe(1);
  });
});
