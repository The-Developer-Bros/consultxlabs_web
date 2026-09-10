/**
 * B5 stuck-webhook sweeper (#785, task #10).
 *
 * The webhook routes return HTTP 200 synchronously BEFORE the `after()` callback
 * runs the money side-effects. If the process crashes mid-callback, the
 * WebhookEvent row is left `processed=false, error=null` and is NEVER re-driven —
 * Razorpay/Stripe stop retrying once they see the 200, and the 5-min staleness
 * window only fires on a redelivery that will never come. The result is the
 * highest-blast-radius zombie: PAID money with an ISSUED invoice, frozen ACCRUED
 * overages, uncredited wallet top-ups, frozen tentative appointments,
 * unpersisted chargebacks.
 *
 * This sweeper actively re-dispatches those stuck events through the SAME handler
 * routing the live route uses (processRazorpayWebhookEvent). The handlers are
 * idempotent (ledger idempotency keys + status guards), so a replay is safe:
 * it either completes the side-effects (recovered) or stamps the error
 * (surfaced for review) — either way the row is no longer stuck.
 */
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { processRazorpayWebhookEvent } from "@/app/api/webhooks/razorpay-dispatch";
import { processStreamEvent } from "@/lib/stream/webhook-dispatch";
import type { RazorpayWebhookEnvelope } from "@/schemas/webhooks/razorpay";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { TERMINAL_ERROR_PREFIXES } from "@/lib/webhooks/event-log";

/**
 * The terminal marker written when a deferred event ages past the give-up cap.
 *
 * The prefix comes from TERMINAL_ERROR_PREFIXES so the writer and the selector
 * below cannot drift. They used to be two string literals kept in sync by a
 * comment asking the next editor to remember.
 */
/** #1356 6.2 — deferrals past this count are no longer plausible arrival races. */
const DEFER_ALERT_THRESHOLD = 5;
/** #1356 6.2 — an event unprocessed this long has missed every ordinary retry. */
const ALERT_AGE_HOURS = 1;

function giveUpReason(provider: string): string {
  return provider === "stream"
    ? "gave up: Stream event never became processable"
    : "gave up: payment never arrived";
}

export interface SweepResult {
  success: boolean;
  scanned: number;
  recovered: number;
  stillFailing: number;
  // #813 — re-driven but still DEFERRED (row left processed=false/error=null by
  // a defer-sentinel handler, e.g. refund-before-capture): will retry next sweep.
  deferred: number;
  // #813 — deferred events that aged past giveUpAfterHours and were terminally
  // capped (processed=true, error='gave up: …' — see giveUpReason).
  gaveUp: number;
  errors: string[];
}

