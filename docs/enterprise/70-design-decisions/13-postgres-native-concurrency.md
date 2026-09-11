---
title: Postgres-native concurrency control over message queues and workflow engines
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-10
---

# ADR 13 — Concurrency control is Postgres-native; no Kafka, RabbitMQ, Temporal, or Inngest

## Context

A staff-level audit of the enterprise subsystem (June 2026) examined every
state surface for races, crashes, and abuse: the `canSponsor`/`canHost`
capability axes, eleven lifecycle status enums, multi-tab settings editing,
cron concurrency, and webhook delivery. The recurring bug class it found was
read–check–blind-write: a route reads a row, validates a transition or an
invariant against that snapshot, and then writes unconditionally. Under
Postgres's default READ COMMITTED isolation, two concurrent requests can both
pass the check against the pre-image and both commit — two browser tabs could
disable `canSponsor` and `canHost` simultaneously even though the route
guards against ever having both false, and a concurrent admin action could
resurrect a terminal state (`TERMINATED` contract back to `ACTIVE`).

The audit also raised the build-versus-adopt question every growing system
hits: should the platform adopt a message broker (Kafka, RabbitMQ), a durable
workflow engine (Temporal, Inngest, Trigger.dev), or keep state in Postgres?
This document records the decision so it does not get re-litigated each time
an incident or a conference talk makes one of those tools look attractive.

## Decision

We do not adopt any message broker or external workflow engine at this stage.
Postgres remains the single source of truth for all state, and concurrency
control is layered onto it with four mechanisms, each matched to a different
contention profile.

**Layer 1 — status-CAS transitions.** Every lifecycle status move goes
through `lib/enterprise/transitions.ts`, which bakes the declarative
allowed-from set into the UPDATE's WHERE clause
(`updateMany({ where: { id, status: { in: ALLOWED_FROM[to] } } })`). Postgres
re-evaluates the predicate under the row lock, so two racing transitions
serialize and exactly one wins; the loser matches zero rows and surfaces a
409 `IllegalTransitionError`. The WHERE clause is the state machine —
app-level pre-checks remain only for friendly error text. Terminal states
appear in no allowed-from set, which makes terminal re-entry structurally
impossible rather than a matter of reviewer vigilance.

**Layer 2 — Serializable isolation with bounded retry.** Where an invariant
spans multiple rows (the capability wind-down checks count invoices,
assignments, experts, and payouts before allowing a flip), a CAS on one row
cannot help. Those transactions run at `isolationLevel: "Serializable"` and
are wrapped in `withSerializableRetry` (`lib/db/serializable-retry.ts`),
which retries only Prisma error P2034 with jittered exponential backoff and
maps exhaustion to a 503. Business rejections (409s) are never retried.
These call sites are rare and low-traffic by construction — settings and
governance changes, not checkout paths.

**Layer 3 — version-column optimistic locking.** Human-edited settings rows
(`Organization`, `OrganizationPayoutAccount`, `OrganizationSSOSettings`)
carry a `version Int @default(1)`. The client echoes the version it loaded;
the PATCH CASes on it (`updateMany({ where: { id, version } })`) and
increments, so a stale tab receives a 409 `VERSION_CONFLICT` with the current
version, and the dashboard shows a "settings changed elsewhere" dialog that
reloads the form. Capability flips require the version token; other fields
accept it optionally for back-compatibility. Status transitions do not need
version columns because they CAS on the status column itself.

