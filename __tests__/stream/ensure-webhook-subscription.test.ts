/**
 * @jest-environment node
 */

/**
 * #1134 — the operator script that widens the Stream webhook subscription.
 *
 * It exists because the live app was subscribed to six of the ten event types
 * the code handles, so attendance and chat moderation shipped dead even after
 * the missing webhook secret was fixed. It is run by hand against a shared
 * production Stream app that has no rehearsal environment, which is the reason
 * these cases are pinned rather than trusted.
 *
 * The bug these guard: `updateAppSettings({ event_hooks })` REPLACES the whole
 * array. Submitting `[theOneHookIWant]` therefore deletes every other hook on
 * the app — a second webhook another integration owns, or an SQS or Pusher hook,
 * neither of which even appears in the `hook_type === "webhook"` filter. Doing
 * it inside the per-hook loop compounded it: each write was built from data read
 * before the previous write, so with two hooks to widen only the last survived.
 */

const mockGetAppSettings = jest.fn();
const mockUpdateAppSettings = jest.fn();
const mockIsStreamConfigured = jest.fn(() => true);

jest.mock("../../lib/stream-client", () => ({
  // Wrapped rather than passed directly: the factory body runs while the
  // module under test is being imported, which is before this file's `const`
  // declarations have initialised. An arrow defers the reference.
  isStreamConfigured: jest.fn(() => mockIsStreamConfigured()),
  getStreamChatClient: jest.fn(() => ({
    getAppSettings: mockGetAppSettings,
    updateAppSettings: mockUpdateAppSettings,
  })),
}));

import {
  DRIFT_EXIT_CODE,
  ensureWebhookSubscription,
} from "../../scripts/stream/ensure-webhook-subscription";
import { HANDLED_EVENT_TYPES } from "../../lib/stream/webhook-events";

/** The live hook, subscribed to six of the ten handled types. */
const liveWebhook = {
  id: "hook_live",
  hook_type: "webhook",
  enabled: true,
  webhook_url: "https://familiarisenow.com/api/stream/webhooks",
  event_types: [
    "call.recording_started",
    "call.recording_stopped",
    "call.recording_ready",
    "call.recording_failed",
    "call.session_ended",
    "call.ended",
  ],
};

/** A hook this codebase does not own and must never destroy. */
const foreignSqsHook = {
  id: "hook_sqs",
  hook_type: "sqs",
  enabled: true,
  event_types: ["message.new"],
};

function appWith(hooks: unknown[]) {
  return { app: { event_hooks: hooks } };
}

/** The event_hooks array actually submitted to Stream. */
function submitted(): { id: string; event_types?: string[] }[] {
  const call = mockUpdateAppSettings.mock.calls.at(-1);
  if (!call) throw new Error("updateAppSettings was never called");
  return call[0].event_hooks;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateAppSettings.mockResolvedValue({});
});

