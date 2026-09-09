/**
 * @jest-environment node
 */

/**
 * #1280 — the two app-level settings, and the probe that stands between them
 * and the webhook subscription.
 *
 * The values themselves are one line each. What needs pinning is the refusal:
 * `updateApp` takes a partial and Stream does not document whether the fields it
 * is not given are merged or replaced. The chat twin `channel.update()` IS a
 * full replace. This app's `event_hooks` is a single hook carrying the nine
 * video event types the entire webhook pipeline depends on, and losing it looks
 * exactly like the 2026-08-13 outage in which that pipeline had never processed
 * one event. So the script probes with a no-op write first and aborts if
 * anything moved — these cases are that abort.
 */

const mockGetApp = jest.fn();
const mockUpdateApp = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock("node:fs", () => ({
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  mkdirSync: (...a: unknown[]) => mockMkdirSync(...a),
}));

// Relative path, not the `@/` alias — the alias resolves to a different module
// instance under jest here, so the mock silently does not bind and the failure
// looks identical to a bad fixture.
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  getStreamVideoClient: jest.fn(() => ({
    getApp: mockGetApp,
    updateApp: mockUpdateApp,
  })),
}));

import { ensureAppSettings } from "../../scripts/stream/ensure-app-settings";

/** The live event hook, trimmed. Losing this is the disaster being guarded. */
const LIVE_HOOK = () => [
  {
    id: "44a1d716-b582-47f6-b325-944a3134c151",
    hook_type: "webhook",
    enabled: true,
    product: "video",
    webhook_url: "https://familiarisenow.com/api/stream/webhooks",
    event_types: [
      "call.ended",
      "call.recording_ready",
      "call.session_ended",
      "call.session_participant_joined",
      "call.session_participant_left",
      "call.session_started",
    ],
  },
];

const LIVE_APP = (over: Record<string, unknown> = {}) => ({
  app: {
    guest_user_creation_disabled: false,
    moderation_enabled: true,
    permission_version: "v2",
    revoke_tokens_issued_before: null,
    multi_tenant_enabled: false,
    cdn_expiration_seconds: 1209600,
    webhook_url: "",
    webhook_events: ["call.ended"],
    geofences: [],
    file_upload_config: { size_limit: 0 },
    image_upload_config: { size_limit: 0 },
    push_notifications: { version: "v2" },
    event_hooks: LIVE_HOOK(),
    ...over,
  },
});

