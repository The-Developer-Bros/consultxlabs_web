---
title: Async and queue posture — no broker for launch, QStash as the named next step
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-11
---

# ADR 14 — Async work stays queue-less for launch; Upstash QStash is the pre-approved escalation

## Context

ADR 13 settled the concurrency-control question: state transitions are
guarded inside Postgres, and no message broker or workflow engine arbitrates
writes. This record settles the adjacent question that keeps resurfacing in
launch reviews: should background and deferred work go through a queue —
Kafka, BullMQ, Amazon SQS, or a hosted equivalent — before the platform takes
production traffic?

The asynchronous surface today has four tiers, all already shipped. Scheduled
work runs as GitHub Actions crons invoking `npx tsx jobs/**` directly
(ADR 05), with around fifty jobs covering reconciliation, billing cycles,
dunning, cleanup sweeps, and compliance clocks. Post-response work inside a
request uses Next.js `after()` — the Razorpay webhook route ACKs inside the
gateway's five-second window and processes the event afterwards. Crash
recovery for that tier is the sweeper pattern: `sweep-stuck-webhook-events`
replays any event whose `after()` callback died, and the payment/payout
reconcile crons re-derive money state from the gateway, so the durability
that a queue would normally provide comes from idempotent re-drives over
durable rows (`WebhookEvent`, reconcile sweeps) rather than from a broker.
Mutual exclusion and rate limiting ride Upstash Redis (ADR 07, the cron
locks, and the checkout/approval locks).

The pressure to add a queue comes from two real observations. First, a small
amount of work still runs inline in request handlers that does not need to:
payment-link emails send synchronously inside the consultation and
subscription approval routes, and Novu notification calls block some
responses. Second, the platform's stated ambition is hundreds of thousands of
concurrent users, and "we will need Kafka at that scale" is an easy claim to
make in the abstract.

## Decision

The platform launches with no message queue. Kafka, BullMQ, and SQS are all
rejected for the same structural reason: every one of them requires a
long-lived consumer process, and Netlify functions cannot host one. Adopting
any of them means standing up and operating a second compute platform
(a worker host on Railway, Fly, or EC2) before a single user has produced
the load that would justify it. Kafka additionally brings cluster operations
that a team of this size should not carry, and SQS brings an AWS surface the
stack otherwise does not touch.

When the platform outgrows the current tiers, the pre-approved next step is
**Upstash QStash**, not a broker. QStash is an HTTP push queue: it delivers
jobs to an ordinary route handler with retries, delay, and a dead-letter
queue, requires no worker process, and extends the Upstash dependency the
stack already carries rather than adding a new vendor. Two concrete triggers
authorise that adoption, and either one suffices:

1. **Notification fan-out exceeds the synchronous budget.** When sending the
   emails or Novu notifications for one request can no longer finish inside
   the function's remaining time after the database work — in practice, when
   a single action fans out to enough recipients that the send loop, not the
   transaction, dominates the response time.
2. **Webhook-processing SLO breach.** When the P95 time from gateway capture
   to booking confirmation exceeds the stuck-webhook sweep interval, meaning
   the `after()` tier plus sweeper re-drives no longer hide failures inside
   the latency users already tolerate.

Until a trigger fires, the only sanctioned change in this area is moving the
inline approval-route email sends behind `after()` — same pattern the webhook
route already uses, no new infrastructure.

## The actual ceilings

A queue does not raise any of the limits that will actually constrain this
stack, which is why it is not a launch prerequisite. The binding constraints,
in the order they will be hit, are:

- **Netlify function concurrency** — 125 concurrent invocations per site on
  the current plan, with a 10-second synchronous execution limit. This is
  the wall for "hundreds of thousands of concurrent users", and the remedy
  is response caching (#734), static/ISR rendering of browse surfaces, and
  an enterprise concurrency uplift — not queuing, which would only move the
  work somewhere a function still has to pick it up.
- **Supabase pooler client connections** — Supavisor caps client connections
  per compute tier, shared across functions and crons. The remedy is the
  pooled connection string everywhere (already the case), tier upgrades, and
  read caching.
- **Hot-row write contention** — concurrent bookings against the same slot
  serialize on the CAS WHERE clauses and SSI (ADR 13); the chaos runbook's
  scenario 6 watches the `withSerializableRetry` give-up rate as the launch
  metric. A queue would serialize these writes too — at the cost of making
  the conflict invisible until the consumer ran.

## The scaling ladder

When load grows, the steps are taken in this order, each unlocked by
observed telemetry rather than anticipation: response/read caching (#734) →
Netlify enterprise concurrency uplift → QStash for notification fan-out and
webhook processing (triggers above) → a dedicated worker tier, at which
point BullMQ becomes a reasonable choice because the process to host it
exists for other reasons. This ADR extends ADR 13 and does not reverse any
part of it; a PR that introduces a broker before the QStash triggers have
fired should cite the telemetry that justifies skipping the ladder.
