---
title: Contract lifecycle
band: 30-programs-and-lifecycle
audience: sde2
status: live
last-reviewed: 2026-06-05
---

# Contract lifecycle

This document covers the `Contract` state machine (DRAFT → ACTIVE → EXPIRED or TERMINATED), auto-renewal, the supersession chain that handles amend, renew, and replace, the end-early and terminate mutation guard with its in-transaction cascade, and which term fields lock once a contract is in use. It is for engineers touching contract CRUD, the renewal and expiry crons, or the program and assignment lifecycle that hangs off a contract, and it was last verified against code on 2026-06-05 (#779 §A).

A `Contract` is the negotiated commercial relationship between an org and the
platform. Every `Program` hangs off exactly one contract
(`Program.contractId`), and the [cycle engine](08-cycle-engine-and-rollover.md)
only rolls an assignment forward while its governing contract is `ACTIVE` —
so the contract state machine is the spine that the program/assignment
lifecycle is clamped to.

## State machine

```mermaid
stateDiagram-v2
  [*] --> DRAFT: POST /contracts (default)
  DRAFT --> ACTIVE: PATCH status=ACTIVE (signing)
  DRAFT --> [*]: DELETE (DRAFT-only, no programs)
  ACTIVE --> EXPIRED: effectiveTo passed (expire cron)\nor RENEWAL supersede
  ACTIVE --> TERMINATED: PATCH status=TERMINATED\nor AMENDMENT supersede
  ACTIVE --> ACTIVE: supersede → fresh successor (this row retires)
  EXPIRED --> [*]
  TERMINATED --> [*]
```

- **DRAFT** — created but not signed. Terms are still editable; the row can be
  hard-deleted (only while it has no programs and no invoices).
- **ACTIVE** — signed (`signedAt` stamped, status flipped to `ACTIVE`). Terms
  lock (see *Field locking* below); programs draw against it; invoices bill
  against it.
- **EXPIRED** — `effectiveTo` passed and the expiry cron flipped it, **or** a
  RENEWAL supersede retired it (the completed term ended). Soft enforcement:
  expiry does **not** take the org offline.
- **TERMINATED** — ended early by an operator, **or** retired by an AMENDMENT
  supersede (a live term replaced mid-flight).

`effectiveTo = null` means open-ended — it never auto-expires and the cycle
engine never clamps against it.

## Schema

```prisma
model Contract {
  id               String         @id @default(uuid())
  organizationId   String
  organization     Organization   @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  billingAccountId String
  billingAccount   BillingAccount @relation(fields: [billingAccountId], references: [id])
  purchaseOrderId  String?
  purchaseOrder    PurchaseOrder? @relation(fields: [purchaseOrderId], references: [id])

  status           ContractStatus @default(DRAFT)
  signedAt         DateTime?
  effectiveFrom    DateTime
  effectiveTo      DateTime?
  paymentTermsDays Int            @default(60)
  autoRenew        Boolean        @default(false)

  rateCardId     String?
  rateCard       RateCard?  @relation("ContractRateCard", fields: [rateCardId], references: [id])
  ownedRateCards RateCard[] @relation("RateCardOwnerContract")

  programs     Program[]
  subscription BillingSubscription?
  invoices     OrganizationInvoice[]

  /// #779 §A — amendment/renewal/supersession chain. The OLD row points forward
  /// here; the new row is a fresh Contract. Self-join answers "what replaced X?".
  supersededByContractId String?    @unique
  supersededByContract   Contract?  @relation("ContractSupersession", fields: [supersededByContractId], references: [id], onDelete: SetNull)
  supersededContract     Contract?  @relation("ContractSupersession")
  supersededAt           DateTime?
  supersessionReason     ContractSupersessionReason?
  /// #779 §A — set by the auto-renew cron so renewal is idempotent (claim gate).
  autoRenewedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([organizationId, status])
  @@index([effectiveFrom, effectiveTo])
}

enum ContractStatus {
  DRAFT
  ACTIVE
  EXPIRED
  TERMINATED
}

enum ContractSupersessionReason {
  AMENDMENT
  RENEWAL
  TERMINATION_REPLACEMENT
}
```

## Field locking — terms are committed once in use 🔒

Contract terms become read-only the moment the contract is committed.
`isContractTermsLocked` (`lib/enterprise/config-lock.ts`) returns locked when
`status !== "DRAFT"` **or** any invoice has been issued **or** any program
under it has a live (in-window) assignment. The locked term fields are:

```ts
// lib/enterprise/config-lock.ts
export const LOCKED_CONTRACT_FIELDS = [
  "billingAccountId",
  "effectiveFrom",
  "effectiveTo",
  "paymentTermsDays",
  "rateCardId",
] as const;
```

The PATCH route enforces a narrower runtime subset (`effectiveFrom`,
`effectiveTo`, `paymentTermsDays`) — editing any of those on a locked contract
returns `409 CONTRACT_TERMS_LOCKED`. `autoRenew` is deliberately **not** locked:
it's a forward-looking toggle that can't rewrite already-settled money, so an
operator can flip it on a live contract at will. The `GET` route returns a
`locked` boolean alongside the contract so the edit drawer disables the locked
inputs without a second round-trip. The rationale mirrors the
[RateCard bump](../10-money-and-ledger/05-booking-to-earnings.md) / program config-lock immutable
pattern: to change committed terms you **supersede**, you don't mutate.

## Supersession chain — amend / renew / replace

Contracts are immutable once in use, so the only way to change committed terms
is to **supersede**: mint a successor with the new terms, re-point the programs,
and retire the old row with the chain recorded. The OLD row points forward via
`supersededByContractId @unique` (that `@unique` is the double-run backstop —
a second supersede on the same contract hits `P2002`). The three supersession
reasons in the `ContractSupersessionReason` enum, and how each one treats the
successor and the old row, are laid out in the table below.

| Reason | Trigger | Successor `effectiveFrom` | Old contract → | Set by |
|---|---|---|---|---|
| `AMENDMENT` | mid-term terms change | now (cut-over) | `TERMINATED` | supersede route |
| `RENEWAL` | term rollover | old `effectiveTo` (same duration default) | `EXPIRED` | supersede route **or** auto-renew cron |
| `TERMINATION_REPLACEMENT` | system-set replacement | — | — | system only |

The supersede route (`POST /api/organizations/[orgId]/contracts/[contractId]/supersede`)
accepts **only** `AMENDMENT | RENEWAL` in its Zod body — `TERMINATION_REPLACEMENT`
is reserved for system-initiated replacements and is never client-settable.
In the supersede transaction:

1. Guard: the old contract must be `ACTIVE` (`409 CONTRACT_NOT_ACTIVE`) and not
   already superseded (`409 CONTRACT_ALREADY_SUPERSEDED`).
2. Create the successor (`status = ACTIVE`, `signedAt = now` — the supersede
   action *is* the signing event for the new terms). Omitted fields carry over
   from the old contract.
3. `program.updateMany({ where: { contractId: old } })` re-points every program
   to the successor — without this the cycle engine would see a non-ACTIVE
   contract at the next `periodEnd` and CLOSE the assignments instead of
   rolling them.
4. Stamp the old row: `supersededByContractId`/`supersededAt`/
   `supersessionReason`, and flip it to `TERMINATED` (AMENDMENT) or `EXPIRED`
   (RENEWAL).
5. Emit `CONTRACT_SUPERSEDED` audit.

**Invoices keep their old `contractId`** — the money trail stays on the term
that actually billed them.

## Auto-renew cron

`jobs/contracts/auto-renew-contracts.ts` (GitHub Action
`.github/workflows/auto-renew-contracts.yml`, daily `30 2 * * *` UTC) is the
unattended RENEWAL path. It runs **30 min before** the expiry cron so renewal
wins the race: a contract that's been superseded is no longer the governing
term, so leaving two ACTIVE contracts on one org would double-count billing.

Per contract due (`status = ACTIVE`, `autoRenew = true`, `autoRenewedAt = null`,
`effectiveTo <= now`):

1. **Claim** by stamping `autoRenewedAt` via a conditional `updateMany` (the
   gate doubles as the distributed lock; `count === 0` ⇒ another replica won →
   skip).
2. Mint the RENEWAL successor — same org / billingAccount / PO / payment terms /
   rate card, `effectiveFrom = old.effectiveTo`, `effectiveTo = old.effectiveTo +
   (old duration)`, `status = ACTIVE`, `autoRenew` carried.
3. Re-point programs to the successor (same reason as the manual path).
4. Stamp `supersededByContractId`/`supersededAt`/`supersessionReason = RENEWAL`
   and flip the **old** contract to `EXPIRED` in the same tx (not left ACTIVE
   for the expiry cron).
5. Emit `CONTRACT_AUTO_RENEWED` audit.

The renewal is a **fresh Contract** (supersession), not an in-place
`effectiveTo` bump — this keeps each term's invoices anchored to the term that
billed them. Idempotency: `autoRenewedAt` is the claim gate, and
`supersededByContractId @unique` trips `P2002` if two replicas slip past it
(caught + skipped cleanly).

### Worked example — Wipro's contract auto-renews

The seeded **Wipro** contract (SPONSOR, INVOICE-funded) carries
`autoRenew = true` with a 1-year term — so it's the canonical unattended-renewal
case. Say the term ran `effectiveFrom = 2025-07-01 → effectiveTo = 2026-06-30`.
On the night of 2026-06-30 the cron picks it up (`status = ACTIVE`,
`autoRenew = true`, `autoRenewedAt = null`, `effectiveTo <= now`) and, in one
Serializable tx, writes:

| Row | Field | Before | After |
|---|---|---|---|
| **old** `C₁` | `status` | `ACTIVE` | `EXPIRED` |
| | `autoRenewedAt` | `null` | `2026-06-30T02:30Z` (claim gate) |
| | `supersededByContractId` | `null` | `C₂.id` |
| | `supersededAt` | `null` | `2026-06-30T02:30Z` |
| | `supersessionReason` | `null` | `RENEWAL` |
| **new** `C₂` | `effectiveFrom` | — | `2026-06-30` (= old `effectiveTo`) |
| | `effectiveTo` | — | `2027-06-30` (= +same `durationMs`) |
| | `status` | — | `ACTIVE` |
| | `autoRenew` / `billingAccountId` / `paymentTermsDays` / `rateCardId` / `purchaseOrderId` | — | carried from `C₁` |
| **programs** | `contractId` | `C₁.id` | `C₂.id` (re-pointed `updateMany`) |

Then a `CONTRACT_AUTO_RENEWED` audit row lands. Two subtleties worth internalising:

- **The successor's `effectiveFrom` is the old `effectiveTo`, not "now"** — so
  there's no coverage gap and no double-counted day. `durationMs = oldTo − oldFrom`
  is preserved verbatim, so a 365-day term renews to another same-length term
  (`jobs/contracts/auto-renew-contracts.ts`).
- **Programs move; invoices don't.** The `program.updateMany` re-point is
  load-bearing: without it the [cycle engine](08-cycle-engine-and-rollover.md)
  would see a now-`EXPIRED` contract at the next `periodEnd` and CLOSE every
  assignment instead of rolling. Invoices keep their original `contractId` so
  each term's billing stays anchored to the term that produced it.

`autoRenewedAt` on the old row is the idempotency gate — a re-fired cron finds it
non-null and skips; a racing replica that slips past the gate trips
`supersededByContractId @unique` (`P2002`, caught + skipped). Flip Wipro's
`autoRenew` to `false` and the same night does nothing here — the expiry cron 30
min later flips `C₁ → EXPIRED` with no successor, and the cycle engine CLOSEs the
assignments (`AUTORENEW_OFF`).

## Expiry cron

`jobs/contracts/expire-contracts.ts` (GitHub Action
`.github/workflows/expire-contracts.yml`, daily `0 3 * * *`) flips any contract
still `ACTIVE` whose non-null `effectiveTo` has passed → `EXPIRED`. By the time
it runs, auto-renew has already moved anything renewable, so it only catches
non-renewing terms.

**Soft enforcement** — expiry does *not* take the org offline
(`requireOrgAccess` still honours the org). The effects are:

1. New subscription-invoice rolls only generate while the contract is `ACTIVE`
   (see `jobs/billing/generate-subscription-invoices.ts`).
2. The contract's `ACTIVE` programs → `EXPIRED` and their still-live
   assignments (`periodEnd >= now`) → `CLOSED` with `periodEnd` clamped to now,
   so members stop drawing from caps (in-flight bookings complete normally).
   History rows stay queryable for reconciliation.
3. The dashboard renders an expiry banner so operators renew.

Idempotent: the claim `updateMany WHERE status = ACTIVE` means a same-day re-run
or second replica is a no-op.

## End-early / terminate flow

Terminating a live contract is a guarded PATCH (`status = TERMINATED`) on
`/api/organizations/[orgId]/contracts/[contractId]` — **OWNER + canSponsor**.
The guard refuses to sever a money trail or orphan an entitlement:

- **Live-assignment block:** if any `ProgramAssignment` under the contract is
  still in its current cycle (`periodEnd >= now`), the PATCH returns `409` —
  *"Cancel the assignments first or wait for the cycle to expire."* Without this,
  checkout would 500 on the now-parentless assignment lookup. This is the
  dangerous-mutation guard pattern: a status precondition + a count block + an
  in-tx cascade (no `riskLevel` field exists anywhere).
- **Outstanding-invoice block:** if any invoice billed under the contract is
  `ISSUED` or `OVERDUE`, the PATCH returns `409 CONTRACT_HAS_OUTSTANDING_INVOICES`
  (with `counts`). DRAFT invoices haven't billed, so they don't block.

Once the guards pass, the **in-tx cascade** flips the contract's `ACTIVE`
programs → `EXPIRED` and their still-`ACTIVE` assignments → `CLOSED`, so nothing
is left drawing against a dead contract. A dedicated `CONTRACT_TERMINATED`
audit row is written.

`DELETE` is DRAFT-only (and only when the contract has no programs): an active
contract must be terminated via PATCH so the audit timeline keeps continuity.

### Walkthrough — Meridian Consulting cancels mid-term (fictional)

**Meridian Consulting** (a *fictional* SPONSOR org used only for the failure
path — not seeded) signed a 1-year LICENSED_SEAT contract and now wants out three
months in, while 40 learners still have live assignments and one ₹2L invoice is
`ISSUED`. An OWNER hits `PATCH …/contracts/[contractId]` with
`{ status: "TERMINATED" }`:

```mermaid
stateDiagram-v2
  [*] --> Live: ACTIVE contract; 40 live assignments; 1 ISSUED invoice
  Live --> Refused1: PATCH status=TERMINATED
  Refused1 --> Live: 409 — 40 active assignments\n(count is in the message)
  Live --> CancelAssignments: operator cancels assignments\n(assignment PATCH cancel=true)
  CancelAssignments --> Refused2: PATCH status=TERMINATED (retry)
  Refused2 --> Live: 409 CONTRACT_HAS_OUTSTANDING_INVOICES\n(counts.outstandingInvoices = 1)
  Live --> PayOrVoid: settle / void the ISSUED invoice
  PayOrVoid --> Terminate: PATCH status=TERMINATED (retry)
  Terminate --> Cascade: in-tx — programs ACTIVE to EXPIRED,\nassignments ACTIVE to CLOSED
  Cascade --> [*]: TERMINATED + CONTRACT_TERMINATED audit
```

Two refusals stand between the operator and termination, evaluated in this order
inside the PATCH transaction:

1. **Live-assignment block.** `programAssignment.count` where the program is on
   this contract and `periodEnd >= now` returns 40 → `409`, message *"Cannot
   terminate a contract with 40 active assignment(s) in the current cycle. Cancel
   the assignments first or wait for the cycle to expire."* (The count is in the
   message string; unlike the invoice block, this guard doesn't attach a
   structured `counts` object.) Without it, checkout would later **500** on the
   now-parentless assignment lookup.
