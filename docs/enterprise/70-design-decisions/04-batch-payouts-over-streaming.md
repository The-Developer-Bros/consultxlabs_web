---
title: Batch payouts over per-earning streaming
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 04 — Periodic idempotent payout batches over per-earning transfers

## Context

When a sponsored booking settles, the host organization accrues an
`OrganizationEarnings` row (and a consultant accrues a
`ConsultantEarnings` row). The platform owes that money out, net of
commission and TDS, through RazorpayX. The naive design is to fire a
gateway transfer the moment each earning becomes payable — a stream of one
transfer per earning. The alternative is to let earnings accumulate and
sweep them into one transfer per recipient per period. Two forces push
hard against streaming. First, India's tax-deducted-at-source regime is
computed *per period*, not per transaction: TDS under Section 194-O is a
rate applied to the payee's earnings, and computing and depositing it
correctly is a per-period, per-payee operation, not something you want to
recompute and round on every individual booking. Second, the RazorpayX
Payouts API has been hardened around idempotency and balance management in
ways that reward few large calls over many small ones — every
Create-Payout request has carried a mandatory `X-Payout-Idempotency`
header since 2025-03-15, and an underfunded account silently *queues*
payouts rather than erroring, so the fewer gateway calls you make, the
fewer idempotency slots and queued-balance edge cases you have to manage
(research bundle G, RazorpayX payout mechanics).

## Decision

Earnings settle in periodic, idempotent batches.
`createOrgPayoutBatch(orgId, periodStart, periodEnd, opts?)` in
`lib/payments/payouts/org-payout-service.ts` claims every `READY`
`OrganizationEarnings` row in the window that isn't already attached to a
payout, aggregates their gross / platform-fee / org-share / refund totals,
computes TDS once on the net (`computeTdsForPayout` on `netPayout =
orgShare − refunds`) and the MSME payment deadline once
(`computeMsmePaymentDeadline`), writes a single `OrganizationPayout` row,
and flips the claimed earnings to `PAID` — all inside one Serializable
transaction guarded by a Redis lock keyed on the org. The claim itself is
a conditional `updateMany` that only catches rows still `NULL` on
`orgPayoutId`, so even without the lock two batches cannot double-claim an
earning; the lock buys deterministic ordering and a clean error path. The
batch accepts an `idempotencyKey`; a cron retry with the same key
short-circuits to the existing payout (`alreadyExisted: true`) instead of
minting a duplicate, and a `P2002` race on that key is caught and resolved
to the winner. When the batch is eventually submitted to the gateway,
`submitOrgPayoutToGateway` passes a deterministic `payout_<id>`
idempotency key so a cron retry lands on the same RazorpayX slot and never
creates a second transfer.

The research findings strengthen the rationale concretely: one batch means
one idempotency key to manage per period rather than one per earning, TDS
is computed exactly once per period (matching how the statute reckons it),
and far fewer gateway calls means far fewer opportunities to hit the
per-mode transfer limits (IMPS caps at ₹5,00,000 per transaction) or to
leave money silently `queued` against an underfunded balance.

## Alternatives considered

We considered streaming — one gateway transfer per earning as it becomes
payable. It lost on three measured points. TDS would have to be computed
and rounded per earning and then somehow reconciled into a per-period
deposit, multiplying rounding error and making the Form 26Q filing a
reconstruction job. Gateway-call volume would scale with booking volume
rather than with recipient count, so a busy org would generate hundreds of
tiny transfers, each its own idempotency key and each its own
retry/failure surface — and each subject to the mode limits and the
queued-on-low-balance behaviour. And the per-transfer fixed costs and
minimums (RTGS has a ₹2,00,000 floor; sub-minimum transfers can't use the
cheapest rails) make many small transfers strictly worse economically than
one swept transfer.

We considered a hybrid — stream by default but coalesce only when amounts
are small. It lost as the worst of both: it keeps the per-transfer TDS and
idempotency complexity of streaming while adding a coalescing rule that
itself needs a period boundary, which is just batching with extra
branches. If a period boundary is unavoidable for TDS anyway, batch
outright.

## Consequences

The real cost is latency: a consultant or host org does not get paid the
instant an earning clears; they get paid on the period cadence (the org
batch cron runs weekly). Money sits as a `READY` earning, then as a `PAID`
earning attached to a `PROCESSING` payout, before it reaches a bank
account — a deliberate delay that has to be explained to recipients and
surfaced in the dashboard's "you have ₹X ready" eligibility probe
(`getOrgPayoutEligibility`).

A second cost is the reconciliation surface of the batch lifecycle. A
batch can fail at the gateway and have to *release* its earnings back to
`READY` (`markOrgPayoutFailedInternal` does exactly this, the inverse of
the claim), and that release path has to be exactly correct or earnings
are either double-paid or stranded. Batches also park in `PROCESSING`
while live submission is gated off, which the reconciler has to tolerate
(see [ADR 11](11-live-payout-submission-freeze.md)).

Revisit this decision if real-time payout becomes a product requirement
(instant consultant payout as a selling point) and the TDS regime can be
satisfied with per-transaction deduction plus a separate periodic true-up
— at which point streaming's latency advantage might outweigh its
reconciliation and tax cost. Until then the period boundary is forced by
how TDS is reckoned, and batching is the natural shape.
