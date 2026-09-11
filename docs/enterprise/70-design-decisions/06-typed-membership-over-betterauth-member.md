---
title: Typed Membership over BetterAuth's member table
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-05
---

# ADR 06 — Every gate reads the typed `Membership`, never BetterAuth's `member`

## Context

The platform uses BetterAuth, whose organization plugin maintains its own
`member` table to represent a user's membership in an organization. That
table is generic by design: it carries a free-form string `role` and has
no concept of the lifecycle states our compliance and governance rules
require. Meanwhile the enterprise layer needs to express things
BetterAuth's table cannot — a seven-value role enum with a strict rank
ladder, a membership status that distinguishes `SUSPENDED` from `REMOVED`
from `ERASED`, per-membership profile FKs (consultee vs consultant),
payout-recipient knobs, and a SCIM external-identity key. The decision was
whether to bend permission checks around BetterAuth's `member` row or to
maintain a typed sibling and gate exclusively on it.

## Decision

The enterprise layer maintains its own typed `Membership` model
(`prisma/schema.prisma`, `model Membership`) and *every* permission gate
reads it, never BetterAuth's `member`. The `Membership` row carries a
typed `role MemberRole` and `status MemberStatus @default(ACTIVE)`, the
role-specific profile FKs, `payoutRecipient`, the rate-card override, and
`externalScimId`, and it holds an optional `betterAuthMemberId` that
bridges to BetterAuth's row when one exists. `MemberRole` is the
seven-value enum (`OWNER`, `MAINTAINER`, `BILLING_ADMIN`, `MANAGER`,
`EXPERT`, `LEARNER`, `SUPPORT`) ranked by `ORG_ROLE_RANK` in
`lib/auth/role-ranks.ts`, and gates resolve through `isAtLeastRole` or the
dedicated `requireOrgBillingAdminOrOwner` disjunction. `requireOrgAccess`
rejects any membership whose status is not `ACTIVE`. When BetterAuth's SSO
plugin auto-provisions a user it writes only a bare `member` row; the
`customSession` hook in `lib/auth.ts` detects the missing typed sibling
(`findMany members WHERE membership IS null`) and mints the typed
`Membership` as `LEARNER`, so the rest of the codebase only ever reads the
typed row (see [JIT
auto-join](../20-iam-and-security/02-jit-and-session-refresh.md)).

The decisive capabilities the typed row buys are the role enum and the
status lifecycle. A free-string role means every gate is a string
comparison with no compiler help and no rank arithmetic; the enum gives
both, and lets `BILLING_ADMIN` sit at rank 70 between `MAINTAINER` (80)
and `MANAGER` (60) so a finance operator can do everything a manager can
plus the financial mutations, without renumbering anything
(`lib/auth/role-ranks.ts`). The status lifecycle is load-bearing for
compliance: `MemberStatus.SUSPENDED` returns a 403 without deleting the
row, `REMOVED` is a terminal tombstone retained for audit, and
`MemberStatus.ERASED` is the DPDP §12 tombstone the erasure pipeline sets
when a user exercises right-to-erasure — the row stays for financial-trail
integrity while the user identifiers are scrubbed. BetterAuth's `member`
table has no vocabulary for any of those states.

## Alternatives considered

We considered gating directly on BetterAuth's `member` table and storing
the role in its free-string `role` column. It lost on type safety and on
lifecycle. The free string means a typo (`"BILLNG_ADMIN"`) is a silent
runtime authorization bug rather than a compile error, and there is
nowhere to express `SUSPENDED` / `REMOVED` / `ERASED` — so a suspended
member could not be represented without overloading the role string or
deleting the row, and a DPDP erasure would have to *delete* the
membership, destroying the audit and financial trail it is legally
required to keep. Right-to-erasure specifically needs a row that survives
identifier scrubbing, which a delete cannot provide.

We considered extending BetterAuth's `member` table with extra columns
(status, profile FKs, payout knobs) rather than maintaining a separate
model. It lost because the BetterAuth table is owned by the auth library's
migrations and plugin behaviour; grafting compliance-critical columns onto
a vendor-managed table couples our governance schema to BetterAuth's
upgrade cycle and risks a plugin migration clobbering them. Keeping a
typed sibling with a one-way `betterAuthMemberId` bridge isolates our
schema from theirs.

## Consequences

The real cost is the dual-write and the reconciliation it implies: an
SSO-provisioned user has a BetterAuth `member` row and must get a typed
`Membership`, and the `customSession` JIT path has to mint the missing
sibling on first session load, inside a transaction, with a narrowed
`P2002` catch so a concurrent session-create race is tolerated but every
other failure surfaces (`lib/auth.ts`). If that bridge ever fails
silently, a user can hold a valid session but no typed membership and 403
on every org route — which is exactly the failure mode the narrowed catch
was introduced to make visible. There is also steady-state cost: two rows
per membership to keep coherent, and an FK that can dangle if BetterAuth
deletes its `member` row (the relation is `onDelete: SetNull`).

Revisit this decision only if BetterAuth's member model grows native typed
roles and a status lifecycle rich enough to express suspension and an
erasure tombstone — at which point the typed sibling could in principle
collapse into it. Given that DPDP erasure requires a
financial-trail-preserving tombstone that a generic membership table is
unlikely to model, that condition is not expected to be met soon.
