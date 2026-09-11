---
title: Deterministic ledger-account IDs
band: 70-design-decisions
audience: sde4
status: live
last-reviewed: 2026-06-05
---

# ADR 03 — Deterministic composite IDs for ledger accounts

## Context

Every posting through `postLedgerTxn` names the accounts its legs touch by
*scope*, not by id: "the wallet account for this org," "the
consultant-payable account for this consultant," "the platform's cash
account." Those accounts have to exist before a leg can reference them,
and under concurrency several postings can be the first to touch the same
scope at the same instant — two simultaneous bookings against a brand-new
org both want to post to that org's `WALLET` account, which no row yet
represents. If the account row carries a random UUID primary key, "find or
create the account for this scope" becomes a read-then-write race: both
callers look up the scope, both miss, both insert, and now there are two
accounts for one scope and the org's balance is split across them. The
obvious fix — a unique constraint on the scope tuple plus an upsert — runs
straight into a Postgres gotcha, because the scope tuple contains nullable
columns.

## Decision

Ledger accounts use a deterministic composite string id derived from their
scope rather than a UUID. The id is computed by `ledgerAccountId(ref)` in
`lib/payments/ledger/post.ts` as `${kind}|${organizationId ??
"_"}|${consultantProfileId ?? "_"}|${currency}` — the account kind, the
org id (or the sentinel `_`), the consultant-profile id (or `_`), and the
currency, joined by pipes. Because the id is a pure function of the scope,
two concurrent posts to the same scope compute the *same* id, and account
creation becomes `db.ledgerAccount.upsert({ where: { id }, create: {…},
update: {} })` in `resolveAccountId`: the first writer creates the row,
every subsequent writer is a no-op update, and there is no window in which
two rows can represent one scope. The schema makes the id the primary key
(`model LedgerAccount { id String @id … }` in `prisma/schema.prisma`) and
the docblock on the model spells out why.

This sidesteps the Postgres nullable-unique gotcha directly. The model
does also carry `@@unique([organizationId, consultantProfileId, kind,
currency])` as a belt, but a Postgres unique index treats two `NULL`s as
distinct, so for platform-scoped accounts (both owners null) that index
does *not* dedupe — two platform `CASH` rows would both satisfy it. The
deterministic id is the suspenders that actually guarantee one row per
scope, because `CASH|_|_|INR` is a single concrete string that the
primary-key constraint deduplicates whether or not the owner columns are
null. The upsert keys on that id, not on the nullable tuple, so the dedupe
is real for platform accounts too.

The `currency` segment was added to the id by #783 (`c38b9631`). The
ledger is INR-denominated — Razorpay always settles in INR, `amountPaise`
is INR paise, and `displayCurrencyAtCheckout` is a cosmetic buyer label,
not the settlement currency — so in practice the segment is always `INR`
today. It is in the id ahead of need so that a future multi-currency
ledger does not have to migrate every account key; until that future
arrives, the `LEDGER_ACCOUNT_NON_INR` reconcile guard enforces INR-only,
and the `AccountRef.currency` docblock instructs callers to leave the
field unset so it defaults to INR.

## Alternatives considered

We considered random UUID primary keys with the scope tuple as a unique
constraint and a find-or-create helper. This lost on two counts. First,
find-or-create is a read-then-write race that needs either an advisory
lock or a retry loop to be correct under the concurrency that booking and
top-up flows actually produce. Second — and decisively — the scope tuple
has nullable columns (`organizationId` and `consultantProfileId` are both
null for platform accounts), and Postgres does not dedupe `NULL`s in a
unique index, so the very accounts most contended at startup (`CASH`,
`PLATFORM_FEE`) are exactly the ones the unique constraint fails to
protect. A deterministic id replaces both the race and the null hole with
a primary-key upsert.

We considered a UUID key plus a `COALESCE`-based partial unique index to
make the nulls dedupe. It lost as needless complexity: it makes the
constraint correct but leaves the upsert keying on a synthesized
expression rather than a plain key, and it does nothing for the
read-then-write race. The deterministic id solves the dedupe and the
idempotent-upsert problem with one mechanism.

## Consequences

The cost we pay is that the id encodes the scope, so it is effectively
immutable: you cannot re-parent an account to a different org or change
its currency without minting a new id, and any code that parses the id is
coupled to the `kind|org|consultant|currency` layout (the `|` delimiter is
now load-bearing and must never appear inside a segment). The ids are also
longer and human-legible rather than opaque, which is a feature for
debugging but means they leak the scope structure into logs.

A second consequence is that the `currency` segment is dead weight while
the ledger stays INR-only — every id ends in `|INR` and the reconciler
actively forbids anything else. That is deliberate forward-provisioning,
not an active capability.

Revisit this decision if the ledger genuinely goes multi-currency: at that
point the `currency` segment starts carrying real variance, the
`LEDGER_ACCOUNT_NON_INR` guard has to be retired, and the question of FX
conversion before posting (explicitly out of scope today per the
`AccountRef.currency` docblock) has to be answered before the
deterministic id can be trusted across currencies.