/** Already hardened — what a second run sees. */
const HARDENED_APP = () => LIVE_APP({ guest_user_creation_disabled: true });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ensure-app-settings", () => {
  it("does not write at all when the guest door is already shut", async () => {
    mockGetApp.mockResolvedValue(HARDENED_APP());

    const code = await ensureAppSettings({ apply: true });

    expect(code).toBe(0);
    // The compression pin cannot be read back, so re-sending it on every run
    // would mean touching the document that holds `event_hooks` for a change
    // nobody can confirm. Idempotency is keyed on the readable field only.
    expect(mockUpdateApp).not.toHaveBeenCalled();
  });

  it("writes nothing on a dry run", async () => {
    mockGetApp.mockResolvedValue(LIVE_APP());

    const code = await ensureAppSettings({ apply: false });

    expect(code).toBe(0);
    expect(mockUpdateApp).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("probes with a no-op before the real write, and sends both settings in one request", async () => {
    mockGetApp
      .mockResolvedValueOnce(LIVE_APP()) // initial read
      .mockResolvedValueOnce(LIVE_APP()) // post-probe read: unchanged
      .mockResolvedValueOnce(HARDENED_APP()); // post-write read

    const code = await ensureAppSettings({ apply: true });

    expect(code).toBe(0);
    expect(mockUpdateApp).toHaveBeenCalledTimes(2);

    // The probe rewrites a field with the value it already has.
    expect(mockUpdateApp.mock.calls[0][0]).toEqual({
      moderation_enabled: true,
    });

    // One request carries both changes. Two requests would double the blast
    // radius for no gain, since the radius is per-request not per-field.
    expect(mockUpdateApp.mock.calls[1][0]).toEqual({
      guest_user_creation_disabled: true,
      enable_hook_payload_compression: false,
    });
  });

  it("aborts before the real write if the probe loses the event hook", async () => {
    mockGetApp
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(LIVE_APP({ event_hooks: [] })); // wiped by a no-op

    const code = await ensureAppSettings({ apply: true });

    expect(code).toBe(1);
    // Exactly one call: the probe. The real write must NOT follow.
    expect(mockUpdateApp).toHaveBeenCalledTimes(1);
    expect(mockUpdateApp.mock.calls[0][0]).toEqual({
      moderation_enabled: true,
    });
  });

  it("writes a pre-image to disk before it touches Stream", async () => {
    mockGetApp
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(HARDENED_APP());

    await ensureAppSettings({ apply: true });

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const [path, payload] = mockWriteFileSync.mock.calls[0] as [string, string];
    expect(path).toContain("app-settings.");
    // The pre-image is the only copy of a config Stream might have discarded.
    // It has to carry the hook, or there is nothing to restore from.
    expect(JSON.parse(payload).event_hooks).toEqual(LIVE_HOOK());
  });

  it("fails the run if Stream does not store the guest flag", async () => {
    mockGetApp
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(LIVE_APP()); // still false after the write

    const code = await ensureAppSettings({ apply: true });

    expect(code).toBe(1);
  });

  it("fails the run if the real write moves something it was not given", async () => {
    mockGetApp
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(LIVE_APP()) // probe clean
      .mockResolvedValueOnce(
        LIVE_APP({ guest_user_creation_disabled: true, event_hooks: [] }),
      );

    const code = await ensureAppSettings({ apply: true });

    // The intended change landed, and it still fails — because the webhook
    // subscription went with it, and a green tick here would hide that.
    expect(code).toBe(1);
  });

  it("refuses to write when the probe field is absent", async () => {
    // `AppResponseFields` types `moderation_enabled` as a required boolean, but
    // a type describes a contract, not what the wire returns. If it were ever
    // absent the probe body serialises to `{}` — Stream changes nothing, the
    // fingerprint matches, and the probe reports CLEAN having tested nothing,
    // then licenses the real write against the document holding `event_hooks`.
    // A probe that can silently pass is worse than no probe.
    mockGetApp.mockResolvedValue(
      LIVE_APP({ moderation_enabled: undefined as unknown as boolean }),
    );

    const code = await ensureAppSettings({ apply: true });

    expect(code).toBe(1);
    expect(mockUpdateApp).not.toHaveBeenCalled();
    // The pre-image is still written — it is the operator's record of the state
    // they were refused against.
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  });

  it("does not mistake key ORDER for a wiped config", async () => {
    // Two independent reads. Response key order is not stable, and a false
    // positive tells an operator their webhook subscription was just destroyed.
    //
    // The reorder has to happen on an object with MORE THAN ONE key, or the
    // test is vacuous: an earlier version reassigned the single-key
    // `file_upload_config`, which produces identical key order, so the
    // fingerprints matched under plain `JSON.stringify` and the case passed
    // with `canonical` deleted. The event hook has eight keys.
    const reordered = LIVE_APP();
    const [hook] = LIVE_HOOK();
    reordered.app.event_hooks = [
      Object.fromEntries(Object.entries(hook).toReversed()) as typeof hook,
    ];
    mockGetApp
      .mockResolvedValueOnce(LIVE_APP())
      .mockResolvedValueOnce(reordered)
      .mockResolvedValueOnce(HARDENED_APP());

    const code = await ensureAppSettings({ apply: true });

    expect(code).toBe(0);
    expect(mockUpdateApp).toHaveBeenCalledTimes(2);
  });
});