export interface SweepOptions {
  /** Skip events newer than this — avoids racing an in-flight after() callback. */
  staleMinutes?: number;
  /**
   * #812: No longer a hard lower bound on the scan — kept only as the threshold
   * past which we WARN that a stuck event has aged out of the old 72h window.
   * Sweeping is still safe at any age (idempotency keys + status guards), and
   * the archive retains failed rows 90d, so a lower floor here orphaned events
   * stuck between 72h and 90d (no actor). Defaults to the old 72h.
   */
  maxAgeHours?: number;
  /**
   * #813 — terminal cap for events a defer-sentinel handler keeps deferring (the
   * awaited row never arrives, e.g. a refund whose payment was never captured).
   * Past this age the sweeper force-marks them processed so they stop churning.
   * Defaults to 168h (7 days).
   */
  giveUpAfterHours?: number;
  limit?: number;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function sweepStuckWebhookEvents(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  return withCronLock(
    "sweep-stuck-webhook-events",
    { failMode: "closed" },
    () => sweepStuckWebhookEventsUnlocked(opts),
  );
}

async function sweepStuckWebhookEventsUnlocked(
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const staleMinutes = opts.staleMinutes ?? 6;
  const warnAgeHours = opts.maxAgeHours ?? 72;
  const giveUpAfterHours = opts.giveUpAfterHours ?? 168;
  const limit = opts.limit ?? 200;
  const now = Date.now();
  const staleBefore = new Date(now - staleMinutes * 60_000);
  const warnOlderThan = new Date(now - warnAgeHours * 3_600_000);
  const alertOlderThan = new Date(now - ALERT_AGE_HOURS * 3_600_000);
  const giveUpOlderThan = new Date(now - giveUpAfterHours * 3_600_000);

  // Stuck = after() crashed before markWebhookEventProcessed ran. Only razorpay
  // for now (stripe dispatch not yet extracted — tracked separately).
  // #812: No lower-age floor — events stuck between the old 72h floor and the
  // 90d archive window were left with no actor. Keep only the upper bound
  // (don't race in-flight after() callbacks via staleBefore); re-driving an old
  // event is safe (per-row idempotency keys + status guards).
  // A handler that THREW is also stuck, and until now nothing re-drove it.
  //
  // `markWebhookEventProcessed(eventId, error)` runs in the dispatch's
  // `finally`, so a thrown handler lands as `processed=true, error!=null`.
  // Razorpay already received its 200 (the route ACKs before processing) and
  // will not redeliver, and `logWebhookEvent`'s "previously failed, allow
  // retry" reset only fires on a redelivery that can never come. So the
  // sweeper's `processed: false, error: null` selector — which reads as "crashed
  // before we recorded anything" — silently excluded every handler that failed
  // loudly. A transient error inside handleRefundCreated meant the gateway had
  // refunded the customer and the platform kept no record of it: no Refund row
  // for cascade-refund-earnings to find, no `pending_` placeholder for
  // reconcile-pending-refunds, and this sweep looking the other way.
  //
  // Both shapes are re-driven now. Re-driving is safe for the same reason the
  // comment above already gives — per-row idempotency keys and status guards —
  // and `logWebhookEvent` resets an errored row before reprocessing it.
  const stuck = await prisma.webhookEvent.findMany({
    where: {
      // #1134 P1-2 — Stream events belong here too. The Stream route now
      // acknowledges before processing (its retry budget is 15 seconds
      // total, which a cold instance cannot fit), so a handler failure has
      // no redelivery to rescue it. This sweep is the only thing that will.
      provider: { in: ["razorpay", "stream"] },
      receivedAt: { lt: staleBefore },
      // #1205-triage — claim freshness rides the dedicated claimedAt column;
      // receivedAt stays untouched so give-up aging cannot be reset by our
      // own re-drives.
      AND: [
        {
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
      ],
      OR: [
        // Crashed before recording anything.
        { processed: false, error: null },
        // Recorded a failure. Nothing else will ever retry these. Bounded by
        // the existing give-up window so a deterministically-failing row
        // retries for a week and then stops, rather than churning until the
        // 90-day archive collects it. A row still failing after seven days
        // needs a human, not another attempt.
        {
          error: { not: null },
          receivedAt: { gte: giveUpOlderThan },
          // Never re-drive a terminal marker: our own give-up cap, or a
          // permanent failure stamped at dispatch (a payload that does not
          // match its schema will not match it in six days either).
          AND: TERMINAL_ERROR_PREFIXES.map((prefix) => ({
            NOT: { error: { startsWith: prefix } },
          })),
        },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });

  // #812: Surface events that aged past the old 72h window — these are exactly
  // the rows the previous lower bound would have silently orphaned.
  const aged = stuck.filter((ev) => ev.receivedAt < warnOlderThan);
  if (aged.length > 0) {
    console.warn(
      `⚠️  Sweeping ${aged.length} stuck webhook event(s) older than ${warnAgeHours}h ` +
        `(oldest: ${aged[0].eventId} @ ${aged[0].receivedAt.toISOString()}) — ` +
        `these were orphaned by the removed lower-age floor.`,
    );
  }

  // #1356 6.2 — page ONCE per run on the events that are quietly going nowhere.
  // The 72h console warning above only reaches whoever is reading logs, and the
  // 168h give-up cap is the point at which we abandon the event rather than a
  // point at which anyone is told. An event that has deferred five times, or
  // that has sat unprocessed for over an hour, has stopped being a transient
  // ordering artefact and is worth a human's attention while there is still
  // time to act on it.
  const stalling = stuck.filter(
    (ev) =>
      !ev.processed &&
      (ev.deferCount >= DEFER_ALERT_THRESHOLD ||
        ev.receivedAt < alertOlderThan),
  );
  if (stalling.length > 0) {
    Sentry.captureMessage(
      `sweep-stuck-webhook-events: ${stalling.length} webhook event(s) still unprocessed ` +
        `(deferCount >= ${DEFER_ALERT_THRESHOLD} or older than ${ALERT_AGE_HOURS}h)`,
      {
        level: "warning",
        tags: { subsystem: "payments", job: "sweep-stuck-webhook-events" },
        contexts: {
          stuckWebhooks: {
            count: stalling.length,
            events: stalling.slice(0, 20).map((ev) => ({
              eventId: ev.eventId,
              provider: ev.provider,
              eventType: ev.eventType,
              deferCount: ev.deferCount,
              receivedAt: ev.receivedAt.toISOString(),
            })),
          },
        },
      },
    );
  }

  const errors: string[] = [];
  let recovered = 0;
  let stillFailing = 0;
  let deferred = 0;
  let gaveUp = 0;

  for (const ev of stuck) {
    // Claim the row before re-driving: bump receivedAt conditioned on it
    // still holding the value we selected. Without this, two drivers (this
    // sweep and a slow live after() callback, or two overlapping entries)
    // could both re-run the same event. The Razorpay SDK now times out at
    // 30s per call, so "still alive past the staleness window" is rare —
    // but a claim makes sweep-vs-sweep double-drive impossible outright.
    const claimed = await prisma.webhookEvent.updateMany({
      where: {
        eventId: ev.eventId,
        OR: [{ claimedAt: null }, { claimedAt: ev.claimedAt }],
      },
      data: { claimedAt: new Date() },
    });
    if (claimed.count === 0) {
      console.log(
        `⏭️ Skipping ${ev.eventId} — claimed by another driver since selection`,
      );
      continue;
    }

    // WebhookEvent.payload stores only `event.payload`; the per-event schemas
    // also require the envelope's entity/account_id/contains/created_at, so
    // supply them — the handlers route on eventType + payload.* and never read
    // these. `contains` mirrors Razorpay (the payload's top-level entity keys).
    const payloadKeys = Object.keys(
      (ev.payload ?? {}) as Record<string, unknown>,
    );
    const envelope = {
      entity: "event",
      account_id: "swept",
      event: ev.eventType,
      contains: payloadKeys,
      created_at: Math.floor(ev.receivedAt.getTime() / 1000),
      payload: ev.payload,
    } as unknown as RazorpayWebhookEnvelope;

    try {
      if (ev.provider === "stream") {
        // Stream stores the whole event as the payload, so there is no envelope
        // to rebuild. processStreamEvent owns its own logWebhookEvent /
        // markWebhookEventProcessed bookkeeping, exactly like the Razorpay
        // dispatch below.
        const streamEvent = ev.payload as { call_cid?: string } | null;
        await processStreamEvent(
          ev.payload,
          ev.eventType,
          ev.eventId,
          undefined,
          { call_cid: streamEvent?.call_cid },
        );
      } else {
        // processRazorpayWebhookEvent catches handler errors and marks the row
        // processed (stamping error on failure) in its finally — so this both
        // re-runs the side-effects AND clears the stuck flag.
        await processRazorpayWebhookEvent(envelope, ev.eventType, ev.eventId);
      }
      const after = await prisma.webhookEvent.findUnique({
        where: { eventId: ev.eventId },
        select: { error: true, processed: true },
      });
      if (after?.error) {
        stillFailing++;
        errors.push(`${ev.eventId}: ${after.error}`);
      } else if (after && !after.processed) {
        // #813 — still the defer signature (processed=false/error=null): a
        // defer-sentinel handler left it for the next sweep. Terminally cap once
        // it ages past giveUpAfterHours so an unknown payment can't churn forever.
        if (ev.receivedAt < giveUpOlderThan) {
          await prisma.webhookEvent
            .update({
              where: { eventId: ev.eventId },
              data: {
                processed: true,
                // Provider-specific: this sweep now covers Stream as well as
                // Razorpay, and stamping a Stream session event "payment never
                // arrived" sends whoever reads the row looking for a payment
                // that was never involved.
                error: giveUpReason(ev.provider),
              },
            })
            .catch(() => {});
          gaveUp++;
          errors.push(`${ev.eventId}: ${giveUpReason(ev.provider)}`);
          console.warn(
            `🛑 Gave up on stuck webhook ${ev.eventId} (deferred since ${ev.receivedAt.toISOString()}, past ${giveUpAfterHours}h cap)`,
          );
        } else {
          deferred++;
          console.log(
            `⏳ Stuck webhook ${ev.eventId} still deferred — will retry`,
          );
        }
      } else {
        recovered++;
        console.log(`✅ Re-drove stuck webhook ${ev.eventId}`);
      }
    } catch (e) {
      stillFailing++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${ev.eventId}: ${msg}`);
      // The dispatch normally marks the row, but guard so a throw here can't
      // leave it stuck to be re-swept forever.
      await prisma.webhookEvent
        .update({
          where: { eventId: ev.eventId },
          data: { processed: true, error: `sweep-failed: ${msg}` },
        })
        .catch(() => {});
    }
  }

  return {
    success: true,
    scanned: stuck.length,
    recovered,
    stillFailing,
    deferred,
    gaveUp,
    errors,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
