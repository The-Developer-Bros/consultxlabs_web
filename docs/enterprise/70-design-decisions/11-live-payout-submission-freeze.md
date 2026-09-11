---
title: Live-payout submission freeze (ENABLE_LIVE_PAYOUTS)
band: 70-design-decisions
audience: sde4
status: live
last-reviewed: 2026-06-05
---

# ADR 11 — `ENABLE_LIVE_PAYOUTS` freezes only the gateway-submission step

## Context

The payout pipeline is long: earnings accrue from bookings, the batch job
claims `READY` earnings into an `OrganizationPayout` (or
`ConsultantPayout`), TDS and MSME deadlines are computed, the row advances
through a state machine, and finally a transfer is submitted to RazorpayX
and confirmed by a webhook. Of all those steps, exactly one is
irreversible: the gateway submission. Once `payouts.create` fires, real
money leaves the platform's RazorpayX balance, and you cannot un-send a
transfer — recovery is a clawback or a reversal, not a delete. The
platform needed to bring the entire pipeline up *before* it was safe to
move real money, both to prove the pipeline works against real accumulated
data and to keep the schema and reconcilers exercised. A flag that froze
the whole pipeline would prove nothing; a flag that froze nothing would
risk paying the wrong amount or recipient on an unproven path.

## Decision

`ENABLE_LIVE_PAYOUTS` (read as `process.env.ENABLE_LIVE_PAYOUTS ===
"true"`, surfaced as a constant in `lib/feature-flags.ts`) gates *only*
the gateway-submission step. Everything upstream runs for real regardless
of the flag: earnings accrue and become `READY`, `createOrgPayoutBatch`
claims them and writes a real `OrganizationPayout` with real aggregated
totals, `computeTdsForPayout` and `computeMsmePaymentDeadline` stamp real
`tdsAmountPaise` and `mustPayByDate`, the earnings flip to `PAID`, and the
audit log records the batch. The flag is checked in `processOrgPayout`
(`lib/payments/payouts/org-payout-service.ts`): when it is off, the
function does **not** submit to RazorpayX, and the actual
`submitOrgPayoutToGateway` call — a live RazorpayX POST carrying the
deterministic `payout_<id>` idempotency key — only happens after the
transaction commits *and* only when the flag is on. The submission
side-effect is deliberately placed after the transaction so a long network
call and its double-submit risk never sit inside a serializable
transaction; on a permanent 4xx the row is marked `FAILED` and earnings
released, on a transient error the cron retries with the same key.

The argument for this exact seam is that real data accumulates and the
entire pipeline is continuously proven — TDS arithmetic, batch claiming,
idempotency, audit, reconciliation — while the single irreversible action
stays off until a human flips one production variable. The go-live runbook
makes flipping that flag a de-risked, one-variable operation gated behind
a checklist and a sandbox smoke
(`scripts/smoke/org-payout-sandbox-smoke.ts` asserts that with the flag
off, `processOrgPayout` makes no gateway submission); see [live-payout
go-live runbook](../50-operations/06-live-payout-go-live-runbook.md).

A precise note on the frozen state, because the code and the runbook
describe it slightly differently. The runbook says a gated payout "freezes
at `PROCESSING`." That is the design intent and the consultant-side shape,
but the **org-payout** path was changed by #785 to leave the row at
`PENDING` while the flag is off: with no gateway submission there is no
webhook to advance or roll back the row, and `handle-stuck-payouts` only
queries `ConsultantPayout`, so claiming `PENDING → PROCESSING` would
zombie the org payout in `PROCESSING` forever. So `processOrgPayout`
returns early without claiming when the flag is off, and the row waits in
`PENDING` for the flag to flip. Readers reconciling the runbook against
the code should trust the code: org payouts park in `PENDING`, not
`PROCESSING`, under the freeze.

## Alternatives considered

We considered a single flag that disables the whole payout subsystem until
go-live. It lost because it proves nothing: with the pipeline dark, no
real earnings accrue into real batches, the TDS and MSME computations are
never exercised on production-shaped data, and the reconcilers have
nothing to assert. Go-live would then flip on an entirely unexercised
pipeline — the highest-risk possible cutover. Freezing only the last step
lets every other step earn confidence before any money moves.

We considered guarding the submission with a per-payout manual approval
instead of a global flag — require a human to approve each transfer. It
lost as the wrong granularity for a go-live gate: it conflates the
steady-state approval workflow (which the consultant path already has via
auto-approve thresholds) with the one-time "is the live path proven yet?"
question. A single global flag answers the latter cleanly and is trivially
auditable (it is an env var that needs a redeploy to change, intentionally
not a runtime toggle), whereas per-payout approval would have to be torn
out once the path is trusted.

## Consequences

The real cost is reconciliation noise from parked rows. While the flag is
off, batches accumulate in a non-terminal state — `PENDING` for org
payouts (per #785), the intended `PROCESSING` for the consultant path —
and the reconciler and any "stuck payout" tooling have to treat that
population as expected rather than as an incident. Earnings sit `PAID`
against payouts that have not actually paid, which is correct under the
freeze but is a state an unaware operator could misread. The
split-behaviour between the org path (`PENDING`) and the runbook's stated
`PROCESSING` is itself a small cost: the documentation and the code
disagree until the runbook is corrected, and anyone debugging the freeze
has to know which to trust.

A second cost is that the flag is redeploy-gated, not runtime — flipping
it on (or rolling back) requires a deploy, so go-live and rollback are not
instantaneous. That is deliberate (it forces the change through CI and
makes it an auditable deploy event), but it means rollback can only stop
*new* submissions; already-submitted transfers settle via webhook and
can't be un-sent.

Revisit this decision once live payouts have run cleanly in production for
long enough that the freeze is pure overhead — at which point the flag can
be retired and the parked-state handling simplified. Before any high-value
(NEFT/RTGS) payout goes live, the known unhandled `payout.reversed` /
post-`processed` reversal gap (research bundle G) should be closed first,
since the freeze does nothing to protect against a transfer that completes
and is later clawed back by the beneficiary bank.
