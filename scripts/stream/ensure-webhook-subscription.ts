/**
 * #1134 — subscribe the Stream webhook to every event we actually handle.
 *
 * The live hook was subscribed to SIX event types while
 * `lib/stream/webhook-dispatch.ts` handles TEN. The four missing ones were never
 * delivered, so two whole features shipped as dead code:
 *
 *   call.session_participant_joined / _left  → MeetingAttendance was never
 *     written. `detect-consultant-no-shows` has been running daily against a
 *     permanently empty table, and #471/#472 were never actually unblocked.
 *   user.flagged / message.flagged           → every report written by the chat
 *     UI landed in a queue nothing fed.
 *
 * This is the second independent cause of the zero-attendance figure; the first
 * was the missing webhook secret. Fixing one without the other changes nothing
 * for attendance.
 *
 * Subscription state lived only in the Stream dashboard, which is exactly how it
 * drifted from the code silently. Keeping it in a script makes it reviewable and
 * re-runnable.
 *
 * Idempotent. Dry-run is the default — pass `--apply` to write.
 *
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --check
 *   npx tsx scripts/stream/ensure-webhook-subscription.ts --apply
 *
 * #1270 — the script used to return 0 no matter what it found, which is why it
 * could not be wired to anything. A drift detector that always exits green
 * detects nothing, and the drift it was written to find is precisely the kind
 * nobody goes looking for: subscription state lives in the Stream dashboard,
 * where a change leaves no trace in this repository. `--check` is the CI mode —
 * it never writes, annotates each finding for the Actions log, and exits
 * non-zero so the scheduled job goes red the day the live hook stops covering
 * what the dispatcher handles.
 */
import "dotenv/config";

import type { EventHook } from "stream-chat";

import { getStreamChatClient, isStreamConfigured } from "../../lib/stream-client";
import { HANDLED_EVENT_TYPES } from "../../lib/stream/webhook-events";

/**
 * `call.session_started` is subscribed even though the dispatcher does not
 * handle it yet: an unhandled event is a cheap no-op (the route returns
 * `handled: false` before doing any work), whereas an unsubscribed one cannot be
 * recovered after the fact. It is needed to record when a call ACTUALLY started
 * — every duration today is computed from the scheduled slot time instead.
 */
const ADDITIONAL_EVENT_TYPES = ["call.session_started"] as const;

/**
 * Code-unit ordering, stated explicitly.
 *
 * A bare `.sort()` already does exactly this for strings, but SonarCloud's
 * S2871 flags the missing comparator — and the remedy its message suggests is
 * `localeCompare`, which would be a real bug here rather than a style change.
 * These are event-type strings like `call.session_started` and
 * `message.flagged`: ICU collation treats `.` and `_` as ignorable punctuation
 * at the primary level, code units do not, so the two orderings genuinely
 * disagree. This sorted list is compared against the live hook's `event_types`
 * to decide whether an update is needed, so a locale-dependent order would make
 * that decision environment-dependent — the same failure mode as the DM channel
 * ids in #1134 P0-3. Do not "fix" this to localeCompare.
 */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const DESIRED_EVENT_TYPES = Array.from(
  new Set<string>([...HANDLED_EVENT_TYPES, ...ADDITIONAL_EVENT_TYPES]),
).sort(byCodeUnit);

/**
 * A hook we can address by id.
 *
 * The SDK declares `EventHook.id` optional because the id is server-generated —
 * you may omit it when creating one. Everything read back from `getAppSettings`
 * has one, but the type cannot say so, and `widened` is keyed by it.
 */
type IdentifiedHook = EventHook & { id: string };

/**
 * Event types are partitioned by PRODUCT, and a hook may only carry events from
 * its own.
 *
 * This is not a detail. The live app has exactly one hook, scoped to `video`,
 * and `updateAppSettings` refuses the whole write — atomically, so nothing
 * lands — if the payload gives it a chat event:
 *
 *   invalid event types for hook 44a1d716-…: event types
 *   [message.flagged user.flagged] do not belong to product 'video'
 *
 * The first version of this script had no concept of `product`. It reported all
 * five unsubscribed events as simply "missing", which read as one write away
 * from fixed, when two of them could never live on that hook at all. Chat
 * moderation would have stayed dead with the script reporting success.
 */
