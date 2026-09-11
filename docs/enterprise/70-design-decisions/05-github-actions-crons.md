---
title: GitHub Actions crons over Netlify scheduled functions
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 05 — Scheduled jobs run as GitHub Actions, not Netlify scheduled functions

## Context

The platform has a large family of recurring jobs: release earnings from
hold, process the weekly payout batch, reconcile the ledgers nightly,
sweep abandoned top-ups, clean up stale invitations, dispatch outbound
webhooks, alert on MSME and dispute deadlines, and dozens more — there are
roughly fifty scheduled workflows under `.github/workflows/`. The
deployment target is Netlify (with Vercel as a fallback), and Netlify
offers scheduled functions, so the obvious place to put these jobs is
"where the app already runs." But these jobs are not request handlers;
several are long-running (the payout and reconcile workflows set a
30-minute `timeout-minutes`), several run heavy Prisma walks, and all of
them need to be observable, manually re-runnable, and retryable by an
operator during an incident. The question was where to schedule and run
them.

## Decision

Scheduled jobs run as GitHub Actions workflows. Each workflow is a YAML
file under `.github/workflows/` with a `schedule:` cron trigger
(interpreted in UTC) and a `workflow_dispatch:` trigger so any job can be
fired manually from the Actions tab. A workflow checks out the repo, sets
up Node, runs `npm ci` and `npx prisma generate`, and then executes the
job's TypeScript entry point directly with `npx tsx jobs/<area>/<job>.ts`
— for example `reconcile-ledgers.yml` runs `npx tsx
jobs/reconcile/reconcile-ledgers.ts`, and `process-payouts.yml` runs `npx
tsx jobs/payouts/process-payouts.ts`. Database and gateway credentials are
injected from repository secrets into the job `env`, and a `Notify on
failure` step fires on `if: failure()`. Schedules are deliberately
staggered across the hour (the `reconcile-ledgers` workflow runs at 03:45
UTC specifically to sit clear of the 03:00 jobs and ahead of the 04:00
invoice rollup) to keep the Supabase connection pooler from spiking.

In parallel, the same job logic is exposed as a set of `CRON_SECRET`-gated
HTTP routes under `app/api/cleanup/**` (and a few siblings). For example
`app/api/cleanup/release-earnings/route.ts` is a thin wrapper that checks
`authHeader === "Bearer " + CRON_SECRET` and then calls the same
`releaseEarningsFromHold` the job script calls, returning 401 otherwise.
These routes exist for manual triggering and for "an alternative cron
system" (their own docblocks say so); they are the gated HTTP entry point,
while the GitHub Actions workflows are the production scheduler and invoke
the job scripts *directly* rather than calling these endpoints over HTTP.
Both paths converge on the same underlying functions in `scripts/` and
`lib/`, so behaviour is identical regardless of entry point.

## Alternatives considered

We considered Netlify scheduled functions. They lost on three concrete
limits. First, observability: a Netlify scheduled function's run history,
logs, and manual re-trigger are weaker and more buried than the GitHub
Actions run list, where every cron run is a first-class entry with full
logs, a green/red status, a one-click "Re-run jobs," and
`workflow_dispatch` for ad-hoc runs — which is exactly what an operator
needs at 2am when a payout batch looks stuck. Second, execution-time
limits: serverless function platforms cap wall-clock time, and our
reconcile and payout jobs are explicitly provisioned for up to 30 minutes;
a function timeout in the middle of a payout sweep is a partial-completion
hazard we don't want. Third, portability: tying the scheduler to Netlify
would couple the cron layer to the host, whereas a GitHub Actions workflow
that runs `npx tsx jobs/...` runs anywhere the repo and the secrets do,
and survives the Vercel fallback without rewriting the scheduler.

We considered a hosted queue or a dedicated worker (a long-lived process
draining a queue). It lost on cost and operational weight: neither Netlify
nor Vercel offers a first-class queue without an extra paid tier, and at
the platform's volume an indexed table walk on a cron tick is sufficient
(the outbound-webhook worker makes the same argument in its own header).
Standing up a worker fleet to run fifty mostly-tiny jobs is
disproportionate.

## Consequences

The real cost is operational coupling to GitHub. If GitHub Actions is
degraded, the crons don't run, and there is no in-app scheduler to fall
back to automatically — recovery means firing the `CRON_SECRET` routes
manually or waiting. Failure notification is wired: every scheduled
workflow ends in a `Notify on failure` step calling
`scripts/ci/notify-ops-failure.sh`, which posts to Slack when
`SLACK_OPS_WEBHOOK_URL` is set and otherwise falls back to Sentry. For a
job classified as money-critical, having no sink configured at all is
itself a failure that exits non-zero, because a money job failing
silently is the outcome this whole mechanism exists to prevent. What the
pager cannot see is a run that never STARTS, which is what
`cron-heartbeat.yml` covers — see ADR 22 for the measured cadence that
made a dead-man's switch necessary.

A second consequence is the maintenance of two parallel entry points.
Because the workflows run `jobs/*.ts` directly and do *not* call the
`CRON_SECRET` HTTP routes, the two surfaces can drift if a fix lands in
one path's wrapper and not the other; the mitigation is that both delegate
to the same shared function, so the divergence is confined to the thin
wrapper. Note that this means the brief's mental model of "workflows
hitting `CRON_SECRET`-gated endpoints" is only half right: the gated
endpoints exist, but the workflows bypass HTTP and execute the scripts
in-process.

Revisit this decision if scheduled-job volume or runtime outgrows what a
shared-runner GitHub Actions job can do (for example, jobs that need to
run more often than every few minutes, where Actions' minimum scheduling
granularity and cold-start cost become the bottleneck), or if the host
platform ships a queue/worker tier worth migrating to. The
schedule-collision pile-ups at `:00` and `:15` are already tracked under a
follow-up cron-schedule-audit issue.
