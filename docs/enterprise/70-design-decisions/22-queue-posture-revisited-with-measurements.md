---
title: Queue posture, revisited with measurements
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-07-28
---

# ADR 22 — Queue posture, revisited with measurements

## Context

ADR 14 set the launch posture: no message queue, scheduled work on GitHub
Actions crons (ADR 05), post-response work inside `after()`, and Upstash QStash
pre-approved as the escalation on two named triggers — a notification fan-out
exceeding the synchronous budget, or a webhook-processing SLO breach. ADR 13
separately ruled out Kafka, RabbitMQ, Temporal and Inngest, on the grounds that
Netlify functions cannot host a long-lived consumer.

Issue #866 measured the fleet in June 2026 and found the schedule trigger
badly under-delivering. This ADR records a second measurement taken on
2026-07-28 across the money fleet, confirms the finding is stable rather than a
bad week, and re-tests the two engine rejections against what those products
look like now — because one of ADR 13's stated reasons has since stopped being
true.

## The measurements

Median gap between consecutive *scheduled* runs, from the Actions API, alongside
the median run duration:

| Workflow                         | Declared     | Measured gap | Duration |
| -------------------------------- | ------------ | ------------ | -------- |
| `dispatch-outbound-webhooks`     | every minute | **102 min**  | 60 s     |
| `cascade-refund-earnings`        | every 15 min | **101 min**  | 62 s     |
| `reconcile-pending-refunds`      | every 15 min | **98 min**   | 62 s     |
| `cleanup-abandoned-payments`     | every 15 min | **143 min**  | 60 s     |
| `reconcile-payment-status`       | every 30 min | **104 min**  | 64 s     |
| `sweep-orphaned-topup-captures`  | every 30 min | **104 min**  | 62 s     |
| `release-earnings`               | hourly       | **146 min**  | 62 s     |
| `sync-payment-earnings`          | hourly       | **138 min**  | 64 s     |
| `reconcile-ledgers`              | daily        | 1438 min     | 116 s    |
| `generate-subscription-invoices` | daily        | 1440 min     | 60 s     |

Two conclusions, and the second is the one that changes what to do about it.

**Sub-hourly schedules are not delivered.** An every-minute schedule fires about
once every hundred minutes. Daily and slower schedules are fine — they land
within a minute or two of their slot.

**Nothing overlaps.** Every job in the fleet completes in about sixty seconds,
so no workflow can collide with its own next tick or run long into another's
window. This matters because it rules out a whole class of remedy: concurrency
groups, longer timeouts and lock tuning address a problem this fleet does not
have. The defect is missed ticks, and no amount of overlap protection creates a
tick that never fired.

## Decision

**The posture stands. GitHub Actions keeps the daily and weekly business crons;
QStash remains the approved escalation for the latency-sensitive ones; Temporal
and Inngest remain out.** What changes is that ADR 14's webhook-SLO trigger is
now measured as tripped, so the QStash migration is authorised work rather than
a contingency — tracked in #866 and #1010, and deliberately shipped on its own
rather than inside a correctness change.

Until it lands, three mitigations reduce the blast radius of a fleet that runs
slower than it claims:

- `cron-heartbeat.yml` is a dead-man's switch. Every other alert fires on a run
  that failed; nothing fired on a run that never started, and GitHub disables
  scheduled workflows after 60 days of repository inactivity. Its tolerances are
  derived from the table above (sub-daily jobs alert after six hours of silence)
  so it catches a stopped fleet without flapping on ordinary throttling.
- `notify-ops-failure.sh` falls back to Sentry, because the Slack webhook it was
  written against has never been provisioned and every money-cron failure to
  date has been a `::warning::` in a log nobody reads.
- Money paths do not depend on sweeper latency for correctness. ADR 21 is the
  concrete instance: confirmation is driven by whichever path observes the
  payment first, so the sweeper is a backstop rather than the mechanism.

## Re-testing the engine rejections

**Temporal — still no, but the old reason has expired.** ADR 13 rejected it
because "Temporal workers need persistent processes — they don't work with
traditional serverless functions". That stopped being true in 2026: Temporal
shipped Serverless Workers that run on AWS Lambda, with no cluster to operate
([announcement](https://temporal.io/blog/introducing-temporal-serverless-workers-deploy-temporal-workers-to-aws-lambda)).
The rejection now rests entirely on economics and fit. Temporal Cloud starts at
**$100/month** for one million Actions ([pricing](https://docs.temporal.io/cloud/pricing));
this entire fleet is under 130,000 actions per month, so the floor alone exceeds
what the problem is worth, and each activity adds 50–200 ms of overhead.
Temporal's own guidance is that "a few background steps, a cron task, or a
simple webhook chain" sits below its threshold, which describes every flow here.
The verdict is unchanged; the *reason* is now cost and fit rather than
architecture, which matters because the architectural objection could have been
retired by a vendor release and quietly invalidated the decision.

**Inngest — the right tool, wrong problem.** Its free tier (50,000 runs/month)
covers this fleet, it integrates with Netlify without a worker tier, and its
step-level checkpointing — where a failed step resumes rather than restarting
the flow — is genuinely better than the sweeper-re-drive pattern used here. But
the measured defect is missed *schedule ticks*, and durable step execution does
not fix scheduling. QStash restores the cadence for roughly $1–5/month without
placing a hosted control plane between our cron triggers and our money flows,
which is the specific risk ADR 13 raised (citing Inngest's August 2024 outage
freezing customer function execution for 46 minutes).

Inngest becomes the correct answer when a money flow needs durable state across
hours rather than seconds. The concrete triggers, recorded so the next
discussion starts from criteria: a DPDP export that must chunk past Netlify's
15-minute background-function ceiling; a payout submission pipeline that needs
per-step retry and resume at volume; or any flow that grows past roughly five
sequential steps with waits measured in hours. That is ADR 14's Phase 2, and it
should be a new ADR when it happens.

**Kafka, RabbitMQ, BullMQ, SQS — unchanged.** All require a long-lived consumer
this platform has nowhere to run, at an event volume orders of magnitude below
where a broker pays for itself.

## Consequences

Anyone reading a sub-hourly `cron:` expression in this repository should read it
as an upper bound on frequency, not a promise. Design that depends on a
15-minute sweep landing within 15 minutes is design that will be wrong by a
factor of six. Where latency genuinely matters, drive the work at the event
(as ADR 21 does for payment confirmation) rather than scheduling a sweeper and
assuming it runs.

`scripts/ci/check-workflow-hygiene.ts` fails the build on a *recurring* start
collision — two workflows that both fire more than once a day at the same
minute. Collisions between two daily jobs are reported and tolerated, because at
this fleet's density no four-times-hourly schedule can dodge every daily job,
and a rule nobody can satisfy is a rule that gets disabled.

## Related

- ADR 05 (GitHub Actions crons), ADR 13 (Postgres-native concurrency), ADR 14
  (async queue posture) — this supersedes none of them.
- #866 — the June measurement and the per-job disposition of all 55 workflows.
- #1010 — the QStash installation.
- ADR 21 — why payment confirmation no longer depends on sweeper latency.