const CHAT_EVENT_PREFIXES = ["user.", "message.", "channel.", "member."];

function productFor(eventType: string): "chat" | "video" {
  return CHAT_EVENT_PREFIXES.some((p) => eventType.startsWith(p))
    ? "chat"
    : "video";
}

/**
 * Whether a hook may carry an event type.
 *
 * A hook with no `product` is treated as unconstrained: the field is optional in
 * the SDK, and refusing to widen a hook we cannot classify would be worse than
 * letting Stream reject it with a precise message.
 */
function hookAccepts(hook: EventHook, eventType: string): boolean {
  const product = (hook as { product?: string }).product;
  if (!product || product === "all") return true;
  return product === productFor(eventType);
}

/**
 * `dry-run` reports and exits 0 — the mode a human runs first to see what the
 * script would do. `check` reports, annotates and exits {@link DRIFT_EXIT_CODE}
 * when the live app does not cover every handled event; it is what CI runs.
 * `apply` is the only mode that writes.
 */
export type EnsureMode = "dry-run" | "check" | "apply";

/**
 * Distinct from 1 on purpose. 1 means the script could not evaluate drift at
 * all — Stream unconfigured, or no webhook hook to inspect — which is a
 * configuration failure of the RUNNER. 2 means it evaluated the app
 * successfully and there really is drift. Both fail the CI job, but the log
 * reader should not have to guess which of the two happened, because a missing
 * `STREAM_API_SECRET` on the runner and a narrowed hook in the dashboard need
 * completely different responses.
 */
export const DRIFT_EXIT_CODE = 2;

/** GitHub Actions annotation; a plain line anywhere else. */
function annotate(message: string): void {
  console.error(
    process.env.GITHUB_ACTIONS ? `::error::${message}` : `ERROR: ${message}`,
  );
}

