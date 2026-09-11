---
title: Integer paise and basis points
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 02 — Integer paise for money, integer basis points for splits

## Context

The platform moves real money between buyers, host organizations,
consultants, and the tax authority, and it splits each booking three ways
(platform fee, org share, consultant share) according to a rate card. Two
representation choices had to be made before any ledger code was written:
how to store an amount of money, and how to store a percentage split. Both
choices are load-bearing because a single rounding error in either one
corrupts a balance the reconciler then flags as drift, and a money
platform that silently rounds is not trustworthy. The constraint that
drove the decision is that a split must sum to *exactly* the whole — the
platform's fee plus the org's share plus the consultant's share has to
account for every paise of the gross, with nothing created or destroyed in
the arithmetic.

## Decision

All money is stored as integer paise, never as a floating-point rupee
value and never as a decimal type. One rupee is one hundred paise;
`amountPaise: 50000` is ₹500. On the journal, `LedgerEntry.amountPaise` is
a `BigInt` so a balance can exceed the safe-integer range without losing
precision. All splits are stored as integer basis points (`bps`), where
10000 bps equals 100%. The rate-card model carries `platformBps`,
`orgBps`, and `consultantBps` as three `Int` columns
(`prisma/schema.prisma`, the rate-card split model), and the earnings
split computes each leg by integer arithmetic: `Math.floor((grossAmount *
resolved.platformBps) / 10_000)` and the same for the consultant share
(`lib/payments/payouts/earnings-service.ts`). When a collaborator pool has
to be apportioned, the per-collaborator share is converted back to bps
with `Math.round((split.share / totalConsultantPool) * 10_000)` and
persisted as `shareBps` so the applied split is itself an integer
(`lib/payments/payouts/earnings-service.ts`; `CollaboratorSplit.shareBps
Int @default(10000)` in the schema). Every earnings row also snapshots the
exact `platformBpsApplied` / `orgBpsApplied` / `consultantBpsApplied` it
was computed with, so payout reconciliation reads the frozen split off the
row rather than re-resolving the live card.

The reason bps wins over float percents is that `platformBps + orgBps +
consultantBps === 10000` is an *integer* equality that the system can
assert and that always holds, whereas the float equivalent `0.1 + 0.1 +
0.8 === 1.0` can quietly evaluate false. #772 deleted the old `Float
sharePercentage` columns for exactly this reason.

## Alternatives considered

We considered storing money as floating-point rupees. It lost because
IEEE-754 binary floats cannot represent most decimal fractions exactly, so
repeated addition of fee legs drifts, and the drift is unbounded over a
long-running balance. A ledger whose balances depend on the order in which
floats were summed is not a ledger.

We considered a decimal / `numeric` money type (Postgres `numeric`, or a
JS decimal library). Decimals are exact, so this was the serious
contender. It lost on the JS/Prisma/Postgres boundary: a `numeric` column
round-trips through Prisma as a `Decimal` object, which then has to be
marshalled across to JavaScript number math and back at every edge,
introducing a precision class that each layer can mishandle differently
and that serializes awkwardly to JSON. Integers cross all three layers
with no special handling, sort and aggregate at full database speed, and
cannot silently round. We pay for that with manual scaling — converting
rupees to paise at every input edge and back for display — and with
`BigInt` ceremony on the journal, which we accept because the alternative
reintroduces a precision type at every boundary.

We considered storing the split as a stored percentage (e.g. a `Float`
`sharePercentage` of `0.10`). It lost on the sum-to-whole constraint above
and on ambiguity: a bare percentage column does not say whether `10` means
10% or 0.1%, and three such columns are not guaranteed to total 100. Basis
points are unambiguous (10000 is the whole) and integer-summable.

## Consequences

The concrete cost is the scaling ceremony at every boundary: input
handlers multiply rupees by 100, display layers divide by 100, and the
journal carries `BigInt`, which is less ergonomic than a plain number and
needs explicit conversion in aggregations. A subtler cost is the
`Math.floor` in the split: flooring each leg can leave a one-paise
remainder that has to be assigned deliberately rather than lost, and the
earnings service has to clamp when a misconfigured card produces bps that
don't sum to 10000 (`lib/payments/payouts/earnings-service.ts` logs and
clamps in that case). That remainder-and-clamp logic is the price of
integer-only arithmetic; the benefit is that the reconciler can prove the
books with exact integer equality and never has to reason about
floating-point tolerance.

Revisit this decision only if the platform needs to settle in a currency
with a different minor-unit convention (more or fewer than two decimal
places), at which point "paise" stops being the universal unit and the
scaling factor has to become per-currency. The ledger is INR-only today
(the `LEDGER_ACCOUNT_NON_INR` guard enforces it), so that condition does
not yet hold.
