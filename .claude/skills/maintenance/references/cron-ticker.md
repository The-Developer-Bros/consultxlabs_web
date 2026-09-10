# State-as-outbox and the Netlify ticker

This page covers how scheduled work runs in this repository: why there is no message broker or generic outbox table, how the Netlify scheduled ticker closes the gap GitHub Actions leaves, and the checklist for adding a new scheduled job.

## State-as-outbox (ADR 27)

No generic outbox table exists, because the durable state an outbox exists to provide already lives on the domain rows the platform writes anyway: `WebhookEvent` is an inbox with a processed flag, `OutboundWebhookDelivery` and `FailedEmail` are outboxes with their own retry state, and every money-bearing follow-up is keyed on a row that already exists — `Payment`, `Appointment`, `Refund`, `WalletTopUp`. A follow-up that must survive a crash is expressed as a nullable stamp on the row it belongs to, such as `Appointment.chatChannelEnsuredAt`, plus an idempotent ensure-step in an existing sweeper that checks the stamp before doing the work again. The missing piece this ADR closes was never a table; it was a scheduler reliable enough to re-check those stamps on a short interval.

## Every job has an HTTP twin

Every scheduled job under `jobs/**` has a corresponding route under `app/api/cleanup/*`, built by `lib/cron/cleanup-route.ts`, gated by a `CRON_SECRET` bearer token, and wrapped in the same `withCronLock` the GitHub Actions entrypoint uses. This is what makes a five-minute HTTP ticker possible at all: any caller that can POST with the secret can drive the exact same code path a scheduled workflow would, with the same locking guarantee.

`withCronLock` provides distributed mutual exclusion keyed `cron:lock:<jobName>`, with a fifteen-minute TTL by default and thirty-five minutes for the payout and reconcile family, because the same job can be entered three ways — the GitHub Actions schedule, a manual `workflow_dispatch`, and an authenticated HTTP call — and a job whose side effects are only partially idempotent must never run twice concurrently regardless of which entry point triggered it. A financial job additionally checks `abortIfMaintenance()` at its `jobs/**` wrapper (or `assertNotInMaintenance()` at its HTTP twin, which cannot call the process-exiting form) and exits during a DEGRADED or OFFLINE maintenance phase; a non-financial job exits only on OFFLINE.

## The Netlify scheduled ticker

`netlify/functions/cron-tick.mts` runs every five minutes and POSTs the ten latency-sensitive money sweeps — `sweep-stuck-webhook-events`, `cascade-refund-earnings`, `reconcile-refunds`, `abandoned-payments`, `reconcile-payment-status`, `reconcile-orphaned-confirmations`, `sweep-orphaned-topup-captures`, `dispatch-outbound-webhooks`, `sync-payment-earnings`, and `release-earnings` — with the cron secret and a six-second per-target timeout. This exists because GitHub Actions' sub-hourly schedules deliver roughly once every hundred minutes rather than once a minute (GitHub throttles scheduled workflows rather than dropping them outright), which ADR 22 first measured and the 2026-09-03 financial audit re-confirmed. The ticker narrows the worst-case recovery window for a crashed `after()` callback from about a hundred minutes to about five, with no new vendor, no new secret in the money path, and no new table to reconcile.

GitHub Actions is retained for daily and weekly business crons, for unbounded backstop runs of the same sweepers, and for manual dispatch with its run history. A Netlify tick and a GitHub Actions run of the same job cannot both proceed, because both go through the same `withCronLock`; the loser answers 409, which the ticker records as `lockHeld` rather than `failed`, because the run that lost the lock is a run that did not need to happen — the winner is already doing the same work. Only a response outside `200`, `207`, and `409` counts as `failed`.

## `?limit=` semantics

Every route the ticker invokes accepts an optional `?limit=`, read as a cap on the batch a single run may touch, defaulting to today's unbounded behaviour when the parameter is absent — a nightly GitHub Actions run still processes the whole backlog, while a five-minute tick stays inside its own budget. An unparseable value is refused with `400 INVALID_LIMIT`, and a value above the cap (500) is clamped to it, which is the shared `parseLimitParam` behaviour every ticker target uses; a route that silently swallowed a malformed bound and swept the defaults instead used to hide a broken caller behind a run that looked healthy (#1459). The ticker sends a per-target default of fifty, except `abandoned-payments`, which is sent ten, because its per-row cost includes a gateway cancel round trip rather than a database write alone, and at fifty it could not finish inside the six-second per-target timeout.

## Workflow concurrency groups

Every scheduled workflow also declares a workflow-level `concurrency: { group: ${{ github.workflow }}, cancel-in-progress: false }`, a second and redundant guard at the Actions layer that queues an overlapping run rather than killing one mid-flight; `withCronLock` remains the correctness guard underneath it, and `__tests__/maintenance/cron-lock-registry.test.ts` asserts the concurrency block is present on every scheduled entry so the two guards cannot drift apart (#1413). GitHub Actions allows one running and one pending run per concurrency group by default, and a newer run replaces the pending one rather than queuing behind it; the workflows that also accept `workflow_dispatch` add `queue: max` so a second manual trigger cannot silently displace one already waiting.

## Adding a scheduled job

Give it a `jobs/**` wrapper and a `scripts/**` or `lib/**` core; wrap the core in `withCronLock` with a deliberate `failMode` stated as a string literal rather than computed; call `abortIfMaintenance()` in the wrapper; add the job name to `FINANCIAL_JOB_NAMES` in `lib/maintenance-cron.ts` if it touches money, so it also exits on a DEGRADED maintenance phase; pick a cron minute no other job already uses; keep every module in the entrypoint's import graph free of `server-only`, because the HTTP twin under `app/api/cleanup/*` imports the same core directly; give the workflow every environment variable those modules read at import time; add the failure-notification step; and add a row to `docs/maintenance/04-cron-jobs-reference.md`. If the new job is latency-sensitive enough to need the five-minute cadence rather than the daily or weekly one, add it to the ticker's target list and give it a `?limit=` default sized to its own per-row cost.

## Sources

`docs/enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md`, `docs/maintenance/04-cron-jobs-reference.md`, `lib/cron/cleanup-route.ts`, `netlify/functions/cron-tick.mts`.
