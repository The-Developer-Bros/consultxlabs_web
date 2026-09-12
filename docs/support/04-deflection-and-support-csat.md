# Deflection and support CSAT

"What fraction of conversations the tree resolves without a human" is the number that says whether the flowcharts work, and until #705 it was unanswerable even after the fact. Appointment-scope resolutions could only be inferred from thread status, and platform-scope resolutions persisted nothing at all, so a user whom the payments flow helped left no trace whatsoever. This page describes the counter that answers it, the caveat under which the answer is honest, and the two CSAT questions that sit beside it.

## The deflection counter

`SupportFlowOutcome` records one row per **terminal** support turn in both scopes, written by `recordFlowOutcome` in `lib/support/deflection.ts`. Each row carries the scope, the flow key, the terminal node id, the terminal's machine-readable `reason`, the outcome as `RESOLVED` or `ESCALATED`, and the user and organisation for attribution. It carries no message bodies: this is a counter, not a transcript.

Three design points are worth stating, because each of them looks like an unnecessary difference from what already exists. The outcome is not derived from thread status, because a thread is reused across intents and its final status therefore describes the last thing that happened to it rather than each flow run, and the platform scope has no thread to read at all. The `scope` field is a plain string rather than an enum, because it is a reporting dimension rather than a state machine and a third intake surface should not need a migration to be counted. And `recordFlowOutcome` never throws when called without a transaction: an analytics row must not be able to roll back the support turn that produced it, or a metric outage becomes a support outage.

`deflectionSince(since, where)` returns the resolved and escalated counts and the rate. The rate is `null` rather than `0` when nothing happened, because zero deflection and no traffic are different facts and a dashboard that conflates them lies.

**Read the number with its caveat.** Deflection alone scores a user who gave up exactly like a user who was helped: both leave a `RESOLVED` row and never contact a person. The counter is therefore only honest when read next to a re-contact signal, which asks whether this person came back within the next few days, and that is what the `[userId, createdAt]` index exists to serve. A deflection rate quoted on its own is a measure of how easy the tree is to abandon.

## The two halves of support CSAT

Support satisfaction is two different questions with two different suppliers, so it is two columns on two models rather than one number.

**Half one: did the self-serve tree help?** That is `SupportFlowOutcome.helpfulRating`, with `helpfulRatedAt` beside it. It is bound to the flow **terminal** rather than to a ticket, which is Uber's pattern and the only place the question is answerable at all: a `RESOLVED` outcome writes no ticket, so there is nothing else to hang it on.

**Half two: did a person fix it?** That is the resolution rating on the escalated case, which lands with the support-case unification designed on #1541. Until then, the deflection counter answers whether the tree resolved the problem and nothing yet asks the user whether a human did.

`helpfulRating` ships as a column with no prompt (#1546). That is deliberate and it is the repository's own doctrine: deferred implementation is fine and deferred _schema_ is not, because the push is the coordinated step.

### Why NULL must stay distinct from 1

`helpfulRating` is `NULL` when the question was not asked or not answered, and that has to remain distinguishable from a rating of 1. Deflection already scores a user who gave up as a success; reading an unanswered prompt as a bad one would swap that error for its mirror image. Every read of the column must therefore filter on `not null` before averaging, and a surface that renders it must show "not rated" rather than a one-star.

## Related

- [05-schema-reference.md](05-schema-reference.md) lists the `SupportFlowOutcome` columns.
- [02-the-grid.md](02-the-grid.md) places the deflection counter among the other objects.
- The equivalent private question about a _session_ is `AppointmentFeedback`, documented under [`docs/feedback/`](../feedback/README.md).
