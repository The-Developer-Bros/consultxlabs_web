---
title: "Enterprise Subsystem Simplification Proposal"
subtitle: "PR #655 closeout — what we can prune without touching the schema"
author: "Familiarise Engineering"
date: "May 2026"
superseded_by: "docs/enterprise/00-foundations/01-overview.md (absorbed by the #768–#779 audit series)"
band: 90-audits
audience: sde4
status: live
last-reviewed: 2026-06-05
toc: true
toc-depth: 2
---

> **Note (updated 2026-06-05):** This proposal's schema-finalization and
> cross-cutting recommendations were absorbed by the v0–v2 enterprise audit
> series (#768/#776/#777/#778/#779) — the schema is now frozen with reserved
> columns and dead enum values removed there. The earlier
> `docs/enterprise/simplification/SCHEMA-FINALIZATION.md` pointer is dead (that
> file was never landed); current authoritative docs are
> [`docs/enterprise/00-foundations/01-overview.md`](../00-foundations/01-overview.md) plus the
> root scorecards [`readiness-audit`](01-readiness-audit.md) / [`subsystem-checklist`](02-subsystem-checklist.md).
> This document remains useful as a historical record of the doc-dedup +
> dead-code + helper-consolidation recipes.

> **Note (2026-09-03):** The SCIM section below (A2, and every other
> reference to stubbing `lib/scim/` to a 501) is superseded. SCIM 2.0 has
> since shipped in full: `lib/scim/` implements Users CRUD, bearer-token
> authentication, group mapping and deprovisioning, and `ScimToken.expiresAt`
> is enforced on every request. The "zero customers using it, stub to 501"
> recommendation no longer applies to live code. This note closes #1373,
> which tracked the doc drift.

# Executive Summary

The enterprise subsystem (~614 changed files, ~13,500 LoC of code + 11,141 lines of docs) is **complex but not over-complex** — most of the apparent weight is load-bearing. However, two parallel surveys (one over the 47 enterprise docs, one over the code surface) identified **~2,800 lines of preventable bloat** that can be removed with zero schema changes and zero customer-visible behavior changes.

**Operating constraints for this proposal:**

- **Schema is final.** No new tables, no column changes, no index changes. Every recommendation respects this.
- **Algorithms are fluid.** Code paths, helpers, file layout, even runtime behavior can change in production with live customers.
- **Documentation is fluid.** Docs can be merged, deleted, restructured at will.

**Headline finding:** The complexity perception comes from three sources, in order of severity:

1. **Documentation duplication** — the same concepts explained 3-4 times across overlapping doc files (~1,233 lines reducible).
2. **Dead and premature code** — features wired in advance (SCIM, dead payout-service, dead feature flags) with zero current callers (~1,600 LoC removable).
3. **Helper proliferation** — three auth predicates where one capability matrix would suffice (~200 LoC).

**Recommended phased rollout:**

| Phase                               | Effort    | LoC saved | Risk   | Customer impact |
| ----------------------------------- | --------- | --------- | ------ | --------------- |
| **Phase 1 — Dead code & doc dedup** | 1 day     | ~2,100    | None   | None            |
| **Phase 2 — Helper consolidation**  | 2 days    | ~400      | Low    | None            |
| **Phase 3 — Optional refactors**    | 1-2 weeks | ~1,800    | Medium | None            |

Phase 1 is recommended for the PR #655 closeout. Phases 2 and 3 can land as follow-up technical debt PRs.

---

# Why the System Feels Complex

The enterprise subsystem composes from three orthogonal axes:

1. **Org shape** — two booleans (`canSponsor`, `canHost`) produce four shapes: SPONSOR, HOST, HYBRID, INERT (rejected)
2. **Funding source** — four enum values: PERSONAL, WALLET, INVOICE, LICENSE
3. **Program type** — two live values (LICENSED_SEAT, CREDIT_POOL) plus four reserved-but-gated (PROJECT, RETAINER, AOR, EOR)

This is **inherent product complexity**, not engineering bloat. An enterprise customer truly does need to choose along all three axes — Wipro is "SPONSOR + INVOICE + LICENSED_SEAT" and IIT Madras is "HYBRID + WALLET + CREDIT_POOL" and both are first-class use cases.

What the surveys identified is **incidental complexity** layered on top:

- **Three docs** explaining the three-ledger discipline (`07-payout-pipeline.md`, `09-wallet-and-ledger.md`, `18-three-ledger-discipline.md`) — they overlap by ~80%
- **Two payout service files** (`payout-service.ts`, `org-payout-service.ts`) — one of them has zero production callers
- **Full SCIM 2.0 implementation** (~534 LoC) — zero customers using it yet
- **Three role-check helpers** (`requireOrgAccess`, `requireOrgOwner`, `requireOrgBillingAdminOrOwner`) — they all answer "can this person do X?" but with different argument shapes

These are the kinds of weight a system accumulates during rapid pre-launch development. Now is the moment to shed it.

---

# Pillar 1 — Documentation Simplification

The `docs/enterprise/` directory holds **47 files / 11,141 lines** across 36 numbered docs, 3 explainers, 3 playbooks, 3 references, and the new closeout audit. Survey findings:

## A. The Ledger Hydra (high-impact merge)

The three-ledger concept is explained across **four documents** at conflicting detail levels:

| Doc                             | Focus                              | Lines | Issue                                                                |
| ------------------------------- | ---------------------------------- | ----- | -------------------------------------------------------------------- |
| `07-payout-pipeline.md`         | Org earnings + payout flow         | 189   | Repeats 18's invariants at 90% detail                                |
| `09-wallet-and-ledger.md`       | Wallet + funding ledger            | 163   | Defers to 18 for invariants but re-explains them                     |
| `18-three-ledger-discipline.md` | All three ledgers + reconciliation | 220   | Positioned at #18 — too late for the consumer who already read 07/09 |
| `20-payment-legs.md`            | Stackable legs                     | 118   | Adjacent concept, sometimes confused with ledger design              |

**Root cause:** PR #655 retrofitted the three-ledger model after 07, 09, 20 were already written; doc 18 was meant to be a capstone but reads like an internal contradiction.

**Action — MERGE 07 + 09 + 18 into one doc:** new `09-ledgers.md` (~400 lines, structured as: why three / usage ledger / funding ledger / settlement ledger / invariants + reconciliation / money-flow diagram). Cross-link 20 as "see Payment Legs for how legs feed the settlement ledger."

**Impact:** -2 doc files, -89 lines of pure duplication, eliminates the "which ledger doc do I read?" search tax.

## B. The Scenarios Duplication

Four customer scenarios (Wipro, LearnPro, IIT Madras, Rahul) appear in **three** places:

- `14-scenarios-and-examples.md` (212 lines) — for engineers
- `explainers/complete-guide.md` (2,623 lines, Part X) — for everyone
- `playbooks/billing-technical.md` (383 lines) — for tech sales

**Action — DELETE `14-scenarios-and-examples.md`.** Keep the scenarios only in `explainers/complete-guide.md` Part X. Link from `16-programs.md`.

**Impact:** -1 doc file, -212 lines, single source of truth for scenarios.

## C. The Compliance Bleed in SSO doc

`08-sso-and-authentication.md` (276 lines) carries 60+ lines of cross-border compliance (DPDP, Form 15CA/CB, FEMA, RBI purpose codes) that belong in compliance docs.

**Action — EXCISE compliance prose from 08.** Move FEMA/RBI to `07` (payout pipeline). Move DPDP consent spec to `docs/compliance/` (where it actually belongs given the locked "lightweight compliance only" PR scope). Trim 08 to ~160 lines focused on the auth gate.

**Impact:** -80 lines from 08, improves topic separation.

## D. Stale and Placeholder Docs

Four docs have outlived their usefulness:

| Doc                               | Lines | Why deletable                                                              |
| --------------------------------- | ----- | -------------------------------------------------------------------------- |
| `13-feature-flags-and-rollout.md` | 153   | Flags rotate within weeks; lives better as JSDoc in `lib/feature-flags.ts` |
| `17-hierarchy.md`                 | 112   | 95% "deferred UI" — feature not shipped                                    |
| `19-harness-verdict.md`           | 87    | Snapshot from 2026-05-15, stale within weeks                               |
| `22-route-migration-table.md`     | 129   | Pre-Arch-4 → Arch-4 map; irrelevant post-2026-07                           |

**Action — DELETE 13, 17, 19. ARCHIVE 22 to `docs/migrations/`.**

**Impact:** -3 doc files (one archived), -481 lines.

## E. Cosmetic and Trivial Docs

Three docs carry too little to justify their own file:

- `11-public-pages-and-discovery.md` (97 lines) — fold into `12-dashboard-pages.md`
- `27-design-partner-customer-set.md` (116 lines) — better as a seed README
- `32-security-headers.md` (66 lines) — single-table reference, fold into `explainers/security.md`

**Impact:** -3 doc files, -279 lines, with content preserved by folding.

## F. The 00-Overview Bloat

`00-overview.md` (371 lines) repeats the conceptual material of 01-04 before the reader gets to those docs. Lines 15-90 are redundant intro.

**Action — TRIM 00 to ~150 lines.** Keep only the ER diagram, doc index, and session shape. Readers learn concepts from 01-04, not from 00.

**Impact:** -150 lines, makes 00 a true index.

## G. Roles Matrix as Narrative

`04-roles-and-permissions.md` (290 lines): the first 75 lines are healthy narrative, the next 170 are an exhaustive gate matrix that belongs in a reference table.

**Action — SHORTEN 04 to ~120 lines** (narrative), extract gate matrix to a new `reference/roles-api-matrix.md`.

**Impact:** -170 narrative lines, +1 reference file, much more readable.

## Phase 1 — Docs Simplification Summary

| #         | Action                                 | Δ files      | Δ lines           |
| --------- | -------------------------------------- | ------------ | ----------------- |
| 1         | Merge 07 + 09 + 18 → new 09-ledgers.md | -2           | -89               |
| 2         | Delete 14-scenarios-and-examples.md    | -1           | -212              |
| 3         | Delete 13-feature-flags-and-rollout.md | -1           | -153              |
| 4         | Delete 17-hierarchy.md (placeholder)   | -1           | -112              |
| 5         | Delete 19-harness-verdict.md (stale)   | -1           | -87               |
| 6         | Archive 22 → `docs/migrations/`        | 0            | 0                 |
| 7         | Delete 11, 27, 32 (fold into siblings) | -3           | -279              |
| 8         | Trim 00-overview.md intro              | 0            | -150              |
| 9         | Extract roles matrix from 04           | +1           | -170 net          |
| 10        | Excise compliance from 08              | 0            | -80               |
| **Total** |                                        | **-8 files** | **~-1,333 lines** |

**Post-simplification:** 39 docs, ~9,800 lines (12% reduction). Zero customer impact.

---

# Pillar 2 — Code Simplification

The enterprise code surface spans ~13,500 LoC. Three categories of preventable bloat:

## A. Dead Code (highest priority)

### A1. `lib/payments/payouts/payout-service.ts` (910 LoC)

**Status:** Zero production callers. Sister file `org-payout-service.ts` (976 LoC) is the live implementation. The two state machines are nearly identical.

**Action — DELETE.** Re-create later only if consultant-level payouts ship.

**Risk:** Very low. Verify with `grep -r "from.*payout-service" --include="*.ts" --exclude-dir=__tests__` first.

### A2. `lib/scim/` directory (~534 LoC)

**Status:** Full SCIM 2.0 implementation. Zero customers using it. No org has enabled SSO sync via SCIM.

**Action — STUB to 501.** Replace `resource-user.ts`, `operations.ts`, `auth.ts`, `errors.ts` with a single 50-line module that returns "501 Not Implemented — contact support for ETA". Keep the route handler at `app/api/organizations/[orgId]/scim/[...path].ts` as a thin dispatcher.

**Risk:** Very low. No tests on the implementation, no active customers, no schema coupling.

### A3. Dead feature flags

| Flag                    | Status                                                |
| ----------------------- | ----------------------------------------------------- |
| `ENABLE_TDS_ADMIN_VIEW` | Feature shipped; flag now always-true in deployments  |
| `ENABLE_HRIS`           | No implementation exists; pre-scaffolding never wired |

**Action — DELETE both flags** from `lib/feature-flags.ts` and audit callers.

**Keep:** `ENABLE_HOST_ORGS` (load-bearing — branches the earnings 3-way split), `ENABLE_IRP_UPLOADER` (some orgs don't need IRP yet).

**Risk:** Very low. Likely zero callers.

**Phase 1 dead-code total: ~1,494 LoC removed, ~0.5 days effort.**

## B. Helper Proliferation

### B1. Three role-check predicates

Currently three helpers answer "can this person do X?":

- `requireOrgAccess(orgId, { minimumRole })` — rank-based check
- `requireOrgOwner(orgId)` — owner-only convenience
- `requireOrgBillingAdminOrOwner(orgId)` — disjunction (added because rank ladder couldn't express "OWNER or specialized admin")

**Action — UNIFY into capability matrix:**

```ts
// lib/auth/capabilities.ts
const ROLE_CAPABILITIES: Record<MemberRole, Set<Capability>> = {
  OWNER: new Set(["admin", "finance", "members", "sso", "delete"]),
  MAINTAINER: new Set(["admin", "members", "sso"]),
  BILLING_ADMIN: new Set(["finance"]),
  MANAGER: new Set(["members"]),
  // ...
};

export async function requireCapability(orgId: string, capability: Capability) {
  /* single predicate */
}
```

Then `requireOrgOwner = requireCapability(..., "admin")` and `requireOrgBillingAdminOrOwner = requireCapability(..., "finance")`.

**Files affected:** `lib/auth-helpers.ts`, `lib/auth/billing-admin-gate.ts`, ~70 route handlers (no logic change, just import swap).

**Impact:** -200 LoC, much easier to add new roles (e.g., FINANCE_VIEWER) without helper explosion.

**Risk:** Low. Both existing helpers are well-tested. Refactor via parallel implementation + gradual callsite migration with adapter.

**Effort:** 4 hours.

## C. Service-Class Bloat (optional, defer)

### C1. `SlotAllocationService` (1,982 LoC) + helpers

Single service class with three allocation modes (auto / manual / requested) plus calculation + validation helpers. Procedural orchestrator that reads like a sequential checklist.

**Action — SPLIT into per-mode modules:**

- `allocate/auto.ts` (~300 LoC)
- `allocate/manual.ts` (~200 LoC)
- `allocate/requested.ts` (~150 LoC)
- `validate.ts` (~150 LoC)
- Keep shared `types.ts`, `errors.ts`, `slotTimeUtils.ts`

**Impact:** Same total LoC, but each handler becomes independently understood and testable.

**Risk:** Medium. Lock/unlock choreography is subtle.

**Effort:** ~8 hours. **Recommendation:** Defer until the next slot-related feature touches the file.

### C2. `lib/payments/operations/checkout.ts` (2,809 LoC)

One huge file with subscription/one-off branching, slot locking, wallet vs intent routing, cap enforcement, tax determinism, referral credits, earnings creation.

**Action — EXTRACT per-type handlers** into a `checkoutHandlers/` directory.

**Impact:** Same total LoC. Reduces per-handler cognitive load.

**Risk:** High. The lock/unlock choreography is critical-path.

**Effort:** ~16 hours. **Recommendation:** DEFER. Wait for a major feature that justifies the refactor.

## D. Cron / Job Inventory

28 cron jobs total. Survey found **no problematic duplication** — each job has a narrow, well-scoped task. No simplification action needed here.

## Phase 2 — Code Simplification Summary

| #                               | Action                                                                       | Files              | Δ LoC       | Priority |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------ | ----------- | -------- |
| 1                               | Delete `payout-service.ts`                                                   | 1 file deleted     | -910        | HIGH     |
| 2                               | ~~Stub SCIM to 501~~ (superseded — SCIM 2.0 shipped in full, see note above) | 4 files → 1 file   | -484        | MEDIUM   |
| 3                               | Delete `ENABLE_TDS_ADMIN_VIEW` flag                                          | scattered          | -20         | LOW      |
| 4                               | Delete `ENABLE_HRIS` flag                                                    | scattered          | -20         | LOW      |
| 5                               | Unify role predicates → capability matrix                                    | 2 files refactored | -200        | MEDIUM   |
| 6                               | Split SlotAllocationService                                                  | 3 files → 5 files  | 0 net       | OPTIONAL |
| 7                               | Refactor checkout into handlers                                              | 1 file → 5 files   | 0 net       | DEFER    |
| **Phase 1 total (high+medium)** |                                                                              |                    | **~-1,614** |          |

---

# What NOT to Simplify (Load-Bearing Complexity)

The code survey explicitly flagged several patterns as **load-bearing** — apparent complexity that pays for itself in correctness guarantees. **Do not touch:**

## 1. Three-ledger append-only discipline

- `UsageLedgerEntry` — append-only, provides idempotency guard on `recordBookingUtilization`. Concurrent bookings can't double-count.
- `BookingUtilization` — upsert with `appointmentIds` set-diff for SUBSCRIPTION reallocation idempotency.
- `SettlementLedgerEntry` — immutable compliance trail for auditors.

Collapsing these into one table would lose idempotency guarantees and re-introduce double-spend races.

## 2. Conditional UPDATE with underflow guards

Pattern: `UPDATE table SET balance = balance + delta WHERE balance + delta >= 0`. Used in `walletDebit`, `adjustActiveSeatCount`, `recordBookingUtilization`. Prevents wallet/seat underflow under concurrent decrements without application-level locking.

## 3. Redis lock in `createOrgPayoutBatch`

Acquire lock → claim earnings → write payout + ledger → release lock. Without it, two concurrent cron ticks could create duplicate payout batches.

## 4. LED-1 transactional INVOICE_PAID claim

`app/api/webhooks/utils.ts:206-243` — invoice claim + settlement-ledger write in one `prisma.$transaction`. Critical for ledger integrity.

## 5. activeSeatCount denormalization + reconcile cron

The denormalized count is intentional for read-path performance; the reconcile cron at `scripts/reconcile/reconcile-ledgers.ts` block F catches any drift.

## 6. Governance gates (domain verification before SSO/INVOICE)

`hasVerifiedDomain` checks before SSO/INVOICE operations prevent domain-squatting attacks and invoice-credit fraud.

## 7. Audit log + sanitization

Immutable compliance trail. The new 3-layer info-leak fix from the closeout (write-side sanitization + read-side scrub + admin-only SystemEvent channel) is the right shape — keep it.

## 8. Stripe Connect scaffolding (`lib/payments/payouts/stripe-connect.ts`, 540 LoC)

Dormant but cheap. Gated on `paymentGateway` schema field, doesn't intrude on hot path. Cost of deletion > cost of leaving in place.

---

# Phased Rollout Plan

## Phase 1 — Dead code & doc dedup (recommended, ship with PR #655 closeout)

**Effort:** 1 day. **Risk:** None.

Actions:

1. Delete `lib/payments/payouts/payout-service.ts` (after grep verifies zero production callers)
2. Stub `lib/scim/*` to a 501 handler
3. Delete `ENABLE_TDS_ADMIN_VIEW` and `ENABLE_HRIS` from `lib/feature-flags.ts`
4. Merge `07-payout-pipeline.md` + `09-wallet-and-ledger.md` + `18-three-ledger-discipline.md` into a new `09-ledgers.md`
5. Delete `14-scenarios-and-examples.md`, `13-feature-flags-and-rollout.md`, `17-hierarchy.md`, `19-harness-verdict.md`, `11-public-pages-and-discovery.md`, `27-design-partner-customer-set.md`, `32-security-headers.md`
6. Archive `22-route-migration-table.md` to `docs/migrations/`
7. Trim `00-overview.md` intro section
8. Excise compliance prose from `08-sso-and-authentication.md`

**Net result:** -8 doc files, -1 code file (payout-service), -4 code files (SCIM impl), -2 flags. ~2,100 fewer lines.

## Phase 2 — Helper consolidation (1 week post-PR)

**Effort:** 2 days. **Risk:** Low.

Actions:

1. Introduce `lib/auth/capabilities.ts` with `requireCapability()` + role→capability matrix
2. Refactor `requireOrgAccess`, `requireOrgOwner`, `requireOrgBillingAdminOrOwner` to thin wrappers
3. Migrate ~70 route handlers (mechanical, no behavior change)
4. Extract roles gate matrix from `04-roles-and-permissions.md` into `reference/roles-api-matrix.md`

**Net result:** -200 LoC, easier to add new roles in future. Zero customer impact.

## Phase 3 — Optional service refactors (defer, 2-3 weeks when triggered)

**Effort:** 1-2 weeks. **Risk:** Medium to High.

Trigger conditions:

- `SlotAllocationService` split → defer until the next slot-related feature touches the file
- `checkout.ts` modularization → defer until per-type variance increases (currently stable)

Don't do these speculatively. Wait for a real feature to justify.

---

# Decision Matrix

| Proposal                     | Schema-locked?      | Algorithm change?         | Customer impact | LoC    | Recommended for PR #655? |
| ---------------------------- | ------------------- | ------------------------- | --------------- | ------ | ------------------------ |
| Delete `payout-service.ts`   | ✅ no schema change | ✅ pure dead-code removal | None            | -910   | **YES**                  |
| ~~Stub SCIM~~ (superseded)   | ✅ no schema change | ✅ runtime swap           | None (no users) | -484   | **NO — SCIM shipped**    |
| Delete dead flags            | ✅ no schema change | ✅ env var removal        | None            | -40    | **YES**                  |
| Merge ledger docs            | ✅ no code change   | N/A                       | None            | -89    | **YES**                  |
| Delete 7 stale/cosmetic docs | ✅ no code change   | N/A                       | None            | -1,113 | **YES**                  |
| Trim/archive 4 docs          | ✅ no code change   | N/A                       | None            | -250   | **YES**                  |
| Unify role predicates        | ✅ no schema change | ✅ refactor               | None            | -200   | Phase 2                  |
| Split SlotAllocationService  | ✅ no schema change | ✅ refactor               | None            | 0 net  | Phase 3                  |
| Modularize checkout.ts       | ✅ no schema change | ✅ refactor               | None            | 0 net  | Phase 3 (defer)          |

---

# Appendix A — Files to Modify in Phase 1

## Code deletions

```
lib/payments/payouts/payout-service.ts                 (delete)
lib/scim/auth.ts                                       (delete)
lib/scim/errors.ts                                     (delete)
lib/scim/operations.ts                                 (delete)
lib/scim/resource-user.ts                              (delete)
lib/scim/index.ts                                      (replace with 501 stub)
lib/feature-flags.ts                                   (remove 2 flag exports)
app/api/admin/tds/route.ts                             (remove gate check)
app/api/organizations/[orgId]/hris/*/route.ts          (remove gate check or stub)
```

## Doc deletions / moves

```
docs/enterprise/07-payout-pipeline.md                  (merge into 09-ledgers)
docs/enterprise/09-wallet-and-ledger.md                (merge into 09-ledgers)
docs/enterprise/18-three-ledger-discipline.md          (merge into 09-ledgers)
docs/enterprise/09-ledgers.md                          (NEW - consolidated)
docs/enterprise/11-public-pages-and-discovery.md       (fold into 12, delete)
docs/enterprise/13-feature-flags-and-rollout.md        (delete)
docs/enterprise/14-scenarios-and-examples.md           (delete)
docs/enterprise/17-hierarchy.md                        (delete)
docs/enterprise/19-harness-verdict.md                  (delete)
docs/enterprise/22-route-migration-table.md            (archive to docs/migrations/)
docs/enterprise/27-design-partner-customer-set.md      (delete, copy to seed README)
docs/enterprise/32-security-headers.md                 (fold into explainers/security)
docs/enterprise/00-foundations/01-overview.md                         (trim intro)
docs/enterprise/04-roles-and-permissions.md            (shorten, extract matrix)
docs/enterprise/08-sso-and-authentication.md           (excise compliance prose)
docs/enterprise/reference/roles-api-matrix.md          (NEW - extracted matrix)
```

# Appendix B — Verification Checklist

Before each deletion:

- [ ] `grep -r "<symbol_or_path>" --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude-dir=node_modules` returns zero non-self hits
- [ ] No doc references the deleted file (`grep -r "<docname>" docs/`)
- [ ] No README points to the file (`grep -r "<docname>" README.md`)

After Phase 1:

- [ ] `npm run lint` clean
- [ ] `npx tsc --noEmit` clean
- [ ] `npx jest` — all suites pass (currently 61 suites / 990 tests; expect same count post-deletion, minus SCIM tests if any were present)
- [ ] Manual smoke: SPONSOR org create → invite LEARNER → book CLASS → engagementsUsed increments correctly
- [ ] ~~Manual smoke: hit `/api/organizations/[orgId]/scim/Users` → expect 501~~ (superseded — SCIM shipped; verify Users CRUD, bearer-token auth, group mapping, deprovisioning and `ScimToken.expiresAt` enforcement instead)

---

# Appendix C — Bottom Line

The enterprise subsystem complexity is **75% inherent product complexity** (multi-axis customer permutations, GST/TDS/MSME compliance, three-ledger settlement discipline) and **25% incidental complexity** (duplicated docs, dead code, premature abstractions).

The schema captures the inherent complexity correctly — that's why it's locked. The incidental complexity is preventable and reducing it will not change a single customer's experience.

**Recommendation:** Land Phase 1 with the PR #655 closeout. Defer Phases 2 and 3 to follow-up technical-debt PRs at lower priority. Continue resisting the urge to refactor load-bearing patterns (three-ledger, conditional UPDATEs, Redis locks, audit log immutability).

The system is in better shape than it looks. Most of the simplification opportunity is in **what we say about the system**, not in the system itself.