2. **Outstanding-invoice block.** Any invoice billed under the contract that's
   `ISSUED` or `OVERDUE` → `409 CONTRACT_HAS_OUTSTANDING_INVOICES` **with**
   `counts: { outstandingInvoices: 1 }` so the UI can render the wind-down
   message. `DRAFT` invoices haven't billed, so they don't block.

Once Meridian cancels the 40 assignments and clears the invoice, the retried
PATCH passes both guards and the **in-tx cascade** fires: `program.updateMany`
flips this contract's `ACTIVE` programs → `EXPIRED`, `programAssignment.updateMany`
flips their still-`ACTIVE` rows → `CLOSED`, and a `CONTRACT_TERMINATED` audit row
records `ACTIVE → TERMINATED`. This is the canonical **dangerous-mutation guard**
shape — status precondition + count block + in-tx cascade — and note there is no
`riskLevel` column anywhere; the guard is the count query, not a flag.

## Design decisions & trade-offs

- **End-early guard vs free deletion.** A live contract can't be `DELETE`d at all
  (DRAFT-only) and can't be `PATCH`ed to `TERMINATED` while it has live
  assignments or owed invoices. The cost is operator friction — terminating
  Meridian above took three round-trips. The alternative (let any OWNER nuke a
  contract) trades that friction for orphaned entitlements (checkout 500s on a
  parentless assignment) and a severed money trail (an owed invoice with no
  contract behind it). The friction is deliberate: every wind-down step leaves an
  audit row, so the *why* of a termination is reconstructable.
