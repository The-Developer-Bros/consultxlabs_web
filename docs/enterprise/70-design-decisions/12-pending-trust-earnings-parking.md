---
title: PENDING_TRUST earnings parking for unverified INVOICE-funded orgs
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 12 — Earnings for unverified INVOICE-funded orgs park in `PENDING_TRUST`

## Context

A host organization can fund bookings on invoice terms (NET-30/60) rather
than prepaying a wallet — the org books now and is invoiced later. That
credit relationship is fine for a verified org, but it opens a fraud hole
during the window before verification. An organization can register, sit
in `PENDING_VERIFICATION`, and immediately have its members book sponsored
sessions with real consultants. Those sessions generate real consultant
earnings — a real liability the platform owes the consultant — while the
org has paid nothing and may never pay, because it has not yet been
verified and has no settled invoice. If the org then ghosts, the platform
is left having promised consultants money funded by an invoice that will
never be collected (#687, the invoice-fraud guard). The platform needed a
way to let unverified orgs *transact* (the pilot-before-verify sales
motion depends on it) without letting their unfunded bookings turn into
payable consultant liabilities until some trust signal arrives.

## Decision

Earnings accrued for a booking whose **sponsoring** org — the org that owes
the invoice, `payment.organizationId`, not the expert's HOST org — is
`PENDING_VERIFICATION` and has never paid an invoice are parked in a
dedicated `EarningStatus.PENDING_TRUST` instead of the normal `PENDING`.
The earnings service makes this decision **once** at accrual time
(`lib/payments/payouts/earnings-service.ts`): it reads the sponsoring org's
status, and if that org is `PENDING_VERIFICATION` it counts its `PAID`
`OrganizationInvoice` rows; only if that count is zero does it park. The
decision then applies to **every** row the booking writes — the consultant
earning, the primary org earning, and each collaborator-org earning — so
an unverified sponsor cannot let consultant *or* org money clear. (Keying
on the sponsor rather than the host is the fix for the earlier version,
which keyed on the expert's HOST org and parked only the org-share row.)
Upstream of accrual, the checkout path additionally hard-requires a
verified domain claim before the org may fund anything by INVOICE at all
(`assertVerifiedDomainOrThrow`), so an unverified sponsor cannot even
accrue the INVOICE debt without first proving domain ownership. The enum
carries the rationale inline
(`prisma/schema.prisma`, `EarningStatus.PENDING_TRUST`): "Without this
state, an unverified org could accumulate real consultant earnings and
ghost." A parked earning never reaches the payout pipeline, because that
pipeline only ever claims `READY` rows and `PENDING_TRUST` is upstream of
`PENDING`.

The release valve is the hourly `release-pending-trust-earnings` cron
(`jobs/cleanup/release-pending-trust-earnings.ts`, workflow
`release-pending-trust-earnings.yml`). It promotes `PENDING_TRUST →
PENDING` for any org that has since earned trust by one of two signals:
the org has transitioned to `ACTIVE` (an admin verified it), or the org
has paid at least one `OrganizationInvoice`. Once promoted to `PENDING`,
the earning re-enters the ordinary release-from-hold path (the regular
cron flips it to `READY` when `holdUntil` lapses) and pays out normally.
The two crons touch disjoint rows by design — the trust cron only handles
`PENDING_TRUST`, the hold cron only handles `PENDING` with a lapsed
`holdUntil` — so they are safe to run alongside each other.

The two trust signals are chosen because each independently demonstrates
the org is real money, not a ghost: admin verification is a human
attesting to the org's legitimacy, and a first paid invoice is the org
demonstrating it actually settles its bills. Either one is enough to
release prior accruals; the gate disengages quickly for any legitimate
org, so the `PENDING_TRUST` population is normally a handful of rows.

## Alternatives considered

We considered blocking bookings entirely for unverified orgs — no
sponsored sessions until verification completes. It lost on the sales
motion: the product deliberately lets an org pilot before it verifies, so
a prospective enterprise customer can run real sessions during evaluation.
Hard-blocking bookings kills that pilot-before-verify flow, which is a
core go-to-market lever, to close a fraud hole that a status gate on
*earnings* closes just as effectively without touching the booking
experience.

We considered letting the earnings accrue as ordinary `PENDING` and
instead gating at payout time — hold the payout if the funding org is
still unverified. It lost on where the liability lives: by payout time the
earning has already moved through the normal pipeline and may be
aggregated into a batch with legitimately payable earnings, so the
unverified-org check has to be threaded into the batch-claim logic and the
netting, which is far more error-prone than refusing to let the earning
become `PENDING` in the first place. Parking at accrual keeps the unfunded
liability cleanly quarantined in one status that the payout pipeline
simply never sees.

We considered a time-based release (auto-promote after N days regardless
of verification). It lost because elapsed time is not a trust signal — a
ghost org that waits out the timer is exactly the fraud we were guarding
against. The release must be tied to a *positive* signal (verification or
payment), not the mere passage of time.

## Consequences

The real cost is a consultant-visible payout delay for sessions delivered
to an unverified org's members: the consultant has done the work and the
earning exists, but it cannot pay out until the org earns trust, which the
consultant did not control and may not understand. That delay surfaces in
the consultant's arrangement view and has to be explained, because from
the consultant's side it looks like withheld pay. A second cost is the
extra status and the extra cron: `PENDING_TRUST` is a fifth pre-payout
state that every earnings consumer and the reconciler must account for,
and the release cron is one more scheduled job to keep healthy — though it
is a cheap walk precisely because the gate disengages fast for legit orgs.

Revisit this decision if the funding model changes so that invoice-funded
bookings require an upfront commitment (a signed contract or a deposit)
that itself constitutes sufficient trust — at which point the accrual-time
gate could key off that commitment instead of verification/first-payment,
or be removed if the commitment makes the ghost scenario impossible. Until
invoice-funded organizations can no longer ghost, the parking state stays.
