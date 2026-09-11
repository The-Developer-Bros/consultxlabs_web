---
title: Enterprise Subsystem — Production Readiness Checklist
band: 90-audits
audience: sde4
status: live
last-reviewed: 2026-06-11
---

# Enterprise Subsystem — Production Readiness Checklist

**Branch:** `feature/enterprise` | **Updated:** 2026-05-02 (Round 2) | **Auditor:** Claude Code (Sonnet 4.6)
**Verdict:** Design-partner ready (manual-ops). NOT self-serve multi-tenant ready.

> **Revision history:**
> - Initial audit 2026-05-02: 62/100 — 3-agent parallel sweep (450+ files)
> - Round 1 2026-05-02: 73/100 — 5 false findings corrected, 7 real fixes applied (875/875 tests)
> - Round 2 2026-05-02: **77/100** — 1 more false finding corrected (GST derivation live), 4 real fixes applied (IRP/MSME cron schedules, DataBreach deadline tracker, CSV size guard)

## v2 Mega-Audit Update — 2026-06-05

> The 77/100 scorecard below is **a point-in-time snapshot as of Round 2 (pre-v2)** — it is **not** re-derived here. Since then the v2 mega-audit series (#777 / #778 / #779) shipped the lifecycle + money-safety layer that Sections 2/3/4 were docking points for. Read this addendum as the delta; treat the per-section scores below as historical. For the live per-subsystem grid see [`subsystem-checklist`](02-subsystem-checklist.md).

**Shipped in v2 (closes the biggest Round-2 gaps):**
- ✅ **Cycle engine kills the zombie assignments** — `advance-program-cycles` cron + `lib/enterprise/cycle-engine.ts` roll each `ProgramAssignment` into a fresh `ACTIVE` successor (caps reset) when the contract is `ACTIVE`+`autoRenew`, else `CLOSED`. (#779 §A)
- ✅ **Contract auto-renew / supersede / end-early** — `auto-renew-contracts` + `expire-contracts` crons; self-supersession chain (`supersededByContractId`, `supersessionReason` AMENDMENT/RENEWAL/TERMINATION_REPLACEMENT); TERMINATED contract cascades in-tx → programs EXPIRED → assignments CLOSED. (#779 §A)
- ✅ **Program money-config lock** — `Program.configLockedAt` stamped at first assignment; `LOCKED_PROGRAM_FIELDS` read-only thereafter; safe identity fields stay editable (`lib/enterprise/config-lock.ts`). (#779 §B)
- ✅ **Invoice dunning** — `jobs/billing/dunning.ts` (7-day cadence, max 3 reminders).
- ✅ **CHARGE_MEMBER timeout** — `timeout-member-overages` cron + `OverageEvent.chargeTimedOutAt`/attempt telemetry; abandoned side-charges fail closed instead of stranding money. (#779 §A)
- ✅ **Refund-failed notify** — no more silent stuck money on reconcile-pending refunds. (#779 §D)
- ✅ **Field-level RBAC** — `requireOrgBillingAdminOrOwner` disjunction gate on money-bearing org mutations (not a per-column allowlist). (#779 §A)
- ✅ **SSO break-glass** — `OrganizationSSOSettings.breakGlassUntil` + `/sso/break-glass` route lets an OWNER reopen password login while `enforceSSO` is on and the IdP is down. (#779 §E)
- ✅ **Self-serve verification resubmit** — Organization stamps + `/verification/resubmit` route (no `RESUBMIT` enum). (#779 §A)
- ✅ **Wallet auto-top-up** — `BillingAccount.{minBalancePaise, autoTopUpEnabled, autoTopUpAmountPaise, autoTopUpMandateId}` + `wallet-low-balance` cron; surfaced in the Wallet tab. (#777 §C)
- ✅ **State-aware home / action center** — `lib/enterprise/org-activation.ts` derives the Getting-Started checklist + condition banners (overdue, cap-near, contract-expiring, overage-as-expansion, wallet-low, stuck-payout), wired in `HomePageClient`. (#777 §A / #779 §F)
- ✅ **Webhook secret rotation grace** — `WebhookEndpoint` rotation fields + 24h dual-secret acceptance window.
- 🟡 **IRN e-invoice mapper** — payload mapper landed behind `ENABLE_IRP_UPLOADER` (off); filing still pending CA signoff + >₹5cr AATO. (#778)

**Still open after v2 (honest gaps):**
- 🔴 **Live payout disbursement** — `ENABLE_LIVE_PAYOUTS` off; batches sit `PROCESSING` pending sandbox proof + go-live (#776 §B). Unchanged — the Section 4 cap still applies.
- 🟡 **Dunning suspension cascade** — the 7-day×3 reminder sequence is live, and stage 3 now auto-suspends the org 7 days past the last reminder (stamps `dunningSuspendedAt`, claim + audit in one Serializable transaction, blocks new sponsored bookings); it is **config-gated behind `ENABLE_DUNNING_SUSPEND`** and off by default, so with the flag unset reminders notify but the org is not frozen. (#812)
- 🟡 **TDS admin view** — `ENABLE_TDS_ADMIN_VIEW` off; Form 26Q/16A surfaces + decrypted-PAN admin view are flag-gated pending accountant signoff. (#778)

---

## Overall Score: 77 / 100 *(as of Round 2; pre-v2 — see the 2026-06-05 addendum above)*

| Section | Weight | Score | Earned | Δ R1 | Δ R2 |
|---------|-------:|------:|-------:|-----:|-----:|
| 1. Schema & Data Model | 10 | 95% | 9.5 | — | — |
| 2. Enterprise Core: Auth / Membership / Contracts / Programs | 15 | 87% | 13.0 | +0.25 | — |
| 3. Booking + Payment Algorithm | 15 | 85% | 12.75 | +0.75 | — |
| 4. Finances: Payouts / Earnings / Refunds | 15 | 47% | 7.05 | +1.05 | — |
| 5. India Compliance: GST / TDS / MSME / IRN / FEMA | 10 | 45% | 4.5 | +0.5 | **+2.0** |
| 6. Dashboards & UI | 10 | 85% | 8.5 | +1.5 | — |
| 7. Org Context / Switchers / Filters | 8 | 90% | 7.2 | +0.64 | — |
| 8. Cross-cutting Integrations: Stream / Novu / SSO | 7 | 70% | 4.9 | — | **+0.35** |
| 9. Crons & Operational Readiness | 5 | 80% | 4.0 | +0.75 | **+0.75** |
| 10. Testing & Type Safety | 5 | 95% | 4.75 | — | — |
| **TOTAL** | **100** | | **76.15 → ~77\*** | +11 | **+4** |

> \* Penalty retained for: live payouts = `NotImplementedError` (PR-3), TDS/FEMA logic = safe-default stubs (PR-2). Those sections cap overall score. Gap to 100 = PR-2 + PR-3 + #674 + soak window.

---

## Legend

| Icon | Meaning |
|------|---------|
| ✅ | Correctly implemented — live, tested, production-grade |
| 🟡 | Partly fixed — schema/structure exists but logic/crons/UI stubbed or drifted |
| 🔴 | Missing or incorrectly implemented — broken, wrong, or not started |
| ~~🔴~~ | Was flagged as missing in a prior audit round; confirmed already correctly implemented (false finding) |

---

## Corrections & Fixes Applied

### False Findings Corrected

Six items were flagged as broken across audit rounds but were already correctly implemented:

| # | Item | Where | Reality |
|---|------|--------|---------|
| FF-1 | Invoice payment endpoint lacks idempotency key | §4.4, §9.4 | `providerPaymentOrderId` persisted atomically at order creation; subsequent POSTs reuse the existing Razorpay order. No double-charge path. *(Round 1)* |
| FF-2 | Audit export has no row-count limit — OOM risk | §2.7, §9.4 | `MAX_ITERATIONS=400` × `CSV_CHUNK_SIZE=500` = 200k-row hard ceiling via streaming cursor. *(Round 1)* |
| FF-3 | `/contracts` page missing `useRequireOrgAccess` guard | §6.1 | Guard present: `useRequireOrgAccess({ minRole: 'MAINTAINER', canSponsor: true })`. *(Round 1)* |
| FF-4 | `/contracts` and `/audit` not in sidebar | §6.1, §7.4 | Both in sidebar — Contracts `canSponsor && isAtLeast("MAINTAINER")`, Audit `isAtLeast("MAINTAINER")`. *(Round 1)* |
| FF-5 | MSME 15/45-day deadline calculator returns `invoiceDate + 60d` always | §5.4 | `computeMsmePaymentDeadline()` in `lib/compliance/msme.ts` implements full MICRO (15d) / SMALL (45d) / MEDIUM+NONE (`contract.defaultTermsDays`) logic. *(Round 1)* |
| FF-6 | `deriveGstBreakdown()` returns zero tax — no CGST/SGST/IGST computed | §5.1 | `lib/compliance/gst.ts:68–128` implements: zero-rated export for `buyerCountry !== "IN"` (IGST Act §16); intra-state CGST 9% + SGST 9% (`Math.round(taxPaise/2)` split); inter-state IGST 18%; HSN defaulting to 999293; `placeOfSupply` derivation. **Function is live.** Still missing: GSTIN registry API verify, reverse-charge routing, LUT enforcement, accountant signoff. *(Round 2)* |

### Real Issues Fixed

Eleven items fixed across two rounds (875/875 tests, tsc clean, no new DB migration in Round 2):

| # | Round | Issue | Fix Applied |
|---|-------|-------|-------------|
| FX-1 | R1 | `CHARGE_ORG` overage path crashed with Prisma P2002 (INVOICE_ACCRUAL source uniqueness) | Added `OVERAGE_INVOICE_ACCRUAL` to `PaymentLegSource` enum; credit-limit aggregation SUM updated; refund reversal handles both. Schema migrated. |
| FX-2 | R1 | `CHARGE_MEMBER` error said "booking succeeded" but was inside rolled-back Prisma tx | Code `OVERAGE_REQUIRES_SEPARATE_PAYMENT` → `PROGRAM_CAP_EXHAUSTED`; message directs user to contact org admin or use personal payment. |
| FX-3 | R1 | `BillingPageClient` showed "Payment terms: NET-60" for WALLET-funded orgs | StatCard conditional on `fundingSource !== "WALLET"`. |
| FX-4 | R1 | `/purchase-orders` and `/consent` had no sidebar entries (deep-link-only) | Purchase Orders (Receipt icon, `canSponsor && MAINTAINER+`) and Consent (ShieldCheck icon, `MANAGER+`) added to sidebar. |
| FX-5 | R1 | `jobs/compliance/irp-uploader.ts` header implied `lib/compliance/irp.ts` was a stub | Header rewritten: cron was scaffolded/unwired; underlying `generateIrn()` connector makes real ClearTax HTTP calls when env vars configured. |
| FX-6 | R1 | `POST /api/organizations/[orgId]/invitations` had no per-org rate limit | `orgInviteLimiter` — 20/hr per `orgId` Upstash sliding-window — applied before Serializable transaction. |
| FX-7 | R1 | `serializeOrgFilter` maps `__personal__` → `"none"` but `resolveOrgScope` expects `"personal"` | TODO #674 comment added to `lib/dashboard/org-context-filter.ts` documenting required rename + atomicity constraint. |
| RX-1 | R2 | IRP uploader cron had no GH Actions schedule | New `.github/workflows/irp-uploader.yml` at daily **02:30 UTC**; `require.main === module` self-executor + `prisma.$disconnect()` in `finally` added. Picks up env-gated ClearTax connector; records FAILED status without crashing when env vars absent. |
| RX-2 | R2 | MSME payment alerts cron had no GH Actions schedule | New `.github/workflows/msme-payment-alerts.yml` at daily **04:30 UTC**; self-executor + disconnect added; stale "derivation is a stub" header removed. |
| RX-3 | R2 | No cron tracked the 72-hour DPDP DataBreach reporting deadline | New `jobs/compliance/databreach-deadline-alerts.ts` + `.github/workflows/databreach-deadline-alerts.yml` at **hourly**. Sweeps `DataBreach WHERE reportedAt IS NULL AND detectedAt + 60h < now` (≤12h before cutoff through past-cutoff). Emails DPDP-officer inbox via Resend (`DATABREACH_ALERT_EMAIL`); structured-log fallback (`event: "dpdp.databreach.deadline"`) fires without email config. Closes deadline-tracking sub-item of #701. |
| RX-4 | R2 | HRIS CSV upload route had no body size cap — large JSON blob could exhaust process memory | `app/api/organizations/[orgId]/hris/csv-upload/route.ts` now inspects `Content-Length` up-front; returns 413 `PAYLOAD_TOO_LARGE` for bodies > 5 MB before `req.json()` buffers anything. Zod 5,000-row cap retained. |

---

## Section 1 — Schema & Data Model (Weight: 10 pts | Score: 9.5/10)

All 60+ enterprise models are production-final. No placeholder or nullable-where-required fields. Enums exhaustive. Index strategy sound.

### 1.1 Core Organization Models

- [x] ✅ `Organization` — 40+ fields: capability booleans (`canSponsor`, `canHost`), GST/PAN/GSTIN, hierarchy columns (`parentId`, `rootId`, `depth`), branding, policies, marketplace visibility, all relations
- [x] ✅ `Membership` — typed join table with `MemberRole` rank ladder (OWNER → MAINTAINER → MANAGER → EXPERT → LEARNER → SUPPORT), `payoutRecipient`, `rateCardOverrideId`, `programAssignments`, dual-profile linkage
- [x] ✅ `OrgWorkspaceProfile` — per-user operator profile for multi-org operators; unique on `userId`
- [x] ✅ `OrgAuditLog` — 9 categories (`MEMBER`, `CONTRACT`, `PROGRAM`, `WALLET`, `INVOICE`, `PAYOUT`, `SETTINGS`, `CONSENT`, `CATALOG`, `SYSTEM`), actor/target membership IDs, details JSON
- [x] ✅ `OrgDomainClaim` — `verificationToken`, `verifiedAt`; DNS TXT check flow
- [x] ✅ `OrganizationSSOSettings` — `allowedEmailDomains[]`, `enforceSSO`, `defaultRoleForAutoJoin`

### 1.2 Billing, Contracts & Programs

- [x] ✅ `BillingAccount` — `fundingSource` enum (PERSONAL/LICENSE/WALLET/INVOICE), `walletBalance`, `creditLimit`, wallet floor + auto-top-up (`minBalancePaise`, `autoTopUpEnabled/AmountPaise/MandateId`), all relations *(PROJECT dropped — fixed in v2; auto-top-up added #777 §C)*
- [x] ✅ `Contract` — status machine (DRAFT→ACTIVE→EXPIRED/TERMINATED), `autoRenew`+`autoRenewedAt`, supersession chain (`supersededByContractId`, `supersessionReason`), `rateCardId`, `purchaseOrderId` *(supersession added in v2 — #779 §A)*
- [x] ✅ `Program` — `ProgramType` (LICENSED_SEAT/CREDIT_POOL), `OverageBehavior` (BLOCK/CHARGE_MEMBER/CHARGE_ORG), `configLockedAt`, `archivedAt`, `coveredPlanTypes[]`, `allowedCategories[]` *(PROJECT/RETAINER dropped; lock/archive added in v2 — #779 §B)*
- [x] ✅ `LicensedSeatConfig` — `ratePerSeatPaise`, `BillingCycle`, `coveredEngagementsPerCycle`, `overageBehavior`, `overageSurchargeBps`, `maxOveragePerCyclePaise`, `activeSeatCount`, `priceCapPerEngagementPaise`
- [x] ✅ `CreditPoolConfig` — `cycle`, `creditBudgetPerCycle`, `minimumCreditsPerPeriod`, `overageBehavior`, `overageSurchargeBps`, `maxOveragePerCyclePaise`
- [x] ✅ `ProgramAssignment` — `periodStart/End`, `engagementsUsed`, `consumedPaise` (CREDIT_POOL money-meter), `overageCount`, `status` (`AssignmentStatus`), rollover self-relation (`rolledToAssignmentId`/`rolledAt`); unique on `(programId, membershipId, periodStart)` *(status + meter + rollover added in v2 — #779 §A)*
- [x] ✅ `OverageEvent` — append-only over-cap charge ledger (`basePaise`+`surchargePaise`=`marginalPaise`, `OverageChargeStatus`, member-charge timeout telemetry); relations to `ProgramAssignment`/`BookingUtilization`/`InvoiceLineItem`/`Payment` *(added in v2 — #778)*
- [x] ✅ `BookingUtilization` — `engagementsConsumed`, `priceAtBookingPaise`, `wasOverage`, BPS snapshot fields, `reversedAt`, `appointmentIds[]`

### 1.3 Wallet & Ledger

> *(corrected in v2 — #771):* the three single-entry logs (`WalletEntry` + `FundingLedgerEntry` + `SettlementLedgerEntry`) were collapsed into ONE balanced double-entry journal. The rows below describe the **current** schema, not the Round-2 shape.

- [x] ✅ `WalletTopUp` — top-up lifecycle (`providerOrderId @unique` idempotency, `WalletTopUpStatus` PENDING→CONFIRMED/FAILED, `capturedAt`); the wallet *balance* is a credit-normal liability in the ledger, not a standalone log
- [x] ✅ `LedgerAccount` / `LedgerEntry` / `LedgerTransaction` — double-entry journal: every cash event is a `LedgerTransaction` (`idempotencyKey @unique`) whose `LedgerEntry` DEBIT/CREDIT legs satisfy Σ(Dr)==Σ(Cr); reversals are counter-transactions, never row edits
- [x] ✅ `LedgerAccountBalance` — derived running-balance cache (Σ Dr − Σ Cr) the reconcile cron validates against the journal
- [x] ✅ `LedgerReconciliationReport` — `summary JSON`, `findings JSON`, `ok Boolean`, `durationMs`

### 1.4 Payout Pipeline

- [x] ✅ `OrganizationPayoutAccount` — encrypted account details, `razorpayContactId`, `razorpayFundAccountId`, `stripeConnectId`, `OrgPayoutAccountStatus`
- [x] ✅ `OrganizationEarnings` — BPS snapshot, `EarningStatus` (PENDING/HELD/RELEASED/PAID/REFUNDED/PENDING_TRUST), `holdUntil`, `orgPayoutId`
- [x] ✅ `OrganizationPayout` — all India statutory fields (`tdsSectionApplied`, `tdsAmountPaise`, `mustPayByDate`, `form15caPartCRef`, `form15cbRef`, `dtaaRateApplied`, `rbiPurposeCode`, `fxRateUsed`, `firceRef`), `clawbackAmountPaise`, `idempotencyKey @unique`

### 1.5 Invoicing

- [x] ✅ `OrganizationInvoice` — GST breakdown (`igstPaise`, `cgstPaise`, `sgstPaise`, `taxRate`, `placeOfSupply`, `reverseCharge`, `lutNumber`, `gstin`, `hsnCode`); e-invoice fields (`irn`, `ackNumber`, `ackDate`, `signedQrPayload`, `irpStatus`, `irpRetryCount`); `OrgInvoiceStatus` (DRAFT/ISSUED/PAID/OVERDUE/VOID/CANCELLED/REFUNDED)
- [x] ✅ `PurchaseOrder` — `remainingAmountPaise` enforced at invoice creation (409 if exceeded)

### 1.6 Compliance Models

- [x] ✅ `ConsentArtifact` — real SHA-256 hash, `retainUntil` (7-year), `withdrawnAt`
- [x] ✅ `DataBreach` — `detectedAt`, `reportedToDpdpBoardAt`, `affectedUserCount`; hourly deadline-tracker cron now scheduled *(RX-3)*
- [x] ✅ `HrisConfig` — `HrisProvider` (WORKDAY/BAMBOOHR/SAP/ORACLE), `tenantKey`, `lastSyncedAt`, `active`, `syncJobs[]`, `employeeMap[]`
- [x] ✅ `PaymentLeg` — CARD/WALLET/REFERRAL_CREDIT/INVOICE_ACCRUAL/**OVERAGE_INVOICE_ACCRUAL**/LICENSE; `@@unique([paymentId, source])`; `OVERAGE_INVOICE_ACCRUAL` added *(FX-1)*

### 1.7 Org-Scope Anchors

- [x] ✅ `Organization.appointmentsByOrg`, `waitlistByOrg`, `recordingsByOrg`, `trialsByOrg`, `payments` — FK relations on schema
- [x] ✅ `Appointment.organizationId` — populated at checkout for org-context bookings across all four product types (`lib/payments/operations/checkout.ts`)
- [x] ✅ `Waitlist.organizationId` — resolved via `resolveEventHostOrgId` and stamped on the four `prisma.waitlist.create` paths in checkout's catch blocks
- [x] ✅ `Recording.organizationId` — stamped on both the success (`recordingReady`) and failure (`recordingFailed`) handlers in `lib/stream/recording-handlers.ts` from the parent appointment's org tag
- [x] 🟡 Stream channel `custom.organizationId` is set by the canonical server-side creation path (`lib/meeting.ts`); the client-side fallback in `useGetCallById` now accepts an `organizationId` prop but callers (`app/meetings/[id]/page.tsx`) don't yet thread it. Minor — only fires for stray meeting links.

---

## Section 2 — Enterprise Core: Auth / Membership / Contracts / Programs (Weight: 15 pts | Score: 13.0/15)

### 2.1 Authentication & Authorization

- [x] ✅ BetterAuth organization plugin wired (`lib/auth.ts:326-329`)
- [x] ✅ SSO plugin + domain verification (`lib/auth.ts:336`)
- [x] ✅ `customSession` callback injects `orgWorkspaceProfileId` + `organizationMemberships` into every session
- [x] ✅ `shouldRejectSession` — blocks login for SSO-enforced domain users without enrolled SSO provider
- [x] ✅ `requireOrgAccess(orgId)` enforced on all 54+ enterprise API routes
- [x] ✅ `requireOrgOwner` enforced on destructive operations (delete org, SSO config, domain claims, payout account)
- [x] ✅ Platform ADMIN bypass with synthesized OWNER-rank stub (capability checks preserved)
- [x] ✅ IDOR guard on OrgWorkspace endpoints (`orgWorkspaceProfileId` match)
- [x] ✅ Middleware blocks unauthenticated access to `/api/organizations/*` prefix
- [x] ✅ Public exceptions declared: `/api/organizations/public/*`, `/api/organizations/invitations/accept`
- [x] 🟡 Live OIDC label fix + `userId` on org-scoped providers — deferred (#670, #672)

### 2.2 Org Lifecycle

- [x] ✅ Org creation wizard — atomic transaction: Organization + BillingAccount + Membership (OWNER) + OrgWorkspaceProfile
- [x] ✅ Slug uniqueness in Serializable transaction (no TOCTOU)
- [x] ✅ `OrgStatus` machine: PENDING_VERIFICATION → ACTIVE → SUSPENDED / DEACTIVATED
- [x] ✅ 409 `ORG_NOT_VERIFIED` on org side-effects before admin approval
- [x] ✅ Admin org verification page (`/dashboard/admin/organizations`)
- [x] ✅ Soft-delete only — by design for audit trail
- [x] 🟡 GSTIN live API verification — format-only (15-char regex); registry lookup deferred to PR-2

### 2.3 Membership Lifecycle

- [x] ✅ Member add (MAINTAINER+), role-change, remove with Serializable transaction
- [x] ✅ Last-OWNER anti-lockout guard (409 on removing last OWNER)
- [x] ✅ Bulk member endpoint returns 405 intentionally (bulk ops skip anti-lockout guard)
- [x] ✅ `MemberRole` rank ladder: `isAtLeast()` utility for capability checks
- [x] ✅ Invitation lifecycle: send, expire (max 30 days), accept (token-gated), revoke
- [x] ✅ `UNVERIFIED_ORG_SEAT_CAP` enforced at invite-send time
- [x] ✅ Novu `ORG_INVITE_SENT` + `ORG_INVITE_ACCEPTED` workflows wired
- [x] ✅ `orgInviteLimiter` — 20/hr per `orgId` (Upstash sliding-window) applied at `POST /invitations` *(FX-6)*

### 2.4 Contracts & Programs

- [x] ✅ Contract CRUD with `canSponsor` + `requireActive` capability gates
- [x] ✅ Contract status machine: DRAFT → ACTIVE → EXPIRED / TERMINATED
- [x] ✅ `autoRenew` flag + `effectiveFrom/To` date validation
- [x] ✅ Program CRUD under contracts (`LICENSED_SEAT`, `CREDIT_POOL`)
- [x] ✅ ProgramAssignment lifecycle: assign, update, remove
- [x] ✅ Engagement cap counting: CONSULTATION (1) / WEBINAR (1) / CLASS (N per day) / SUBSCRIPTION (1 lazy per allocation) — tested in #710
- [x] ✅ `ProgramAssignmentLimitError` raised on cap exhaustion → Novu `ORG_PROGRAM_EXHAUSTED` fired
- [x] ✅ `OverageBehavior.BLOCK` — checkout rejected at cap
- [x] ✅ `OverageBehavior.CHARGE_ORG` — overage leg uses `OVERAGE_INVOICE_ACCRUAL` source; P2002 crash eliminated *(FX-1)*
- [x] ✅ `OverageBehavior.CHARGE_MEMBER` — correctly throws `PROGRAM_CAP_EXHAUSTED` (tx rolled back, user directed to personal payment) *(FX-2)*
- [x] ✅ Cycle engine (`AssignmentStatus` rollover, contract auto-renew/cascade) — `lib/enterprise/cycle-engine.ts` + `advance-program-cycles`/`auto-renew-contracts`/`expire-contracts` crons *(fixed in v2 — #779 §A; the old `PROJECT`/`RETAINER` enum values were dropped, not built)*

### 2.5 Rate Cards

- [x] ✅ 7-level override chain resolved deterministically
- [x] ✅ BPS snapshot on `OrganizationEarnings` (`platformBpsApplied`, `orgBpsApplied`, `consultantBpsApplied`)
- [x] ✅ Rate card CRUD under org (`/api/organizations/[orgId]/rate-cards`)

### 2.6 Purchase Orders

- [x] ✅ PurchaseOrder CRUD (number, amount, status, linked to org + contract)
- [x] ✅ `remainingAmountPaise` decremented on invoice issue; 409 if invoice exceeds PO balance
- [x] ✅ `Organization.requiresPO` checked at invoice creation

### 2.7 Audit Log

- [x] ✅ `OrgAuditLog.create()` called on 40+ enterprise route handlers
- [x] ✅ `AUDIT_ACTIONS` enum drives consistent action strings
- [x] ✅ Queryable by category / action / date range; cursor-paginated
- [x] ✅ CSV export endpoint (`POST /api/organizations/[orgId]/audit/export`)
- [x] ✅ ~~Audit export has no row-count limit~~ — `MAX_ITERATIONS=400` × `CSV_CHUNK_SIZE=500` = 200k-row ceiling; streaming cursor *(FF-2)*

---

## Section 3 — Booking + Payment Algorithm (Weight: 15 pts | Score: 12.75/15)

### 3.1 Stackable Payment Legs

- [x] ✅ `PaymentLeg` model: CARD / WALLET / REFERRAL_CREDIT / INVOICE_ACCRUAL / **OVERAGE_INVOICE_ACCRUAL** / LICENSE
- [x] ✅ Sum-identity invariant: `Σ(amountPaise) = Payment.amount` enforced before commit
- [x] ✅ Source-uniqueness: `@@unique([paymentId, source])` — `OVERAGE_INVOICE_ACCRUAL` distinct from `INVOICE_ACCRUAL` eliminates P2002 on `CHARGE_ORG` overage *(FX-1)*
- [x] ✅ `sourceRef` always populated for WALLET/REFERRAL_CREDIT legs (join key for reversal)
- [x] ✅ Credit-limit aggregation SUM covers both `INVOICE_ACCRUAL` + `OVERAGE_INVOICE_ACCRUAL` *(FX-1)*

### 3.2 Wallet Funding Flow (fundingSource=WALLET)

- [x] ✅ `walletDebit()` — conditional UPDATE inside Serializable transaction (insufficient balance → 409)
- [x] ✅ Booking debit posts a balanced `LedgerTransaction` (Dr WALLET / Cr …) — *fixed in v2: the old `WalletEntry`+`FundingLedgerEntry` dual-write collapsed into the double-entry journal (#771/#772)*
- [x] ✅ Top-up: Razorpay order → `WalletTopUp(status=CONFIRMED)` + ledger post on webhook → `providerOrderId @unique` (idempotency)
- [x] ✅ Org-keyed rate limit on wallet top-ups (middleware, `org:<orgId>` bucket)

### 3.3 Invoice Funding Flow (fundingSource=INVOICE)

- [x] ✅ At checkout: `PaymentLeg(source=INVOICE_ACCRUAL, amountPaise=booking_price)` — no money moves
- [x] ✅ Credit-limit enforcement at checkout (409 if exceeded)
- [x] ✅ PENDING_TRUST gate: unverified INVOICE orgs earn `EarningStatus.PENDING_TRUST`
- [x] 🟡 Monthly invoice roll-up cron — job body scaffolded; needs GH Actions schedule

### 3.4 License Funding Flow (fundingSource=LICENSE + LICENSED_SEAT)

- [x] ✅ Active `ProgramAssignment` check at checkout (cap enforced before payment)
- [x] ✅ `PaymentLeg(source=LICENSE, amountPaise=0)` + `BookingUtilization.engagementsConsumed` incremented atomically
- [x] ✅ Proportional reversal on refund: `engagementsConsumed` decremented + `reversedAt` set

### 3.5 GST Tax Engine

- [x] ✅ `determineTax()` in `lib/payments/tax/tax-engine.ts` — CGST/SGST vs IGST routing
- [x] ✅ `placeOfSupply` captured from org's GST state code
- [x] ✅ Fields captured on `Payment` + rolled into `OrganizationInvoice`
- [x] ✅ ~~`deriveGstBreakdown()` returns zero tax~~ — `lib/compliance/gst.ts:68–128` is live: zero-rated export (`buyerCountry !== "IN"`), intra-state CGST 9%+SGST 9%, inter-state IGST 18%, HSN 999293 default *(FF-6)*

### 3.6 Org-Scoped Booking Context

- [x] ✅ `Payment.organizationId` captured on all org-sponsored bookings
- [x] ✅ Billing / discount currency validation at checkout
- [x] ✅ Referral credits scoped to `organizationId`
- [x] ✅ `Appointment.organizationId`, `Waitlist.organizationId`, `Recording.organizationId` are populated at write time across checkout + recording webhook paths (Round 3 close-out 2026-05-15). See §1.7 for evidence.

### 3.7 Slot Allocation & Booking Guards

- [x] ✅ `SlotAllocationService` — Redis lock, P2002 → 409, overnight UTC support
- [x] ✅ `validateNoConflicts` — scoped to consultant via M2M relation
- [x] ✅ Concurrent auto-allocate guard for classes
- [x] ✅ `planId` + `paymentGateway` required at checkout for all event types

### 3.8 Refunds

- [x] 🟡 Canonical refund op (`lib/payments/operations/refund.ts`) — single-leg refund works
- [x] 🔴 Multi-leg refund — incomplete reversal when WALLET + INVOICE_ACCRUAL used simultaneously; `OVERAGE_INVOICE_ACCRUAL` credit-note tracked in TODO #716
- [x] 🔴 Payout clawback (`clawbackAmountPaise` field) — no trigger on post-payout refund (#715)

---

## Section 4 — Finances: Payouts / Earnings / Refunds (Weight: 15 pts | Score: 7.05/15)

No money moves until PR-3 is shipped.

### 4.1 OrgEarnings Roll-up

- [x] ✅ `OrganizationEarnings` created on every org-sponsored payment
- [x] ✅ BPS snapshot (platformBpsApplied, orgBpsApplied, consultantBpsApplied)
- [x] ✅ `EarningStatus` machine: PENDING → HELD / RELEASED → PAID / REFUNDED / PENDING_TRUST
- [x] ✅ `holdUntil` set for dispute hold period
- [x] ✅ `PENDING_TRUST` → `RELEASED` triggered when org ACTIVE or first invoice paid
- [x] 🟡 Earnings release cron — wired in GH Actions; not load-tested

### 4.2 Payout State Machine

- [x] ✅ `OrganizationPayout` machine: PENDING → APPROVED → PROCESSING → COMPLETED / FAILED / CANCELLED
- [x] ✅ Admin approval gate before PROCESSING
- [x] ✅ Weekly payout cron — rolls up RELEASED earnings into payout batch
- [x] ✅ `idempotencyKey @unique` prevents duplicate cron runs
- [x] ✅ `gatewayPayoutId @unique`, `gatewayUtr`, `gatewayResponseRaw JSON` — ready for webhook reconciliation
- [x] 🟡 PROCESSING → COMPLETED — `NotImplementedError` behind `ENABLE_LIVE_PAYOUTS`; admin can manually move today
- [x] 🔴 RazorpayX `payouts.create` — **not implemented** (PR-3)
- [x] 🔴 Stripe Connect `transfers` — **not implemented** (PR-3)
- [x] 🔴 Webhook reconciler (PROCESSING → COMPLETED on gateway event) — not wired (PR-3)
- [x] 🔴 Payout clawback trigger (`clawbackAmountPaise`) — field exists; no clawback flow (#715)

### 4.3 Payout Account Verification

- [x] ✅ `OrganizationPayoutAccount` with `OrgPayoutAccountStatus`
- [x] ✅ Real bank-account encryption (AES-256, `accountNumberEncrypted` + `accountNumberLast4`)
- [x] ✅ Payout account CRUD (OWNER only)
- [x] 🟡 Razorpay contact + fund account registration — fields exist; live registration deferred to PR-3
- [x] 🔴 Penny-drop verification — not implemented

### 4.4 Invoice Payment

- [x] ✅ Invoice state machine: DRAFT → ISSUED → PAID / OVERDUE / VOID / CANCELLED / REFUNDED
- [x] ✅ Manual payment route (`POST .../invoices/[id]/pay`)
- [x] ✅ `dueDate` set at issuance; overdue detection in admin list view
- [x] ✅ `paidAt` populated on payment confirmation
- [x] ✅ ~~Lacks idempotency key~~ — `providerPaymentOrderId` persisted atomically; subsequent POSTs reuse existing Razorpay order *(FF-1)*
- [x] 🟡 Invoice payment auto-routing (Razorpay vs Stripe) — manual payment only today

### 4.5 Cross-Org Billing (OrgWorkspace)

- [x] ✅ `GET /api/org-workspace/[orgWorkspaceId]/billing` — cross-org invoice + wallet roll-up (IDOR-gated)
- [x] ✅ Cross-org billing page
- [x] ✅ NET-60 StatCard conditional on `fundingSource !== "WALLET"` *(FX-3)*
- [x] 🟡 `/billing` vs `/credits` two-page structure — docs say unified; two pages still in code (NET-60 copy drift fixed; full unification deferred)

---

## Section 5 — India Compliance: GST / TDS / MSME / IRN / FEMA (Weight: 10 pts | Score: 4.5/10)

GST derivation, MSME deadline calculator, and IRP connector are all live. Cron schedules now wired for IRP, MSME, and DataBreach. Remaining PR-2 blockers: TDS live withholding, GSTIN registry, RCM/LUT, Form 15CA/CB.

### 5.1 GST

- [x] ✅ Schema: `Organization.gstin`, `gstStateCode`, `gstRegStatus`, `pan`, `hsnDefault` (999293)
- [x] ✅ Schema: `OrganizationInvoice` — `igstPaise`, `cgstPaise`, `sgstPaise`, `taxRate`, `placeOfSupply`, `reverseCharge`, `lutNumber`, `gstin`, `hsnCode`
- [x] ✅ ~~`deriveGstBreakdown()` returns zero tax~~ — `lib/compliance/gst.ts:68–128` live: zero-rated export for `buyerCountry !== "IN"`, intra-state CGST 9%+SGST 9%, inter-state IGST 18%, HSN 999293 default, `placeOfSupply` derivation *(FF-6)*
- [x] 🔴 GSTIN live API verification (registry lookup) — format-only (15-char regex); live lookup deferred to PR-2
- [x] 🔴 Reverse charge mechanism for imports — `reverseCharge` field exists; no routing logic
- [x] 🔴 LUT zero-rating for exports — `lutNumber` field exists; no enforcement

### 5.2 E-Invoice (IRN / IRP)

- [x] ✅ Schema: `irn`, `ackNumber`, `ackDate`, `signedQrPayload`, `irpStatus`, `irpRetryCount`, `irpLastError`, `irpLastAttemptAt`, `irpUploadedAt`; `IrpStatus` enum
- [x] ✅ `generateIrn()` in `lib/compliance/irp.ts` — real ClearTax HTTP calls when `CLEARTAX_API_KEY` / `CLEARTAX_GSP_TOKEN` / `CLEARTAX_GSTIN` configured; env-gated, not a stub *(FF-5 / FX-5)*
- [x] ✅ Daily IRP upload cron — `.github/workflows/irp-uploader.yml` at **02:30 UTC**; `require.main === module` self-executor + `prisma.$disconnect()` in `finally`; records FAILED status when env vars absent *(RX-1)*
- [x] 🔴 IRN cancellation flow — schema only
- [x] 🔴 Production approval checklist for IRP (ClearTax sandbox proof + payload validation + accountant signoff) — needed before PR-2 go-live

### 5.3 TDS (194J / 194O / 194C)

- [x] ✅ Schema: `OrganizationPayout.tdsSectionApplied`, `tdsAmountPaise`, `dtaaRateApplied`, `rbiPurposeCode`
- [x] ✅ Schema: `ConsultantProfile.tdsSection`, `panStatus`, `isMsme`, `msmeRegistrationNumber`
- [x] 🟡 `computeTdsForPayout()` — returns `{ tdsSection: "194J", tdsRate: 0.10, tdsAmountPaise: 0 }` (no actual withholding); PR-2 lands live derivation
- [x] 🔴 Section selection logic (194J vs 194O vs 194C) — not implemented
- [x] 🔴 206AA 20% fallback for missing/invalid PAN — not enforced
- [x] 🔴 DTAA rate lookup per treaty country — stub returns null
- [x] 🔴 TDS certificate (Form 16A) generation — not implemented
- [x] 🔴 26Q quarterly TDS filing — not implemented

### 5.4 MSME 43B(h) Compliance

- [x] ✅ Schema: `OrganizationPayout.mustPayByDate`; `ConsultantProfile.isMsme`, `msmeRegistrationNumber`, `msmeType`
- [x] ✅ `computeMsmePaymentDeadline()` in `lib/compliance/msme.ts` — live: MICRO → 15d, SMALL → 45d, MEDIUM/NONE → `contract.defaultTermsDays` *(FF-5)*
- [x] ✅ MSME deadline alert cron — `.github/workflows/msme-payment-alerts.yml` at **04:30 UTC**; sweeps payouts ≤5 days from `mustPayByDate`; emails `MSME_ALERT_EMAIL` via Resend; structured-log to `#finance-alerts` sink *(RX-2)*

### 5.5 FEMA / Cross-border (Form 15CA/15CB / FIRC)

- [x] ✅ Schema: `OrganizationPayout.form15caPartCRef`, `form15cbRef`, `firceRef`, `fxRateUsed`; `Organization.parentCountry`, `parentEntityType`, `isGCC`
- [x] 🔴 Form 15CA-CB live workflow — stub only; CA partner integration required for cross-border payouts
- [x] 🔴 FIRC tracking — field exists; no bank API fetch

### 5.6 DPDP (Digital Personal Data Protection)

- [x] ✅ `ConsentArtifact` — real SHA-256 hash, `retainUntil` (7-year), `withdrawnAt`, consent categories
- [x] 🟡 DataBreach 72-hour deadline tracker — hourly cron `jobs/compliance/databreach-deadline-alerts.ts` scheduled; emails DPDP-officer inbox (`DATABREACH_ALERT_EMAIL`) + structured-log fallback; fires ≤12h before cutoff through past-cutoff *(RX-3)*. **Still pending:** Novu admin fan-out, full DataBreach UI (#701)
- [x] 🔴 `checkConsent()` — always returns `true` (stub); no actual consent gate on data access (#701)
- [x] 🔴 Consent withdrawal cascade — field exists; no downstream revocation (#701)
- [x] 🔴 Retention-sweeper cron (purge data past `retainUntil`) — not implemented (#701)

---

## Section 6 — Dashboards & UI (Weight: 10 pts | Score: 8.5/10)

### 6.1 Organization Dashboard Pages (35 pages)

- [x] ✅ `/dashboard/organization/(switcher)/` — org switcher landing + create wizard
- [x] ✅ `/dashboard/organization/[orgId]/home` — capability-driven overview, role-branched consumer card
- [x] ✅ `/dashboard/organization/[orgId]/members` — member list, invite, role-change, remove (MANAGER+)
- [x] ✅ `/dashboard/organization/[orgId]/learners` — filtered LEARNER roster (`canSponsor` only)
- [x] ✅ `/dashboard/organization/[orgId]/experts` — filtered EXPERT roster (`canHost` only)
- [x] ✅ `/dashboard/organization/[orgId]/invitations` — pending invites, status filter (MAINTAINER+)
- [x] ✅ `/dashboard/organization/[orgId]/my-program` — LEARNER per-org allocation (ProgramAssignment progress, coverage, utilization)
- [x] ✅ `/dashboard/organization/[orgId]/my-arrangement` — EXPERT per-org payout view (payoutRecipient, RateCard, earnings)
- [x] ✅ `/dashboard/organization/[orgId]/programs` — LICENSED_SEAT/CREDIT_POOL programs + assignments (MAINTAINER+, canSponsor)
- [x] ✅ `/dashboard/organization/[orgId]/contracts` — `useRequireOrgAccess({ minRole: 'MAINTAINER', canSponsor: true })` guard present *(FF-3)*; in sidebar *(FF-4)*
- [x] ✅ `/dashboard/organization/[orgId]/purchase-orders` — sidebar entry added (Receipt icon, `canSponsor && MAINTAINER+`) *(FX-4)*
- [x] ✅ `/dashboard/organization/[orgId]/billing` — NET-60 StatCard conditional on `fundingSource !== "WALLET"` *(FX-3)*
- [x] ✅ `/dashboard/organization/[orgId]/billing` (Wallet tab) — balance + top-up + auto-top-up settings (WALLET orgs) *(fixed in v2: no separate `/credits` route; history reads the ledger, not `WalletEntry`)*
- [x] ✅ `/dashboard/organization/[orgId]/payouts` — payout history + TDS summary (MANAGER+, canHost)
- [x] ✅ `/dashboard/organization/[orgId]/analytics` — bookings, revenue, earnings, wallet burn-down (MANAGER+)
- [x] ✅ `/dashboard/organization/[orgId]/settings` — branding, billing email, PO requirement, logo (MAINTAINER+)
- [x] ✅ `/dashboard/organization/[orgId]/settings/sso` — SSO provider + domain config (OWNER only)
- [x] ✅ `/dashboard/organization/[orgId]/audit` — OrgAuditLog viewer + CSV export; in sidebar *(FF-4)*
- [x] ✅ `/dashboard/organization/[orgId]/consent` — ConsentArtifact roster + DPDP breach log; sidebar entry added (ShieldCheck icon, `MANAGER+`) *(FX-4)*
- [x] ✅ `/dashboard/organization/[orgId]/documents` — org branding docs
- [x] ✅ `/dashboard/organization/[orgId]/waitlist|trials|appointments|recordings` — pages exist; data not yet org-scoped (#674)
- [x] ✅ `/dashboard/organization/[orgId]/catalog/search` — search consultants/plans available to org
- [x] 🟡 Analytics charts — stat cards live; time-series chart components deferred (#663)
- [x] 🟡 `/billing` vs `/credits` two-page structure — NET-60 copy drift fixed; full unification deferred

### 6.2 OrgWorkspace (4 pages)

- [x] ✅ home, activity, billing, settings, create — all present with IDOR guard on layout

### 6.3 Public Enterprise Pages

- [x] ✅ `/explore/enterprise/organisations` — org directory (`isPublic=true`)
- [x] ✅ `/explore/enterprise/organisations/[orgSlug]` — single org public profile for booking

### 6.4 Admin Dashboard (21 pages)

- [x] ✅ organizations, payments, refunds, payouts, invoices, disputes, system-jobs, analytics, and 13 others — all present

### 6.5 Staff Dashboard (16 pages)

- [x] ✅ All 16 staff pages present and wired

---

## Section 7 — Org Context / Switchers / Filters (Weight: 8 pts | Score: 7.2/8)

### 7.1 Session & Identity

- [x] ✅ `OrgWorkspaceProfile` created atomically with first org; backfill script for existing owners
- [x] ✅ `customSession` injects `orgWorkspaceProfileId` + `organizationMemberships[]`
- [x] ✅ `resolvePersonalDashboardHref` priority chain: orgWorkspaceProfile → consultantProfile → consulteeProfile

### 7.2 Organization Switcher

- [x] ✅ `<OrganizationSwitcher />` — dropdown in top bar; no context loss on role change

### 7.3 IDOR Guards

- [x] ✅ Org layout: server-side `requireOrgAccess` check
- [x] ✅ OrgWorkspace layout: `orgWorkspaceId` must match session
- [x] ✅ 404 on URL-guessing; every API route calls `requireOrgAccess(orgId)` before returning data

### 7.4 Sidebar Visibility Filters

- [x] ✅ Sidebar memoized; gated by `canSponsor`, `canHost`, `fundingSource`, `MemberRole.isAtLeast()`
- [x] ✅ `/contracts` — in sidebar `canSponsor && isAtLeast("MAINTAINER")` *(FF-4)*
- [x] ✅ `/audit` — in sidebar `isAtLeast("MAINTAINER")` *(FF-4)*
- [x] ✅ `/purchase-orders` — sidebar entry added *(FX-4)*
- [x] ✅ `/consent` — sidebar entry added *(FX-4)*

### 7.5 Admin & Staff Org Filters

- [x] ✅ Admin org list with status filter, search; detail view with capability toggles + state machine controls
- [x] ✅ `useOrgScope` hook + query factory built for staff-facing pages
- [x] 🟡 `useOrgScope` not mounted on all admin/staff pages that could benefit (#674)

### 7.6 OrgContextFilter Serialization

- [x] 🟡 `serializeOrgFilter` maps `__personal__` → `"none"` but `resolveOrgScope` expects `"personal"` — no live breakage today; TODO #674 comment added to `lib/dashboard/org-context-filter.ts` *(FX-7)*

---

## Section 8 — Cross-cutting Integrations (Weight: 7 pts | Score: 4.9/7)

### 8.1 Novu (Notifications)

- [x] ✅ `lib/novu/org-workflows.ts` — 10 enterprise-scoped workflows with roster resolvers
- [x] ✅ Non-throwing; no-op if `NOVU_API_KEY` absent
- [x] ✅ Wired: `ORG_INVITE_SENT/ACCEPTED`, `ORG_INVOICE_ISSUED/PAID`, `ORG_WALLET_TOPUP_CONFIRMED`, `ORG_PAYOUT_COMPLETED/FAILED/REVERSED`, `ORG_PROGRAM_EXHAUSTED`, `ORG_SSO_PROVIDER_DELETED`, `ORG_SSO_CERT_EXPIRING`
- [x] 🟡 DataBreach deadline notification — Resend email + structured-log now wired via `databreach-deadline-alerts.ts` cron *(RX-3)*; **Novu admin fan-out roster still pending** (#701)

### 8.2 Stream.io (Video & Chat)

- [x] ✅ `Organization.recordingsByOrg` + `Appointment.organizationId` FK anchors added
- [x] 🔴 Stream channel `custom.organizationProfileId` — not set at channel creation (#674)
- [x] 🔴 No enterprise recordings library (per-org browse/playback) (#367)
- [x] 🔴 Stream token generation is org-blind; no org-specific capabilities

### 8.3 BetterAuth SSO

- [x] ✅ Organization + SSO plugins wired; `OrgDomainClaim` DNS TXT verification
- [x] ✅ `shouldRejectSession` enforces SSO for domain-claimed orgs
- [x] ✅ SSO domain-check endpoint with 60/hr IP rate limit
- [x] ✅ `sso-cert-expiry-alert.yml` cron + `ORG_SSO_CERT_EXPIRING` Novu workflow
- [x] 🟡 Live OIDC — deferred (#670, #672); SAML only today

### 8.4 Razorpay / Stripe

- [x] ✅ Razorpay order for wallet top-ups; org-keyed rate limit
- [x] ✅ `OrganizationPayoutAccount.razorpayContactId` + `razorpayFundAccountId` fields
- [x] 🔴 RazorpayX `payouts.create` — not called; `ENABLE_LIVE_PAYOUTS=false` (PR-3)
- [x] 🔴 Stripe Connect `transfers` — not called (PR-3)
- [x] 🔴 No webhook handler for payout completion events

### 8.5 Resend / Email

- [x] 🟡 Org invite emails via Novu → Resend; not wired to org email templates directly. DataBreach + MSME alert emails sent via Resend directly *(RX-2, RX-3)*

---

## Section 9 — Crons & Operational Readiness (Weight: 5 pts | Score: 4.0/5)

### 9.1 Active & Scheduled Crons

| Cron | Schedule | Status |
|------|----------|--------|
| `generate-subscription-invoices.yml` | Daily 01:00 UTC | ✅ *(#813; concurrency group)* |
| `settle-invoice-accruals.yml` | Monthly 1st 04:00 UTC | ✅ *(#813; `ENABLE_CONSOLIDATED_INVOICE`-gated)* |
| `expire-contracts.yml` | Daily 03:00 UTC | ✅ |
| `cleanup-abandoned-org-top-ups.yml` | Daily 02:00 UTC | ✅ |
| `reconcile-ledgers.yml` | Nightly | ✅ |
| `release-pending-trust-earnings.yml` | GH Actions | ✅ |
| `process-payouts.yml` | Weekly | ✅ |
| `sso-cert-expiry-alert.yml` | Weekly | ✅ |
| `irp-uploader.yml` | Daily 02:30 UTC | ✅ *(RX-1, 2026-05-02)* |
| `msme-payment-alerts.yml` | Daily 04:30 UTC | ✅ *(RX-2, 2026-05-02)* |
| `databreach-deadline-alerts.yml` | Hourly | ✅ *(RX-3, 2026-05-02)* |

- [x] ✅ Cron schedule staggering avoids contention
- [x] ✅ `idempotencyKey @unique` on `OrganizationPayout` prevents duplicate cron runs
- [x] ✅ `orgInviteLimiter` — 20/hr per `orgId` Upstash sliding-window *(FX-6)*
- [x] ✅ `require.main === module` self-executor + `prisma.$disconnect()` in `finally` added to IRP + MSME jobs *(RX-6)*

### 9.2 Crons Still Needed

- [x] ✅ ~~`jobs/billing/generate-subscription-invoices.ts` — no GH Actions schedule~~ — now scheduled daily (01:00 UTC) with a `concurrency` group; the monthly accrual roll-up (`settle-invoice-accruals.ts`) is also scheduled (1st, 04:00 UTC, `ENABLE_CONSOLIDATED_INVOICE`-gated), absorbing the retired `consolidated-invoice-rollup` job (#813)
- [x] 🔴 HRIS sync cron — no connector; `HrisConfig.lastSyncedAt` never updated (#701)

### 9.3 Alerting & Observability

- [x] 🔴 All cron YAML files: `# TODO: wire to #ops-alerts Slack channel` — no failure notification; deferred until `SLACK_OPS_WEBHOOK_URL` secret provisioned (#709)
- [x] 🔴 No health-check service (Healthchecks.io / Betterstack) for cron heartbeat monitoring
- [x] 🔴 No Sentry alert on `LedgerReconciliationReport.ok = false`
- [x] 🔴 No structured log event taxonomy tied to PagerDuty / oncall rotation

### 9.4 Security & Ops Gaps

- [x] ✅ ~~Audit export has no row-count limit~~ — 200k-row ceiling via streaming cursor *(FF-2)*
- [x] ✅ ~~Invoice payment endpoint lacks idempotency key~~ — `providerPaymentOrderId` persisted atomically *(FF-1)*
- [x] ✅ HRIS CSV upload body-size guard — `Content-Length` inspected up-front; 413 `PAYLOAD_TOO_LARGE` for bodies > 5 MB before `req.json()` buffers *(RX-4)*
- [x] 🔴 No API key / M2M auth for HRIS sync — requires interactive UI session (#701)

---

## Section 10 — Testing & Type Safety (Weight: 5 pts | Score: 4.75/5)

- [x] ✅ **875/875 tests passing** (47 suites)
- [x] ✅ `tsc --noEmit` clean
- [x] ✅ TDS derivation tests; MSME deadline tests; payout/refund coverage
- [x] ✅ Booking algorithm E2E tests (Agents 001–006): all 4 event types, overnight slots, concurrent auto-allocate, validation, filtering, waitlist
- [x] ✅ 6 UI E2E test runs via Chrome DevTools MCP + Supabase MCP
- [x] ✅ `SlotAllocationService.classifyError` — P2002 → 409 tested
- [x] 🟡 No load/stress test on: PENDING_TRUST gate under concurrent INVOICE checkouts, reconcile cron under high volume
- [x] 🔴 No integration tests for enterprise API routes (only unit tests for helpers/services)

---

## Critical Path to First Paying B2B Tenant

| Priority | Workstream | Est. Effort | Gate Unlocked |
|----------|-----------|------------|---------------|
| **1** | **PR-2: India compliance go-live** | 1.5 weeks | GSTIN registry verify, TDS live withholding (194J/O/C), RCM/LUT enforcement, IRP ClearTax sandbox + accountant signoff, Form 15CA/CB workflow. *IRN cron + MSME cron already scheduled (RX-1/RX-2).* |
| **2** | **PR-3: Live payout + SSO** | 1.5 weeks | RazorpayX `payouts.create`, Stripe Connect `transfers`, webhook reconciler PROCESSING→COMPLETED, OIDC live (#670, #672) |
| **3** | **#674: Org scope split** | 2 weeks | Populate `Appointment/Waitlist/Recording.organizationId` at booking time; Stream channel org metadata; `OrgContextFilter` serialization fix |
| **4** | **#716 + #715: Refund + clawback** | 1.5 weeks | Multi-leg refund, payout clawback automation, `OVERAGE_INVOICE_ACCRUAL` credit-note |
| **5** | **Cron alerting (#709)** | 1 day | Slack `#ops-alerts` webhook when `SLACK_OPS_WEBHOOK_URL` provisioned |
| **6** | **#701: Remaining DPDP + HRIS** | 3 weeks | `checkConsent()` enforcement, withdrawal cascade, retention sweeper, HRIS sync cron, full DataBreach UI + Novu fan-out |
| **7** | **Soak window** | 2–4 weeks | `LedgerReconciliationReport.ok = true` for 14 consecutive nights before multi-tenant go-live |

**~10 weeks to self-serve multi-tenant enterprise.**
**With manual ops (one design-partner): PR-2 + PR-3 only (~3 weeks, reduced from 3.5 since IRP/MSME crons now scheduled).**

---

## Do-Not-Build List (Confirmed April 2026)

| Item | Reason |
|------|--------|
| TCS Section 206C(1H) collection | Removed by Finance Act 2025 (effective 1 Apr 2025) |
| Section 206AB higher TDS | Omitted by Finance Act 2025 (effective 1 Apr 2025) |
| Equalisation Levy (2% + 6%) | Abolished effective 1 Aug 2024 (Finance Act 2024) |
| ZestMoney EMI | Shut down Dec 2023; use Propelld/Eduvanz/Bajaj/HDFC Credila |
| Self-custodied escrow | Requires ₹15Cr net worth; route via RazorpayX/Cashfree |
| Internal IRP integration | Use licensed connector; `lib/compliance/irp.ts` calls ClearTax |
| Parent–child org hierarchy UI | Schema columns exist; defer until first customer request |
| Programs v2 (PROJECT/RETAINER) | Enum values **dropped** in v2 (#779) — `ProgramType` is now LICENSED_SEAT/CREDIT_POOL only; revisit only on design-partner demand |

---

## B2C Hardening Train Addendum — 2026-06-11

This file historically tracked only the enterprise subsystem; the consumer
side's readiness now warrants its own dated record because the launch gate
(#837) spans both.

**Closed before this train (verified against issue state on 2026-06-11):**
the slot-picker availability-ID mis-binding (#788), the cross-user
tentative-slot double-booking with its confirm-time recheck (#827), the
checkout request-level idempotency key (#828), the cleanup-versus-webhook
confirmation race (#829), and the orphaned-SUCCEEDED-payment recovery sweep
(#830). The two money-critical script defects from the payments audit are
also resolved: the payout idempotency key is deterministic
(#677 PM-2), and the reconciliation scripts read the canonical
`RAZORPAY_SECRET` with the legacy name accepted as a fallback only
(#677 PM-1, finished by this train's wrapper-gate fix).

**Shipped by this train:** the B2C transition map (`lib/booking/transitions.ts`)
guards approval, decline, expiry, and completion the same way #825 guarded
the enterprise lifecycles, and removes `status` from the writable PUT
surface (#836); checkout locks carry per-type TTLs with a checked renewal at
the gateway boundary (#832); tentative holds expire in hours, not days
(#833); every waitlist mutation is CAS-guarded (#834 code half); consumer
mutation routes carry input bounds, body-size caps, and rate limiters
(#831); the timezone offset lookup and overnight-slot resolution are
canonical and DST-exact (#503 items 1–2); and the booking/payment CHECK
constraints ride the `db:constraints` sidecar awaiting the pre-MVP reset
(#676 A1–A4).

**Demonstrated and resolved blocker:** the real-API chaos extension
(scenarios 9–16 in the
[chaos runbook](../50-operations/07-chaos-test-runbook.md)) initially failed
4 of 7 implemented scenarios against the shared dev database solely because
the schema declared by the merged hardening train had not been pushed
(`Appointment.cancellationPolicySnapshot`, `organizations.version`). The
owed `db push` was applied on 2026-06-11 — with a data-preserving manual
migration for the `CreditPoolConfig` column rename and the ledger triggers
re-applied — after which **all seven implemented scenarios pass**. The
lesson stands for production: entire route families 500 on environments
whose schema lags, so push must always precede deploy.

**Still open for launch:** the #780/#781 schema-freeze stack and the
staging go/no-go run (runbook scenarios 1–4 plus the 2× peak ramp, now
joined by scenarios 9–13/15/16).

---

## Soak Window Requirements (Before Self-Serve Multi-Tenant)

14 consecutive days with all of the following true:

1. `LedgerReconciliationReport.ok = true` every night — zero discrepancies
2. `process-payouts` cron completes without manual intervention
3. At least one full invoice cycle: DRAFT → ISSUED → PAID → PAYOUT COMPLETED
4. At least one org-sponsored booking with correct TDS withheld and persisted
5. At least one IRP IRN successfully generated and persisted (`irpStatus = GENERATED`)
6. Zero `PENDING_TRUST` earnings lingering >7 days
7. Cron alerting wired — at least one test failure caught and notified automatically

---

*Initial audit: Claude Code (claude-sonnet-4-6) via 3-agent parallel sweep (450+ files). Revised twice on 2026-05-02: Round 1 — 5 false findings + 7 real fixes (62→73); Round 2 — 1 false finding + 4 real fixes (73→77).*