export async function ensureWebhookSubscription(
  mode: EnsureMode,
): Promise<number> {
  const apply = mode === "apply";
  if (!isStreamConfigured()) {
    console.error(
      "Stream is not configured — set STREAM_API_KEY and STREAM_API_SECRET",
    );
    return 1;
  }

  const client = getStreamChatClient();
  const app = await client.getAppSettings();
  // Keep the COMPLETE list. `updateAppSettings({ event_hooks })` replaces the
  // whole array, so anything missing from the payload is deleted — including the
  // non-webhook hooks filtered out below (SQS, Pusher) and any second webhook
  // another integration owns. Widening one hook must not cost the others.
  const allHooks = app.app?.event_hooks ?? [];
  const hooks = allHooks.filter(
    (h): h is IdentifiedHook =>
      h.hook_type === "webhook" && typeof h.id === "string",
  );

  if (hooks.length === 0) {
    console.error(
      "No webhook hook configured on this Stream app. Create one in the dashboard\n" +
        "pointing at <origin>/api/stream/webhooks, then re-run this script.",
    );
    return 1;
  }

  let changed = 0;
  /** hook id -> its widened event_types. Applied in ONE write after the loop. */
  const widened = new Map<string, string[]>();
  /** Events no hook on this app is allowed to carry. */
  const unplaceable = new Set(DESIRED_EVENT_TYPES);

  for (const hook of hooks) {
    const current = new Set(hook.event_types ?? []);
    // A hook subscribed to "*" already receives everything.
    const receivesAll = current.has("*");

    // Only events this hook's product permits. Offering it anything else makes
    // Stream refuse the ENTIRE update, so one impossible event silently costs
    // every possible one in the same write.
    const eligible = DESIRED_EVENT_TYPES.filter((t) => hookAccepts(hook, t));
    for (const t of eligible) unplaceable.delete(t);

    const missing = eligible.filter((t) => !receivesAll && !current.has(t));
    const product = (hook as { product?: string }).product ?? "unscoped";

    console.log(`\nhook ${hook.id}  enabled=${hook.enabled}  product=${product}`);
    console.log(`  url: ${hook.webhook_url}`);
    console.log(`  subscribed: ${current.size}${receivesAll ? " (wildcard)" : ""}`);

    if (missing.length === 0) {
      console.log(`  ✅ already covers every handled ${product} event`);
      continue;
    }

    console.log(`  MISSING (${missing.length}):`);
    for (const t of missing) console.log(`    + ${t}`);
    if (mode === "check") {
      annotate(
        `Stream webhook drift: hook ${hook.id} (${product}) is missing ` +
          `${missing.length} handled event type(s): ${missing.join(", ")}. ` +
          `Run scripts/stream/ensure-webhook-subscription.ts --apply.`,
      );
    }
    changed++;

    if (!apply) continue;

    // Union, never replace — of the event TYPES. The hooks ARRAY is handled
    // once after the loop; writing here submitted an array of one and deleted
    // every other hook on the app.
    const next = Array.from(new Set([...current, ...missing])).sort(byCodeUnit);
    widened.set(hook.id, next);
    console.log(`  → will widen to ${next.length} event types`);
  }

  // Events with nowhere to go. This is a configuration gap the script cannot
  // close: creating a hook decides a public URL and starts real deliveries, so
  // it belongs to a human, in the dashboard, the same way the "no webhook at
  // all" case above does.
  if (unplaceable.size > 0) {
    const byProduct = new Map<string, string[]>();
    for (const t of unplaceable) {
      const p = productFor(t);
      byProduct.set(p, [...(byProduct.get(p) ?? []), t]);
    }
    console.error(
      `\n⚠️  ${unplaceable.size} handled event(s) have NO hook that may carry them.`,
    );
    for (const [product, types] of byProduct) {
      console.error(`\n  product '${product}' — no hook on this app is scoped to it:`);
      for (const t of [...types].sort(byCodeUnit)) {
        console.error(`    · ${t}`);
        if (mode === "check") {
          annotate(
            `Stream webhook drift: no '${product}' hook can carry ${t}, so the ` +
              `dispatcher handles an event that is never delivered`,
          );
        }
      }
      console.error(
        `  Create a '${product}' webhook in the Stream dashboard pointing at\n` +
          `  <origin>/api/stream/webhooks, then re-run. Until then these events are\n` +
          `  never delivered and the features behind them stay dead.`,
      );
    }
  }

  // One write, carrying every hook the app has. Two things went wrong with the
  // per-hook write this replaces. It submitted `[oneHook]`, which replaces the
  // entire `event_hooks` array — so a second webhook, or an SQS or Pusher hook,
  // was silently deleted. And doing it inside the loop meant each iteration
  // wrote a payload built from data read before the previous iteration's write,
  // so with two hooks to widen only the last would have survived.
  //
  // Latent today: this app has exactly one hook. It is the operator script for a
  // shared production Stream app with no rehearsal environment, so latent is not
  // good enough.
  if (apply && widened.size > 0) {
    const nextHooks = allHooks.map((h) => {
      const next = h.id ? widened.get(h.id) : undefined;
      return next ? { ...h, event_types: next } : h;
    });
    await client.updateAppSettings({ event_hooks: nextHooks });
    console.log(
      `\n✅ applied — ${widened.size} hook(s) widened, ${allHooks.length} preserved`,
    );
  }

  if (changed > 0 && !apply) {
    console.log("\n(dry run — re-run with --apply to write this to Stream)");
  }

  // An unplaceable event is drift in EVERY mode, `--apply` included: writing
  // cannot fix it, because the remedy is a new hook in the dashboard and that
  // decides a public URL. A run that widened one hook and left two chat events
  // undeliverable has not finished the job, and must not say it has.
  if (unplaceable.size > 0) return DRIFT_EXIT_CODE;
  // Missing-but-placeable events are drift only while nothing has written them.
  if (changed > 0 && mode === "check") return DRIFT_EXIT_CODE;
  return 0;
}

if (require.main === module) {
  const argv = process.argv;
  const mode: EnsureMode = argv.includes("--apply")
    ? "apply"
    : argv.includes("--check")
      ? "check"
      : "dry-run";
  ensureWebhookSubscription(mode)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("ensure-webhook-subscription failed:", err);
      process.exitCode = 1;
    });
}
