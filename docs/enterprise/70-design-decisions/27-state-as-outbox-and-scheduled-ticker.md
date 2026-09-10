---
title: State-as-outbox with a scheduled ticker
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-09-03
---

# ADR 27 — State-as-outbox with a scheduled ticker

## Context

ADR 14 kept the platform queue-less for launch; ADR 22 measured GitHub Actions delivering every sub-hourly schedule roughly once per hundred minutes and authorised QStash as the escalation. The 2026-09-03 financial audit asked for a transactional outbox for post-payment side effects (#1356), and the owner asked for an unbiased answer on whether one is needed.

Three facts settle it. First, the repo already has the durable state an outbox exists to provide: `WebhookEvent` is an inbox with a processed flag, `OutboundWebhookDelivery` and `FailedEmail` are outboxes with retry state, and every money-bearing follow-up is keyed on a domain row that already exists (`Payment`, `Appointment`, `Refund`, `WalletTopUp`). Second, every job under `jobs/` already has an HTTP twin under `app/api/cleanup/*` built by `lib/cron/cleanup-route.ts`, gated by `CRON_SECRET` and wrapped in the same `withCronLock`, so any scheduler that can POST can drive the fleet. Third, the only side effect that lacked a re-drive was Stream channel creation and its notification after a capture, and that is derivable from the appointment row.

So the missing piece was never a table. It was a scheduler that fires when it says it will.

## Decision

1. **Domain rows are the outbox.** No generic outbox table is added. A follow-up that must survive a crash is expressed as a nullable stamp on the row it belongs to (for example `Appointment.chatChannelEnsuredAt`) plus an idempotent ensure-step in an existing sweeper.
2. **A Netlify scheduled function is the ticker.** `netlify/functions/cron-tick.mts` runs every five minutes and POSTs the latency-sensitive sweep routes (stuck webhooks, refund cascade and reconcile, abandoned payments, payment-status reconcile, orphaned confirmations, orphaned top-up captures, outbound webhook dispatch, earnings sync and release) with the cron secret. Each route already holds a fail-closed Redis lock, so a ticker run and a GitHub Actions run cannot overlap; the loser answers 409 and that is expected.
3. **GitHub Actions stays** for daily and weekly business crons, for the unbounded backstop runs of the same sweepers, and for manual dispatch with its run history.
4. **Routes invoked by the ticker take a `limit`** so a single run fits inside the Next function ceiling of 26 seconds; the nightly Actions run remains unbounded.
5. **QStash remains the escalation**, not the default. Its triggers are unchanged from ADR 14 and ADR 22: a notification fan-out that exceeds the synchronous budget, a measured webhook-processing SLO breach that a five-minute tick cannot close, or the Netlify scheduler proving as unreliable as Actions. Inngest and Temporal remain out on the criteria ADR 22 records.

## Consequences

The worst case for a buyer whose `after()` callback died falls from about a hundred minutes to about five, with no new vendor, no new secret inside the money path and no new table to reconcile. The trade-off is one more place that fires the fleet, which is why the ticker only ever hits routes that are already lock-guarded and idempotent, and why the cron heartbeat keeps watching the Actions side independently.

Anyone adding a follow-up to a money path should first ask which row already records the obligation and which sweeper already walks that row, and only then consider a new mechanism.

## Related

- ADR 05 (GitHub Actions crons), ADR 14 (queue posture), ADR 22 (measurements) — this ADR narrows their remedy, it does not reverse them.
- ADR 21 (single writer for payment confirmation) — the ticker never writes payment status; it only re-invokes the pipeline.
- #866, #1010 (QStash plan), #1356 (the outbox request this answers), #1246 (orphan gateway orders, still hygiene).