describe("ensure-webhook-subscription", () => {
  it("is a dry run by default and writes nothing", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("dry-run");

    expect(code).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("widens the hook to cover every handled event type", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    await ensureWebhookSubscription("apply");

    const hook = submitted().find((h) => h.id === "hook_live");
    for (const t of HANDLED_EVENT_TYPES) {
      expect(hook?.event_types).toContain(t);
    }
  });

  it("PRESERVES a hook it does not own", async () => {
    // The one that mattered. `hook_sqs` is filtered out of the webhook loop
    // entirely, so a payload built from that loop would not mention it — and
    // updateAppSettings replaces the array, so it would be deleted.
    mockGetAppSettings.mockResolvedValue(
      appWith([liveWebhook, foreignSqsHook]),
    );

    await ensureWebhookSubscription("apply");

    const ids = submitted().map((h) => h.id);
    expect(ids).toContain("hook_sqs");
    expect(ids).toContain("hook_live");
    expect(submitted()).toHaveLength(2);
  });

  it("leaves the untouched hook's own event_types alone", async () => {
    mockGetAppSettings.mockResolvedValue(
      appWith([liveWebhook, foreignSqsHook]),
    );

    await ensureWebhookSubscription("apply");

    const sqs = submitted().find((h) => h.id === "hook_sqs");
    expect(sqs?.event_types).toEqual(["message.new"]);
  });

  it("widens two webhooks in a SINGLE write, so neither clobbers the other", async () => {
    const second = { ...liveWebhook, id: "hook_second" };
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook, second]));

    await ensureWebhookSubscription("apply");

    // One write. Per-hook writes meant the second payload was built from a read
    // taken before the first landed, so only the last hook's widening survived.
    expect(mockUpdateAppSettings).toHaveBeenCalledTimes(1);
    for (const id of ["hook_live", "hook_second"]) {
      const h = submitted().find((x) => x.id === id);
      expect(h?.event_types).toContain("call.recording_ready");
    }
  });

  it("never replaces a wildcard subscription with an explicit list", async () => {
    // A hook on "*" already receives everything; rewriting it to ten named
    // types would NARROW it.
    mockGetAppSettings.mockResolvedValue(
      appWith([{ ...liveWebhook, event_types: ["*"] }]),
    );

    const code = await ensureWebhookSubscription("apply");

    expect(code).toBe(0);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("refuses when the app has no webhook hook at all", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([foreignSqsHook]));

    const code = await ensureWebhookSubscription("apply");

    expect(code).toBe(1);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });
});

/**
 * #1270 — the exit code, which is the whole reason this script can now be a
 * scheduled drift detector rather than something a human remembers to run.
 *
 * Before this, every one of these cases returned 0. The scheduled job would
 * have gone green while the live hook carried six of the ten handled event
 * types, which is the exact state #1134 found in production.
 */
describe("ensure-webhook-subscription — check mode exit codes", () => {
  it("fails when the live hook is missing a handled event type", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    const code = await ensureWebhookSubscription("check");

    expect(code).toBe(DRIFT_EXIT_CODE);
    expect(mockUpdateAppSettings).not.toHaveBeenCalled();
  });

  it("passes when the live hook already covers every handled event", async () => {
    mockGetAppSettings.mockResolvedValue(
      appWith([{ ...liveWebhook, event_types: [...HANDLED_EVENT_TYPES] }]),
    );

    // `call.session_started` is subscribed on top of the handled list, so a
    // hook carrying only the handled types is still one short and must fail.
    expect(await ensureWebhookSubscription("check")).toBe(DRIFT_EXIT_CODE);

    mockGetAppSettings.mockResolvedValue(
      appWith([
        {
          ...liveWebhook,
          event_types: [...HANDLED_EVENT_TYPES, "call.session_started"],
        },
      ]),
    );

    expect(await ensureWebhookSubscription("check")).toBe(0);
  });

  it("fails when an event has no hook that may carry it — in EVERY mode", async () => {
    // Every handled event is `video`-scoped since #1270, so a `chat`-only hook
    // can carry none of them. `--apply` cannot fix this either: the remedy is a
    // new hook, which decides a public URL and belongs to a human. Reporting
    // success here is how a whole feature stays dead with the script saying it
    // is fine.
    const chatOnly = { ...liveWebhook, product: "chat" };
    mockGetAppSettings.mockResolvedValue(appWith([chatOnly]));
    expect(await ensureWebhookSubscription("check")).toBe(DRIFT_EXIT_CODE);

    mockGetAppSettings.mockResolvedValue(appWith([chatOnly]));
    expect(await ensureWebhookSubscription("apply")).toBe(DRIFT_EXIT_CODE);
  });

  it("still exits 1, not the drift code, when Stream is unconfigured", async () => {
    // The two must stay distinguishable: a missing runner secret and a
    // narrowed hook in the dashboard need completely different responses.
    mockIsStreamConfigured.mockReturnValueOnce(false);

    expect(await ensureWebhookSubscription("check")).toBe(1);
  });

  it("leaves the bare dry run green so a human can look without a red exit", async () => {
    mockGetAppSettings.mockResolvedValue(appWith([liveWebhook]));

    expect(await ensureWebhookSubscription("dry-run")).toBe(0);
  });
});
