# Enterprise tests — shared setup

> **Required reading for every case file in `prompts/enterprise-tests/`.**
> Single source of truth for prerequisites, glossary, schema reference,
> seed cohort, mock-data strategy, and immutable invariants. If a case
> file disagrees with this, this file wins.

For MCP-command idioms (Supabase queries, Chrome DevTools navigation,
cross-tool assertions), see [`mcp-recipes.md`](./mcp-recipes.md).
For the case skeleton + fix-and-retest gate, see [`case-template.md`](./case-template.md).

---

## §1 — Critical rules

1. **Fix-and-retest with ASK gate.** When a case fails, classify the fix
   per [`case-template.md` §Fix-and-retest gate](./case-template.md#fix-and-retest-gate).
   Trivial (≤5 lines, no schema/cron/payment/auth/compliance) → apply +
   retest. Non-trivial → STOP and ASK before editing. No bug list.
2. **Verify DB state after every meaningful action.** The UI can lie;
   the source of truth is the double-entry money ledger
   (`LedgerAccount` / `LedgerTransaction` / `LedgerEntry`, which
   replaced `FundingLedgerEntry`, `WalletEntry`, and
   `SettlementLedgerEntry` in #772) plus `UsageLedgerEntry` for
   engagement entitlements.
3. **Test happy + guard paths.** Every route has 4xx branches.
4. **All money in paise** (1 INR = 100 paise). Never divide by 100 in
   assertions; assert the integer.
5. **Double-quote mixed-case Postgres identifiers** (`"Membership"`,
   `"BillingAccount"`, `"OrganizationInvoice"`). BetterAuth-mapped
   tables are lowercase (`organizations`, `members`, `invitations`,
   `sessions`, `users`).
6. **App runs at** `http://localhost:3000`. Confirm with
   `curl -sf http://localhost:3000/api/health`; ask the user to start
   `npm run dev` if missing. Case files never `npm run dev` themselves.
7. **Snapshots + network + console liberally.** `take_snapshot` before
   every click, `list_network_requests` after every state change,
   `list_console_messages` whenever something feels off (silent P2002
   leaks hide there).

---

## §2 — Seed cohort

The deterministic cohort lives in `prisma/seedFiles/15a-create-organizations.ts`,
with the users it draws from created in `1a-create-users.ts`. Use these for
read-only and happy-path cases. **Do not mutate them destructively** —
that's what the fresh-org spawn pattern below is for.

The org shapes are seeded as follows (corrected 2026-08-14 — an earlier
version of this table swapped the IIT/LearnPro shapes and listed
`founder@*.test` owner emails that have never existed in the seeds):

| Slug | Capability | FundingSource | Program |
|---|---|---|---|
| `wipro` | Sponsor (canSponsor=true, canHost=false) | `INVOICE` | LICENSED_SEAT |
| `learnpro-academy` | Host (canSponsor=false, canHost=true) | — | — |
| `iit-madras` | Hybrid (canSponsor=true, canHost=true) | `WALLET` | CREDIT_POOL |
| Rahul solo (personal org) | Host (single-consultant) | — | — |

Owner/expert/learner accounts are picked deterministically from the
index-based user pool (`firstname.lastname@<domain>` addresses such as
`samantha.anderson@yahoo.com`), so the full per-org credential roster is
maintained in ONE place:
[`docs/enterprise/90-audits/03-verification-guide.md`](../../../docs/enterprise/90-audits/03-verification-guide.md)
— use it as the login table for these cases.

Password for every seeded account: the `SEED_PASSWORD` env (default
`SeedPass123!`).

Tour-owner login (operator dashboard, OWNER of Wipro):
`tour-owner@familiarise.dev` / same `SEED_PASSWORD` default.

---

## §3 — Mock-data strategy

### Read + happy-path cases
Use the seed cohort. No setup, no cleanup.

### State-mutating / destructive cases
Spawn fresh orgs via Supabase MCP. Use the prefix `test-2026-{YYYYMMDD}-{slug}`
so cleanup is one line.

```sql
-- via mcp__supabase__execute_sql, project_id='pzmbxqdgibfkhjwzeprf'
WITH new_org AS (
  INSERT INTO "organizations"
    (id, slug, name, status, "canSponsor", "canHost", "rootId", "createdAt", "updatedAt")
  VALUES (
    gen_random_uuid()::text,
    'test-2026-' || to_char(now(), 'YYYYMMDD') || '-acme-' || substring(gen_random_uuid()::text, 1, 8),
    'Test Acme ' || to_char(now(), 'YYYY-MM-DD'),
    'PENDING_VERIFICATION',
    true,
    false,
    '__self__',
    now(),
    now()
  )
  RETURNING id, slug
)
UPDATE "organizations" o
   SET "rootId" = new_org.id
  FROM new_org
 WHERE o.id = new_org.id
RETURNING o.id, o.slug;
```

**Cleanup at case end:**
```sql
DELETE FROM "organizations"
WHERE slug LIKE 'test-2026-%' AND "createdAt" < NOW() - INTERVAL '2 hours';
```

Cleanup runs at the end of the case that spawned the org. Don't rely on
a nightly sweep — a half-broken case leaving dangling rows will collide
with a later case.

---

## §4 — Round-3 surface invariants (commit `3ad02565`)

Every Phase B case in this tree exercises one of these. If a case finds
the invariant broken, that's a regression — apply the fix-and-retest
gate.

| Surface | Invariant | Anchor |
|---|---|---|
| **TDS withholding** | `createOrgPayoutBatch` deducts TDS from gross; persists `tdsSectionApplied` / `tdsAmountPaise` / `dtaaRateApplied` on `OrganizationPayout`. Section 194-O default (1%); PAN missing/malformed → 206AA 20%. | `lib/payments/payouts/org-payout-service.ts`; `lib/compliance/tds.ts:computeTdsForPayout` |
| **MSME 43B(h)** | `mustPayByDate` derived from `Organization.msmeStatus` + `msmeWrittenAgreementOnFile`. MICRO+agreement → 45d, MICRO/SMALL no agreement → 15d, MEDIUM/NONE → `contract.paymentTermsDays`. | `lib/compliance/msme.ts:computeMsmePaymentDeadline` |
| **DPDP signup consent** | BetterAuth `user.create.after` stamps `ConsentArtifact` for `PRIMARY_PROCESSING` + `STREAM_DATA_PROCESSING` (SHA-256 hash, 7y retention). `upsertUserToStream` / `upsertUsersToStream` fail-close on missing/withdrawn `STREAM_DATA_PROCESSING`. | `lib/auth.ts` databaseHooks; `actions/stream/chat/user.action.ts` |
| **GST place-of-supply env** | `SUPPLIER_STATE_CODE` env (default `"KA"`) drives intra-state CGST+SGST vs inter-state IGST. No hardcoded `"KA"` in invoice generation. | `jobs/billing/generate-subscription-invoices.ts`; `app/api/organizations/[orgId]/billing-account/invoices/route.ts` |
| **Per-org invoice numbering** | Format `<PREFIX>-<FY>-<SEQ>` (CGST Rule 46). PREFIX = `Organization.invoiceNumberPrefix` or uppercased slug. `@@unique([organizationId, invoiceNumber])`. FY = Indian (April–March). Atomic counter at `OrgInvoiceCounter`. | `lib/payments/billing/invoice-numbering.ts` |
| **Payout idempotency** | `scripts/payouts/process-payouts.ts:69` uses `payout_${payoutId}` (no `Date.now()`). `OrganizationPayout.idempotencyKey @unique`. Re-runs return `alreadyExisted: true`. | `scripts/payouts/process-payouts.ts:69`; `lib/payments/payouts/org-payout-service.ts:createOrgPayoutBatch` |
| **Recording orgId** | `Recording.organizationId` is populated at write time from the parent appointment. Null FK only for personal (non-org) plans. | `lib/stream/recording-handlers.ts` |
| **Programs v2 reject** | POST `/api/organizations/[orgId]/programs` with `type=PROJECT` or `type=RETAINER` → 400 `code: "PROGRAM_TYPE_NOT_AVAILABLE"`. Other invalid bodies → 400 with no code. | `app/api/organizations/[orgId]/programs/route.ts` — `ProgramsV2AttemptSchema` |
| **DPDP breach 72h cron** | Hourly. Sweeps `DataBreach WHERE reportedAt IS NULL`. Warn ≤12h before 72h deadline; critical past deadline. Resend email (env-gated) + structured-log fallback. | `jobs/compliance/databreach-deadline-alerts.ts`; `.github/workflows/databreach-deadline-alerts.yml` |
| **Contract expiry cron** | Daily 03:00 UTC. ACTIVE → EXPIRED when `effectiveTo < NOW()`. In-flight earnings retain their `rateCardId` snapshot. | `jobs/compliance/contract-expiry.ts`; `.github/workflows/expire-contracts.yml` |

---

## §5 — Glossary

### Capability model
`Organization` carries `canSponsor` and `canHost`. Four shapes:

| canSponsor | canHost | Shape | Example |
|---|---|---|---|
| `true` | `false` | Sponsor | Wipro (pays for its engineers' sessions) |
| `false` | `true` | Host | LearnPro Academy (hosts experts who earn via the org) |
| `true` | `true` | Hybrid | IIT Madras (buys for staff + hosts professors) |
| `false` | `false` | **INERT** — rejected at create time | — |

`capabilitiesExtra Json?` escape hatch covers long-tail capabilities
without a migration.

### FundingSource
`BillingAccount.fundingSource`:

- `PERSONAL` — learner pays own card; `Payment.organizationId` is tagged for attribution.
- `WALLET` — credit pool. `walletBalance` paise; topped up via `/wallet/top-ups`.
- `INVOICE` — NET-X postpaid. Bookings accrue; `creditLimit` caps outstanding.
- `LICENSE` — flat license. No per-booking charge.
- `PROJECT` — v2-reserved; rejected at API.

One `BillingAccount` per org when `canSponsor=true`. Host-only orgs have no BillingAccount.

### ProgramType
- `LICENSED_SEAT` — 1:1 `LicensedSeatConfig`. `ratePerSeatPaise` + `cycle` + optional `coveredEngagementsPerCycle` (null = unlimited). `overageBehavior` ∈ `{BLOCK, CHARGE_MEMBER, CHARGE_ORG}`.
- `CREDIT_POOL` — 1:1 `CreditPoolConfig`. `creditValuePaise` + optional `premiumMultiplier` + `minimumCreditsPerPeriod`.
- `PROJECT` / `RETAINER` — v2-reserved. POST returns 400 `PROGRAM_TYPE_NOT_AVAILABLE`.

Per-member entitlement: `ProgramAssignment` (unique on `(programId, membershipId, periodStart)`).
Per-booking usage: `BookingUtilization`.

### MemberRole (disjoint from UserRole)
`{ OWNER, MAINTAINER, MANAGER, EXPERT, LEARNER, SUPPORT }`. Rank order
defined in `lib/auth-helpers.ts:ORG_ROLE_RANK`.

- `OWNER` — full org control (contracts, rate cards, funding flips, payouts, branding).
- `MAINTAINER` — admin below OWNER. (Renamed from `ADMIN` to avoid `UserRole.ADMIN` collision.)
- `MANAGER` — read-heavy admin (invoices, earnings, audit log).
- `EXPERT` — delivers services. (Renamed from `CONSULTANT`; use "expert" for org members.)
- `LEARNER` — consumes services. No admin chrome.
- `SUPPORT` — internal ops / CX.

`UserRole = { CONSULTEE, CONSULTANT, ORG_WORKSPACE, ADMIN }` is the
platform-level role on `users.role`. `ORG_WORKSPACE` is the gate for
`POST /api/organizations`.

### The ledgers (immutable)

#772 replaced the old three-log design (`FundingLedgerEntry`, `WalletEntry`,
`SettlementLedgerEntry` — all deleted) with ONE double-entry money journal
plus a separate entitlement ledger:

- `LedgerAccount` / `LedgerTransaction` / `LedgerEntry` — the money journal.
  Every movement (top-up, booking, refund, payout) is a balanced transaction
  whose `idempotencyKey` is the originating event (e.g. `topup:<orderId>`,
  `booking:<paymentId>`); entries are immutable and reversals are explicit
  counter-transactions, never row mutations.
- `UsageLedgerEntry` — engagements consumed against program entitlements
  (positive on book, negative on reversal); its per-period sum must equal
  `ProgramAssignment.engagementsUsed`.

Cached balances (`BillingAccount.walletBalance`) are derived views over the
journal, checked nightly by `jobs/reconcile/reconcile-ledgers.ts`, which
writes `LedgerReconciliationReport` rows and freezes wallet spend on a
`WALLET_BALANCE_DRIFT` finding. See ADR 01
(`docs/enterprise/70-design-decisions/01-double-entry-over-three-logs.md`)
and `docs/enterprise/10-money-and-ledger/03-ledger-and-postings.md`.

### RateCard bumping
`RateCard` has `effectiveFrom` / `effectiveTo`. **Rate cards are never
mutated after creation**. `lib/api/organizations/rate-card.ts#bumpRateCard`:

1. `UPDATE` currently-live card's `effectiveTo = now()`.
2. `INSERT` new row with `effectiveFrom = now()`, `effectiveTo = null`.

Invariant: `platformBps + orgBps + consultantBps === 10000` (integer
math). Settlement reads the **snapshot** on
`OrganizationEarnings.{platform,org,consultant}BpsApplied` — never the
live card. Bumping doesn't rewrite history.

### Refund semantics
`BookingUtilization.reversedAt` + `reversalReason`. Row is **never
deleted**; reversal sets those two fields and appends a counter
`UsageLedgerEntry` with negative `engagementsConsumed`.

### Audit log
`OrgAuditLog.action` is a free-form `String` (so new actions land
without a migration), paired with a stable `category: OrgAuditCategory`
enum. Well-known literals via `lib/enterprise/audit-actions.ts`.

Cheat sheet (well-known actions):
```
ORG_CREATED, MEMBER_INVITED, INVITATION_ACCEPTED, MEMBER_ROLE_CHANGED,
MEMBER_REMOVED, CONTRACT_SIGNED, RATE_CARD_BUMPED, PROGRAM_CREATED,
PROGRAM_ASSIGNED, WALLET_TOPUP, WALLET_TOPUP_CONFIRMED,
INVOICE_ISSUED, INVOICE_PAYMENT_INITIATED, INVOICE_PAID,
INVOICE_VOIDED, PAYOUT_INITIATED, PAYOUT_SENT, PAYOUT_REVERSED,
PAYOUT_CANCELLED, SETTINGS_CHANGED, BRANDING_UPLOADED,
BRANDING_REMOVED, SSO_PROVIDER_CONFIGURED, DOMAIN_CLAIMED, VERIFIED,
CONSENT_GRANTED, CONSENT_WITHDRAWN, HRIS_CONFIGURED, HRIS_SYNC_RAN
```

### Stackable funding
`PaymentLeg` rows attach to a `Payment` when `> 1` funding source
contributed. Sources: `CARD | WALLET | REFERRAL_CREDIT | INVOICE_ACCRUAL
| OVERAGE_INVOICE_ACCRUAL | LICENSE`, plus the append-only refund
counter-entries `INVOICE_ACCRUAL_REVERSAL` and
`OVERAGE_INVOICE_ACCRUAL_REVERSAL` (#786). Single-source payments get no
PaymentLeg rows.

### Razorpay async settlement
Razorpay confirms via webhook, not API response. Client flows (wallet
top-up, invoice pay) bridge with **bounded polling** against
`GET /…/wallet/top-ups/{topUpId}` or the analogous invoice status
endpoint. Terminal outcomes:

- **`confirmed`** — webhook landed within polling window; ledger row exists.
- **`pending`** — popup `handler` fired but webhook slow; balance catches up on next page load.
- **`not_paid`** — popup dismissed or `payment.failed` fired.

Webhook handling is idempotent on `WalletTopUp.providerOrderId @unique`
(#772 removed `WalletEntry`): confirmation is an atomic conditional
PENDING → CONFIRMED claim, so a redelivery is a no-op.

---

## §6 — Schema reference (table names)

For canonical model defs, read `prisma/schema.prisma` directly.
For the ER view: `docs/enterprise/00-foundations/01-overview.md` (master ER + schema-by-cluster).
For the platform-wide diagrams: `docs/prisma/schema-map.md`.

| Prisma Model | PostgreSQL Table | Notes |
|---|---|---|
| `Organization` | `organizations` | BetterAuth `@@map`; carries `msmeStatus`, `invoiceNumberPrefix`, 6 contact fields |
| `Member` | `members` | BetterAuth `@@map`; invitation-token shim |
| `Invitation` | `invitations` | BetterAuth `@@map` |
| `OrgWorkspaceProfile` | `org_workspace_profiles` | `@@map`; one per operator user |
| `Membership` | `"Membership"` | Typed role + status source of truth |
| `BillingAccount` | `"BillingAccount"` | `fundingSource` + `walletBalance` + `creditLimit` |
| `Contract` | `"Contract"` | status: `DRAFT/ACTIVE/EXPIRED/TERMINATED` |
| `BillingSubscription` | `"BillingSubscription"` | `PER_SEAT` or `FLAT_FEE` |
| `WalletTopUp` | `"WalletTopUp"` | Top-up intents; `providerOrderId @unique` (replaced `WalletEntry`, #772) |
| `OrganizationInvoice` | `"OrganizationInvoice"` | `invoiceNumber` + `fiscalYear`, per-org unique |
| `OrgInvoiceCounter` | `org_invoice_counters` | Atomic seq allocator |
| `PurchaseOrder` | `"PurchaseOrder"` | `@@unique([organizationId, poNumber])` |
| `Program` | `"Program"` | LICENSED_SEAT or CREDIT_POOL |
| `LicensedSeatConfig` | `"LicensedSeatConfig"` | 1:1 with Program |
| `CreditPoolConfig` | `"CreditPoolConfig"` | 1:1 with Program |
| `ProgramAssignment` | `"ProgramAssignment"` | Per-member entitlement |
| `BookingUtilization` | `"BookingUtilization"` | Per-booking usage + `reversedAt` |
| `RateCard` | `"RateCard"` | Bps sum = 10000 invariant |
| `OrganizationPayoutAccount` | `"OrganizationPayoutAccount"` | Encrypted bank details |
| `OrganizationEarnings` | `"OrganizationEarnings"` | `{platform,org,consultant}BpsApplied` snapshot |
| `OrganizationPayout` | `"OrganizationPayout"` | TDS/MSME/FEMA fields; `idempotencyKey @unique` |
| `OrganizationPlan` | `"OrganizationPlan"` | Curated catalog |
| `OrganizationSSOSettings` | `"OrganizationSSOSettings"` | `enforceSSO`, `allowedEmailDomains` |
| `SsoProvider` | `"ssoProvider"` | BetterAuth-managed |
| `OrgDomainClaim` | `org_domain_claims` | `@@map`; verified via DNS TXT |
| `OrgAuditLog` | `"OrgAuditLog"` | `action: String` free-form |
| `UsageLedgerEntry` | `"UsageLedgerEntry"` | Engagement entitlement ledger |
| `LedgerAccount` | `"LedgerAccount"` | Money journal — deterministic composite ids |
| `LedgerTransaction` | `"LedgerTransaction"` | Money journal — `idempotencyKey @unique` |
| `LedgerEntry` | `"LedgerEntry"` | Money journal — immutable postings |
| `LedgerAccountBalance` | `"LedgerAccountBalance"` | Materialized per-account balance |
| `LedgerReconciliationReport` | `ledger_reconciliation_reports` | `@@map` |
| `ConsentArtifact` | `"ConsentArtifact"` | DPDP grants; SHA-256 `hash` |
| `DataBreach` | `"DataBreach"` | 72h DPDP reporting deadline |
| `HrisConfig` | `"HrisConfig"` | |
| `HrisSyncJob` | `"HrisSyncJob"` | |
| `HrisEmployeeMap` | `"HrisEmployeeMap"` | |
| `PaymentLeg` | `"PaymentLeg"` | Stackable funding |

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`

---

## §7 — Prerequisites checklist (run once per session)

```bash
# 1. Dev server up
curl -sf http://localhost:3000/api/health | jq .
# Expected: { "ok": true, ... }
```

```ts
// 2. Supabase reachable via MCP
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: "SELECT count(*) FROM \"organizations\";"
})
// Expected: count >= 4 (seed cohort)
```

```bash
# 3. Migrations clean
npx prisma migrate status
# Expected: "Database schema is up to date!"
```

```ts
// 4. Round-3 schema present
mcp__supabase__execute_sql({
  project_id: "pzmbxqdgibfkhjwzeprf",
  query: "SELECT column_name FROM information_schema.columns
          WHERE table_name = 'organizations'
            AND column_name IN ('msmeStatus', 'invoiceNumberPrefix', 'billingContactEmail');"
})
// Expected: 3 rows returned
```

If any step fails, stop and resolve before starting cases.

### Promote your test user to `UserRole.ORG_WORKSPACE`
`POST /api/organizations` is gated to `ORG_WORKSPACE` and platform
`ADMIN`. A `CONSULTEE` cannot create an org (403). Two paths:

1. **UI** — walk `/form/onboarding`, pick "Organization Owner".
2. **SQL fallback:**
   ```sql
   UPDATE users
      SET role = 'ORG_WORKSPACE', "onboardingCompleted" = true
    WHERE email = '<test-email>';
   ```

### Razorpay test keys (required for wallet + invoice-pay flows)
```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```
If missing, the routes 503 with `"Razorpay is not configured"`. Test
cards: `4111 1111 1111 1111`, OTP `1234`.

---

## §8 — Key code anchors (jump here when stuck)

- **Capability model + Round-3 fields:** `prisma/schema.prisma model Organization` (~line 421)
- **MemberRole enum:** `prisma/schema.prisma enum MemberRole` (~643)
- **FundingSource enum:** `prisma/schema.prisma enum FundingSource` (~737)
- **Program subtypes:** `prisma/schema.prisma model Program` (~859), `LicensedSeatConfig` (~889), `CreditPoolConfig` (~900)
- **OrgInvoiceCounter (Round-3):** `prisma/schema.prisma model OrgInvoiceCounter`
- **Auth helpers:** `lib/auth-helpers.ts` — `requireApiAuth`, `requireOrgAccess(orgId, minRole)`, `requireOrgOwner(orgId)`, `requireAdminAuth`, `orgRoleSatisfies`, `ORG_ROLE_RANK`
- **Create-org route:** `app/api/organizations/route.ts` (ORG_WORKSPACE gate at lines 129-142)
- **Accept-invitation race:** `app/api/organizations/invitations/accept/route.ts` (atomic `updateMany WHERE status=pending`)
- **Programs route (Round-3 v2 reject):** `app/api/organizations/[orgId]/programs/route.ts` — `ProgramsV2AttemptSchema`
- **Wallet top-up:** `app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts` (POST; idempotency + 503 branches), `[topUpId]/route.ts` (status polling)
- **Invoice numbering (Round-3):** `lib/payments/billing/invoice-numbering.ts:generateOrgInvoiceNumber`
- **Invoice /pay:** `app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts`
- **Invoice PATCH allow-list:** `[invoiceId]/route.ts` (lines 100-120) — proves PAID is unreachable via PATCH
- **Payout state machine:** `app/api/organizations/[orgId]/payouts/[payoutId]/route.ts` (lines 122-172)
- **Org payout creation (Round-3 TDS+MSME wiring):** `lib/payments/payouts/org-payout-service.ts:createOrgPayoutBatch`
- **Payout idempotency fix (Round-3):** `scripts/payouts/process-payouts.ts:69` — `X-Payout-Idempotency: payout_${payoutId}`
- **Compliance libs (Round-3 live):** `lib/compliance/{tds,msme,gst,irp,dpdp}.ts`
- **Compliance crons:** `jobs/compliance/{contract-expiry,databreach-deadline-alerts,irp-uploader,msme-payment-alerts}.ts` (all scheduled in `.github/workflows/`)
- **Razorpay webhook:** `app/api/webhooks/razorpay/route.ts`; payload routing in `app/api/webhooks/utils.ts` (`handleOrgPaymentSuccess`)
- **SSO URL derivation:** `lib/sso/derive-urls.ts` (`deriveAcsUrl`, `deriveMetadataUrl`)
- **Branding upload:** `app/api/organizations/[orgId]/branding/[asset]/route.ts`; helpers in `lib/supabase.ts`
- **Recording handlers (Round-3 orgId):** `lib/stream/recording-handlers.ts`
- **BetterAuth signup hook (Round-3 consent stamp):** `lib/auth.ts` databaseHooks
- **Stream upsert (Round-3 consent gate):** `actions/stream/chat/user.action.ts:upsertUserToStream`, `upsertUsersToStream`

### Auth + SSO hardening (this audit batch)

- **JIT default role floor:** `lib/labels/org-labels.ts:JitDefaultRoleSchema` (locked to `LEARNER`); UI lock at `app/dashboard/organization/[orgId]/settings/sso/page.tsx`
- **SAML cert validation:** `lib/sso/provider-schemas.ts:validateSamlCert` (Node `crypto.X509Certificate`)
- **customSession narrow catch:** `lib/auth.ts` bareMembers loop (P2002-only)
- **SSO error-toast wrapper:** `lib/sso/signin-with-toast.ts:ssoSigninWithGuard` (2s redirect watchdog + BetterAuth error inspection)
- **Domain-verification gate:** `app/api/organizations/[orgId]/sso/providers/route.ts` POST — DOMAIN_NOT_OWNED / DOMAIN_NOT_VERIFIED 422s
- **SsoProvider composite unique:** `prisma/schema.prisma model SsoProvider @@unique([organizationId, domain])`
- **sessionGeneration marker:** `lib/api/organizations/membership-transitions.ts:bumpUserSessionGeneration` + `prisma/schema.prisma User.sessionGeneration` + `lib/auth.ts customSession`
- **lookupEnforcedOrg helper:** `lib/sso/enforce-session.ts:lookupEnforcedOrg` (shared across `session.create.before`, `customSession`, `/api/auth/sso/domain-check`)
- **N+1 fix in customSession:** `applyMembershipRoleEffects(..., preloadedProfiles)` in `lib/api/organizations/membership-transitions.ts`
- **Rate-limit policy:** `lib/auth.ts` block comment + Upstash `authLimiter` at `middleware.ts:192-197`
- **SSO error codes reference:** `docs/enterprise/reference/sso-error-codes.md`
- **JIT + session-refresh doc:** `docs/enterprise/28-jit-and-session-refresh.md`
- **Rate-limiting doc:** `docs/enterprise/30-rate-limiting.md`

When a step yields unexpected behaviour, read the route file from
`app/api/organizations/**` before escalating — most answers live in the
handler's inline comments, not in higher-level docs.

---

## §9 — Index of case files

Files are numbered `<folder>.<seq>-<slug>.md` so the read order is
deterministic.

### 0-org-lifecycle/
- `0.1-api-org-creation-and-capability-flips.md`
- `0.2-ui-org-creation-wizard.md`
- `0.3-smoke-org-status-transitions.md`

### 1-membership-auth/
- `1.1-api-membership-roles-and-rbac.md`
- `1.2-ui-invite-and-accept.md`
- `1.3-sso-and-domain-claims.md`
- `1.4-dpdp-signup-consent-gate.md`

### 2-programs-contracts/
- `2.1-api-programs-licensed-seat-and-credit-pool.md`
- `2.2-ui-program-create-and-assign.md`
- `2.3-programs-v2-rejection.md`
- `2.4-contracts-expiry-cron.md`

### 3-billing-wallet-invoices/
- `3.1-api-wallet-top-up-and-invoices.md`
- `3.2-ui-wallet-and-invoice-pay.md`
- `3.3-per-org-invoice-numbering.md`
- `3.4-gst-place-of-supply.md`
- `3.5-purchase-order-three-way-match.md`

### 4-payouts-earnings/
- `4.1-api-rate-cards-earnings-payouts.md`
- `4.2-ui-payout-request.md`
- `4.3-tds-withholding-on-org-payouts.md`
- `4.4-msme-deadline-on-org-payouts.md`
- `4.5-payout-idempotency-and-double-spend.md`
- `4.6-refund-and-clawback.md`

### 5-compliance-audit/
- `5.1-india-compliance-shipping-checklist.md`
- `5.2-audit-log-and-ledger-reconciliation.md`
- `5.3-irp-uploader-and-irn-lifecycle.md`
- `5.4-dpdp-breach-72h-cron.md`

### 6-org-scope-and-activity/
- `6.1-appointment-recording-org-fk.md` (retired with the event waitlist)
- `6.2-stream-channel-org-metadata.md`

### 7-cross-org-operator/
- `7.1-org-workspace-portfolio.md`