- **`LOCKED_CONTRACT_FIELDS` scope — five locked, one open.** The predicate
  (`config-lock.ts`) locks `billingAccountId`, `effectiveFrom`, `effectiveTo`,
  `paymentTermsDays`, `rateCardId` — everything that could retroactively rewrite
  settled money. `autoRenew` is deliberately **excluded**: it only changes future
  behaviour, never an already-billed cycle, so an operator can flip it on a live
  contract freely. Note the PATCH route enforces a narrower runtime subset
  (`effectiveFrom`/`effectiveTo`/`paymentTermsDays` via `TERM_FIELDS`) —
  `billingAccountId`/`rateCardId` aren't PATCHable at all, so the broader constant
  documents intent while the route gates what's actually mutable. To change a
  locked term you **supersede**, you don't mutate.

### 🛠️ What this design survived

**Config-lock moved from contract-create to first-assignment.** The persistent
money-config lock (`#779 §B`, commit `4a6c2d76`) deliberately does **not** fire at
create time — `Program.configLockedAt` is stamped in the transaction that creates
the *first* `ProgramAssignment` (`assignments/route.ts:161`, an `updateMany` gated
on `configLockedAt: null` so a re-stamp on an already-locked program is a no-op
and the original lock instant is preserved). The contract analogue is the
`isContractTermsLocked` predicate: terms stay editable while the contract is
`DRAFT` with no invoices and no live assignments. Locking at create would have
meant a typo on a brand-new contract/program (wrong rate, wrong cap) was
unfixable except by supersession — heavy machinery for a row nothing has touched
yet. Locking at first-use keeps the "fix your typo" window open exactly as long as
it's safe, then slams shut the instant real money rides on the terms.

