---
title: Capacity ladder — what breaks at 1k/10k/100k concurrent users
band: 50-operations
audience: sde3
status: live
last-reviewed: 2026-06-10
---

# Capacity ladder

This document records the June 2026 capacity research so scale decisions
start from criteria instead of anxiety. It complements ADR 13 (no message
queues or workflow engines at this stage) with the concrete numbers for when
that posture changes. The stack under discussion is Next.js on Netlify
Functions, Supabase Postgres behind the Supavisor pooler (Prisma uses the
pooled `DATABASE_URL`; `DIRECT_URL` is reserved for migrations), Upstash
Redis for rate limits and locks, and GitHub Actions for the cron fleet.

## Around 1,000 concurrent users — fine, with one asterisk (~$45/month)

Connection-pool arithmetic says roughly ten pooled connections serve a
thousand active users for an OLTP workload like ours, well inside the Pro
tier's pooler limits. The asterisk is documented in our own incident
history: the waitlist crons hit ETIMEDOUT at effectively zero user load
(#821, #814) because background jobs collided on the pooler (#709). The
first thing that breaks at this scale is not user traffic — it is our own
cron fleet stampeding the pooler. The #476 cron locks remove the collision
overlap; the residual actions are setting `connect_timeout=30` and
`pool_timeout=30` on the pooled connection string and re-running the
waitlist jobs to confirm.

## Around 10,000 concurrent users — Netlify's function concurrency breaks first (~$110/month)

Netlify allows 125 concurrent function invocations per site by default. A
checkout in this codebase is expensive — a Serializable transaction plus a
Redis lock with up to ten retries and multi-table writes — so invocations
are slow, and slow invocations eat the concurrency budget. At a P95 checkout
latency of one to two seconds, the platform caps at roughly 60 to 120
checkouts per second, and browse traffic shares the same budget. The ladder
here is: move heavy read paths to ISR and edge caching (the #734 work
doubles as capacity work), bump Supabase one compute tier, and negotiate the
Netlify concurrency limit. Two instruments become load-bearing at this
rung: the serializable-retry exhaustion rate (PostgreSQL SSI predicts 5–20%
conflict rates under contention, so `withSerializableRetry` giving up is
the early-warning signal) and pooler saturation.

## Around 100,000 concurrent users — the stack does not survive as composed, and that is fine

At this scale Netlify compute pricing becomes prohibitive, the pooler is
undersized by an order of magnitude, and realtime subsystems hit their
ceilings. The required moves are persistent compute (Railway, Render, or
EC2), a real job queue (BullMQ needs persistent workers, which is exactly
why it is wrong for us today and right after leaving serverless), a larger
Supabase tier with read replicas, and a CDN-fronted read path — roughly
$800 to $1,200 per month at entry. The migration is two to four weeks of
work when the traffic justifies it; pre-building it now would cost months.
The one cheap pre-commitment we make today is keeping all background work
behind the existing job-entry abstraction so the GitHub-Actions-to-queue
swap stays mechanical.

## Queue and broker posture

Standardize on Inngest or QStash for new async work if a queue is needed
before the persistent-compute move — introducing a second paradigm alongside
the existing GitHub-Actions cron fleet would be pure carrying cost. BullMQ becomes the
default at the persistent-compute rung. Kafka is not a conversation worth
having for this product before sustained six-figure events per second with
multiple independent consumer groups; revisit thresholds live in ADR 13.
