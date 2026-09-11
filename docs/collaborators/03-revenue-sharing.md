# Collaborator Revenue Sharing — Detailed Guide

## Overview

When a webinar or class with accepted collaborators is paid for, settlement divides the money among all parties. Two properties define the current design: all share math is **integer** (shares are stored as basis points per #772 B5, amounts are paise), and the platform fee is taken **once off the gross** before the split — the pool that remains is what gets divided. This guide was rewritten on 2026-08-14 against `lib/collaborators/service.ts` and `lib/payments/payouts/earnings-service.ts`.

---

## Rules

The enforcement points for each rule are listed alongside it.

| Rule | Value | Enforcement |
| --- | --- | --- |
| Minimum host share | 10% of the pool | Collaborator total ≤ 9000 bps, validated inside a Serializable transaction at invite and update time |
| Share storage | Integer basis points (`revenueShareBps`; 2500 = 25%) | `pctToBps()` converts the percent API surface at the DB boundary (`service.ts:28`) |
| Platform fee | 20% of gross, floored, applied once | `PLATFORM_FEE_PERCENTAGE = 20` (`lib/payments/payouts/constants.ts:11`); floors per #778 §C-2 |
| Collaborator share | `floor(pool × bps / 10000)` | `calculateRevenueSplit()` (`service.ts:900`) |
| Host share | Pool minus the collaborator shares (the remainder) | The owner is the pool's designated residual party |
| Over-allocation | Σbps > 10000 throws | A mis-configured plan is refused rather than allowed to mint money |

---

## The split calculation

### Fee first, then the pool

`createEarningsFromPayment()` computes the marketplace fee by flooring 20% of the gross (the shaved paisa stays with the consultants), and the remainder is the **consultant pool**:

```
platformFeePaise = floor(gross × 20 / 100)
pool             = gross − platformFeePaise
```

When the plan is org-owned, the pool instead comes from the org rate-card split (`resolveOrgSplit`), and the org's cut is carved out before collaborators see anything. `calculateRevenueSplit(planType, planId, pool)` is then called **with the pool**, not the gross.

Taking the fee per party or once up front produces the same proportions in exact arithmetic; with integer floors they differ by paise, and the code's order of operations — fee first, floors per collaborator, owner absorbs — is the authoritative one.

### The division

`calculateRevenueSplit()` returns an empty array when the plan has no `ACCEPTED` collaborators, which routes settlement down the ordinary single-owner path. Otherwise each collaborator receives `floor(pool × revenueShareBps / 10000)`, and the owner receives the remainder. Flooring rather than rounding matters: `Math.round` on each share could overshoot the total and push the owner's remainder negative (#778 §C-2). If the stored bps sum exceeds 10000 the function throws.

### Worked example

A webinar sells for ₹1,000 (100000 paise) with an accepted co-host at 25% (2500 bps) and a moderator at 15% (1500 bps). The lead-in numbers land as follows.

```
Fee:   floor(100000 × 20 / 100)      = 20000 paise  (platform)
Pool:  100000 − 20000                = 80000 paise

Co-host:    floor(80000 × 2500/10000) = 20000 paise
Moderator:  floor(80000 × 1500/10000) = 12000 paise
Host:       80000 − 20000 − 12000     = 48000 paise  (remainder)
```

Every paisa is accounted for: 20000 + 20000 + 12000 + 48000 = 100000.

---

## Validation logic at invite and update time

`validateRevenueSharesTx()` (`service.ts:864`) sums `revenueShareBps` over the plan's `PENDING` and `ACCEPTED` collaborators (excluding the row being updated, when updating) and requires the total plus the new share to stay at or under `MAX_COLLAB_BPS` (9000). Both `inviteCollaborator()` and `updateCollaborator()` run this check **inside a Serializable transaction** together with the write (FIX B1), so two concurrent invitations cannot jointly break the cap.

`PENDING` counts toward the total deliberately: an unanswered 25% invitation reserves those basis points, otherwise the host could over-allocate by inviting several people whose shares overlap.

---

## ConsultantEarnings rows

Settlement writes one `ConsultantEarnings` row per party against the same `paymentId`; uniqueness is `@@unique([paymentId, consultantProfileId, role])`, and `paymentId` alone is only indexed. The money columns are BigInt paise. Continuing the example above (with no org settlement in play), the rows are:

```
Owner row:      role: OWNER,        grossAmount: 100000, platformFeePaise: 20000, consultantSharePaise: 48000, shareBps: 6000
Co-host row:    role: COLLABORATOR, grossAmount: 0,      platformFeePaise: 0,     consultantSharePaise: 20000, shareBps: 2500
Moderator row:  role: COLLABORATOR, grossAmount: 0,      platformFeePaise: 0,     consultantSharePaise: 12000, shareBps: 1500
```

The gross and the marketplace fee ride the owner's row only. `shareBps` is a **derived display cache** of each party's share of the pool: each row's value is floored and the last row absorbs the remainder so the cached values sum to exactly 10000 (#812) — the authoritative amounts are always the paise columns.

When the sponsoring org of the booking is an unverified INVOICE-funded org, every row is parked in `PENDING_TRUST` instead of `PENDING` until the org verifies or pays its first invoice (#687 E-02).

### Settlement to a collaborator's host org (#773)

Collaborations are org-blind (ADR 18): each collaborator's earnings resolve against **their own** HOST/HYBRID org's rate card, never the selling org's. For a collaborator with an active org rate card, `resolveOrgSplit()` decomposes their pool share into the card's fee slice (platform revenue), the org's cut (an `OrganizationEarnings` row), and the NET (what lands on their `ConsultantEarnings` row and is later paid out). An independent collaborator keeps the full share. If two settled parties would produce a second `OrganizationEarnings` row for the same (payment, org) pair, the collision is detected deterministically and the second collaborator simply stays unsettled — full share on `ConsultantEarnings`, no org accrual.

### The booking journal

The same transaction posts the balanced double-entry booking journal, keyed `booking:<paymentId>`: one `CONSULTANT_PAYABLE` credit per party mirroring the rows above, one `ORG_PAYABLE` per involved org, and the summed fee slices as a single `PLATFORM_FEE` credit. The cached rows must mirror the journal's legs — the reconciler alarms on `EARNINGS_LEDGER_DRIFT` otherwise — and a non-retryable posting failure re-throws so earnings and journal roll back together (#812).

---

## Payout processing

Each `ConsultantEarnings` row is processed independently by the payout system. All earnings carry a `holdUntil` timestamp; once released, payout batches group rows by `consultantProfileId`, so the host, the co-host and the moderator each receive their own payout with no cross-dependency:

```
Payout batch run:
  ├── Host:      earnings rows where consultantProfileId = host      → one payout
  ├── Co-host:   earnings rows where consultantProfileId = co-host   → one payout
  └── Moderator: earnings rows where consultantProfileId = moderator → one payout
```

---

## Refunds

`refundEarnings()` (`earnings-service.ts:1079`) reverses **every** row for the payment — `findMany` on `paymentId`, covering owner, collaborators, and any `OrganizationEarnings` rows. Partial refunds reverse proportionally using the shared integer-paise proration helper (#813): each party's clawback is floored, and because the buyer is made whole in full, the shaved paise are absorbed by the **platform**, never over-clawed from a consultant or an org (#778 §C-2). `refundedShareAmount` accumulates across successive partial refunds so no row is reversed past its share.

---

## Edge cases

The behaviors below are the ones tests should pin.

| Scenario | Behavior |
| --- | --- |
| No collaborators accepted | `calculateRevenueSplit` returns `[]`; the single-owner path writes one row with the full pool |
| Collaborator removed after payment | Existing rows remain; future settlements use the new split |
| Invitation declined while pending | The reserved share is freed; no earnings are ever created for a non-accepted collaborator |
| Rounding | Collaborator shares floor; the owner absorbs the remainder; `shareBps` caches sum to exactly 10000 via last-row absorption (#812) |
| Σ revenueShareBps > 10000 | Settlement throws — a mis-configured plan is refused |
| Free service (amount 0) | Shares floor to 0; nothing meaningful accrues |
| Refund on a collaborative service | All parties (and org accruals) reverse proportionally; platform absorbs the floored paise |