**Supersede-don't-edit became the only way to change committed terms.** CRUD
completeness (`#777 §B / #779 §A`, commit `e454d429`) landed the
`POST …/supersede` route precisely so there's a *legal* path to change locked
terms without mutating settled history. The decision: an in-place
`effectiveTo`/rate edit on a contract that's already billed would silently rewrite
the terms its invoices were issued under — a reconciliation landmine. Instead,
supersede mints a fresh successor (the new terms), re-points programs, retires the
old row with the chain recorded, and leaves invoices on their original
`contractId`. The `supersededByContractId @unique` is the double-run backstop:
a second supersede on the same row hits `P2002`. Auto-renew is the same machinery
run unattended.

## Route table

The contract routes and the role gate each verb enforces are listed below.

| Route | Verb | Role gate |
|---|---|---|
| `/api/organizations/[orgId]/contracts` | `GET` | MAINTAINER + canSponsor |
| `/api/organizations/[orgId]/contracts` | `POST` | OWNER + canSponsor + **requireActive** |
| `/api/organizations/[orgId]/contracts/[contractId]` | `GET` | MAINTAINER + canSponsor |
| `/api/organizations/[orgId]/contracts/[contractId]` | `PATCH` | OWNER + canSponsor |
| `/api/organizations/[orgId]/contracts/[contractId]` | `DELETE` | OWNER + canSponsor (DRAFT-only) |
| `/api/organizations/[orgId]/contracts/[contractId]/supersede` | `POST` | OWNER + canSponsor |

`POST /contracts` requires a verified/active org (`requireActive: true`) —
nothing should bind the platform to an org that hasn't cleared verification.
A LICENSE-funded contract may carry a flat-fee `BillingSubscription` at create
time (created atomically in the same tx).

## Related docs

- [Funding and programs](../00-foundations/03-funding-and-programs.md) — funding × program matrix
  that contracts sit above.
- [Organization lifecycle](../00-foundations/05-organization-lifecycle.md) — org-level states
  (verification, suspension) that gate contract creation.
- [Programs](02-programs.md) — the program/assignment accounting that hangs off
  a contract.
- [Cycle engine & rollover](08-cycle-engine-and-rollover.md) — how the contract
  state clamps assignment roll-vs-close.
- [Invoicing](../10-money-and-ledger/08-invoicing.md) — invoices that reference a contract and block
  its termination while outstanding.