**Layer 4 — Redis locks for cron mutual exclusion only.** Every cron job
entry is wrapped in `withCronLock` (`lib/cron/with-cron-lock.ts`, issue
#476), which takes a `cron:lock:<jobName>` lock via the existing
`acquireLock`/`releaseLock` helpers. Redis is never load-bearing for data
correctness — that is what layers 1–3 and the unique constraints are for —
it only prevents the wasteful and noisy double-runs that schedule overlap,
`workflow_dispatch` re-runs, and the GitHub-Actions-plus-HTTP double entry
can produce.

## Redis degradation policy

Upstash Redis is a separate failure domain from Postgres, so the lock layer
defines explicit behaviour for when it is absent or unreachable. Money jobs
(payouts, dunning, invoice generation, overage sweeps, earnings releases)
are **fail-closed**: with no real lock available they refuse to run, exit
non-zero, and the workflow's notify-on-failure step pages an operator —
a missed schedule is recoverable, an unlocked double-run of dunning emails is
not. Cleanup and alert jobs are **fail-open**: they run unlocked with a
warning, because their side effects are harmless to repeat. A held lock is
always a clean skip (exit 0 from GitHub Actions, HTTP 409 from the
CRON_SECRET routes) since the next schedule retries. Four jobs
(`process-payouts`, `create-payout-batch`, `approval-payments`,
`stream-sync`) keep their pre-existing internal resource locks from #620 and
are not double-wrapped.

## Why not the alternatives

**Kafka and RabbitMQ** solve high-throughput event distribution to long-lived
consumers. Netlify functions cannot host long-lived consumers at all — every
broker integration would require new always-on infrastructure — and Upstash
deprecated its serverless Kafka product over exactly this mismatch. At this
platform's event volume (well under one event per second), a Postgres jobs
table with `SKIP LOCKED` outperforms the operational cost of a broker by
orders of magnitude. The realistic trigger to revisit is sustained four-digit
events per second with multiple independent consumer groups needing replay,
which is not on any current roadmap.

**Temporal** is genuinely the strongest answer to "what if the server crashes
mid-workflow," but self-hosting it costs a meaningful fraction of a full-time
engineer plus a Cassandra/Postgres cluster, and Temporal Cloud adds an
external dependency and a per-action bill for flows that are currently two to
four steps long. Our flows fit the simpler pattern Temporal itself recommends
below its complexity threshold: state rows in Postgres with status columns,
idempotency keys, and reconcile sweepers that re-drive half-finished work
(`capturedAt` pre-stamps, orphan sweeps, stuck-payout handling). A crash
mid-transaction rolls back atomically; a crash between side effects is
re-driven by the sweepers.

**Inngest / Trigger.dev / QStash** are lighter, but each inserts a hosted
control plane between our cron triggers and our money flows. Inngest's
August 2024 outage froze all customer function execution for 46 minutes —
with DB-backed state and GitHub Actions crons, the equivalent failure mode
degrades to rows sitting in PENDING until the next scheduled run, which is
the failure mode we already handle.

The revisit thresholds, recorded so the next discussion starts from criteria
rather than vibes: adopt a durable workflow engine (evaluate DBOS, pgflow,
or Inngest first, Temporal Cloud second) when a business flow exceeds
roughly five sequential steps with waits measured in hours, or when sweeper
re-drive logic starts duplicating orchestration the engine would own; adopt
QStash or a queue when event volume sustains roughly 1k events/second or a
fan-out needs more than one consumer of the same stream. Kafka is
effectively never justified for this product shape.

## Consequences

Application code must use the helpers rather than ad-hoc writes: status
moves call the typed `transition*` wrappers, multi-row invariant checks run
Serializable with retry, settings PATCHes thread `expectedVersion`, and new
cron jobs wrap their core in `withCronLock` and classify themselves
fail-open or fail-closed. The unit tests in
`__tests__/enterprise/transitions.test.ts` assert every legal edge and that
terminal states appear in no allowed-from set, so widening a lifecycle is a
reviewed map change, not a scattered route edit.

There is no `prisma/migrations` directory — the schema is applied with
`db push` pre-MVP. That does **not** mean database-level CHECK constraints and
triggers are unavailable, and an earlier revision of this ADR wrongly said so
(corrected in #1132). They live in `prisma/sql/*.sql` and are applied by
`npm run db:sidecars`, which `npm run db:push` runs after the schema push;
`scripts/ci/check-db-sidecars.ts` fails CI if any declared object is missing
from the live catalog. So CAS WHERE clauses are the _first_ enforcement layer,
not the only one.

The live sidecars are the deferred `ledger_txn_balanced` CONSTRAINT TRIGGER, the
`slot_no_confirmed_overlap` GiST exclusion, and ~30 CHECK constraints. The trap
they guard against is `npm run db:push:schema`, which exists as a standalone
script and skips the sidecars entirely.

Follow-ups, none of which depend on adopting `prisma migrate`: add CHECK
constraints mirroring the terminal-state sets and the `canSponsor OR canHost`
invariant as defence in depth; extend version columns to `BillingAccount` and
`WebhookEndpoint` settings; thread `expectedVersion` through the SSO and
payout-account clients the way the settings page does. Adopting `prisma migrate`
remains the right move before the first paying tenant, but for reviewable schema
history and rollback — not because constraints are otherwise impossible.
