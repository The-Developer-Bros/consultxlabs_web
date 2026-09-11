---
title: Enterprise subsystem — deep phased verification checklist
band: 90-audits
audience: sde4
status: live
last-reviewed: 2026-06-05
---

# Enterprise subsystem — deep phased verification checklist

A file-tree-grounded map of **every sub-subsystem** of the enterprise layer, grouped into phases you can verify in order. Each item is annotated with the real code path and a status hint from the audit series.

**Status legend:** `✅` wired end-to-end · `🟡` partial / known limitation · `❌` not built / gated off · `🔒` intentionally blocked (verify the block fires) · `(verify)` claim to confirm against code.

**Audit refs:** #768 (v0 schema) · #776 (v1 backend/money) · #777 (v2 frontend) · #778 (v3 schema/finance) · #779 (v4 lifecycle/PM). Logins + click-through: [`verification-guide`](03-verification-guide.md).

---

## 🗂️ Enterprise file tree (the real surface)

```
app/api/organizations/
├── route.ts                         # create org / list
├── public/route.ts                  # public org catalog
├── invitations/accept/route.ts      # accept invite (public)
└── [orgId]/
    ├── route.ts                      # get/PATCH org (capabilities, status)
    ├── settings/route.ts             # org settings
    ├── branding/[asset]/route.ts     # logo/banner upload
    ├── activity/route.ts             # activity feed
    ├── analytics/route.ts            # rollup analytics
    ├── audit/route.ts · audit/export/route.ts
    ├── members/route.ts · members/[memberId]/route.ts · members/bulk/route.ts
    ├── invitations/route.ts · invitations/[invitationId]/route.ts
    ├── domain-claims/route.ts · [domain]/route.ts · [domain]/verify/route.ts
    ├── sso/route.ts · sso/providers/route.ts · sso/providers/[providerId]/route.ts
    ├── scim/tokens/route.ts · [tokenId] · scim/group-mappings/route.ts · [mappingId]
    ├── contracts/route.ts · contracts/[contractId]/route.ts
    ├── billing/route.ts
    ├── billing-account/route.ts
    │   ├── invoices/route.ts · [invoiceId]/route.ts · [invoiceId]/pay · [invoiceId]/pdf
    │   ├── purchase-orders/route.ts · [poId]/route.ts
    │   └── wallet/route.ts · wallet/top-ups/route.ts · [topUpId]/route.ts
    ├── programs/route.ts · [programId]/route.ts
    │   └── [programId]/assignments/route.ts · [assignmentId]/route.ts
    ├── rate-cards/route.ts · [cardId]/route.ts
    ├── payouts/route.ts · [payoutId]/route.ts · payout-account/route.ts
    ├── earnings/route.ts
    ├── reimbursements/route.ts · reimbursements/export/route.ts
    ├── catalog/route.ts · catalog/search/route.ts
    ├── consent/route.ts
    ├── data-exports/route.ts · [exportId]/download/route.ts
    ├── documents/route.ts · recordings/route.ts
    ├── appointments/route.ts · waitlist/route.ts · trials/route.ts
    ├── stream/calls/route.ts · stream/channels/route.ts
    └── webhooks/route.ts · [endpointId]/route.ts · rotate-secret
        └── [endpointId]/deliveries/route.ts · [deliveryId]/redeliver
app/api/overage/route.ts · [overageEventId]/order/route.ts
app/api/admin/organizations/route.ts · [orgId]/verify/route.ts        # admin verify
app/api/webhooks/razorpay|stripe|directus/route.ts

app/dashboard/organization/[orgId]/        # 27 pages
  home · members · learners · experts · invitations · contracts · programs ·
  billing · payouts · purchase-orders · reimbursements · analytics · audit ·
  consent · settings · settings/sso · appointments · waitlist · trials ·
  documents · recordings · my-program · my-arrangement ·
  integrations/{webhooks,scim,data-exports}
app/dashboard/organization/(switcher)/create        # org switcher + create
app/dashboard/overage/page.tsx                       # member pay-overage

lib/enterprise/        audit-actions · audit-sanitize · governance · org-status ·
                       reachable-paths · role-transitions · system-events · validators ·
                       outbound-webhooks/{dispatch,event-types,signing,worker}
lib/api/organizations/ membership-transitions · org-details · program-helpers ·
                       rate-card · seat-count · wallet
lib/payments/
  ledger/post.ts
  payouts/  earnings-service · org-payout-service · payout-service · earning-status ·
            razorpay-payouts · razorpay-route · stripe-connect · account-crypto · constants
  billing/  invoice-numbering · invoice-rollup · overage
  operations/ checkout · refund · approval-payment · mock
  tax/      tax-engine · checkout-context · buyer-country · pan-crypto · tds-service
  core/     razorpay · stripe · transactions · types
lib/compliance/  dpdp · gst · tds · msme · irp · form15 · dtaa-rates.json · erasure/
lib/sso/  derive-urls · enforce-session · provider-schemas · signin-with-toast
lib/scim/ auth · operations · resource-user · errors
lib/novu/ workflows · org-workflows · service · subscriber · client

jobs/   47 jobs across alerts/appointments/billing/cleanup/compliance/contracts/
        disputes/earnings/meetings/payments/payouts/reconcile/refunds/stream/waitlist
.github/workflows/   ~48 scheduled crons (one .yml per job)
scripts/  reconcile/reconcile-ledgers · smoke/ledger-smoke · cleanup/* · earnings/* · payouts/*
components/organization/create-wizard/{OrgInfo,Billing,RevenueRates,Branding,InviteTeam,Review}Step
components/enterprise/{ScopedListTable,ComingSoonBadge}
components/collaborators/{CollaboratorsTab,InvitationsPanel,ConsultantSearchInput}
docs/enterprise/   41 numbered docs (00→52) + explainers/
prisma/seedFiles/15a-create-organizations.ts   # the SPONSOR/HOST/HYBRID/solo cohort
__tests__/enterprise/   cap, overage, credit-pool, reachable-paths, billing-admin-gate, … 
```

---

## Phase 0 — Org foundations, capability model & multi-org context
**Code:** `app/api/organizations/route.ts`, `[orgId]/route.ts`, `lib/enterprise/{org-status,reachable-paths,validators}.ts`, `app/dashboard/organization/(switcher)/`

### 0.1 Capability model
- [ ] `canSponsor` × `canHost` → SPONSOR / HOST / HYBRID / INERT resolution `✅` — `lib/enterprise/reachable-paths.ts`
- [ ] Capability set at creation; `ENABLE_HOST_ORGS` gate on `canHost=true` `✅`
- [ ] `canHost` OFF guard while experts/payouts/earnings exist `❌` #779 §A — `[orgId]/route.ts`
- [ ] `canSponsor` OFF guard (wallet ✅ + invoices/allocations ❌) #779 §A
### 0.2 Org status state machine
- [ ] `OrgStatus` PENDING_VERIFICATION → ACTIVE → SUSPENDED → DEACTIVATED `✅` — `lib/enterprise/org-status.ts`
- [ ] SUSPENDED org cascades to pause programs/block bookings `❌` #779 §B
### 0.3 Multi-org switcher
- [ ] Org switcher + "create org" entry `✅` — `(switcher)/create`
- [ ] `OrgWorkspaceProfile` lazy-create on first org `✅`

## Phase 1 — Onboarding & activation
**Code:** `components/organization/create-wizard/*`, `app/api/admin/organizations/[orgId]/verify/route.ts`
- [ ] Wizard: OrgInfo → Billing → RevenueRates → Branding → InviteTeam → Review `✅`
- [ ] Commit deferred to Review step (no orphan orgs) `✅`
- [ ] Admin verify (`PENDING_VERIFICATION` → ACTIVE) `✅`
- [ ] Self-serve verification resubmit/escalation `✅` #779 §A — `[orgId]/verification/resubmit/route.ts` (Organization stamps + resubmit; no `RESUBMIT` enum)
- [ ] Getting-Started activation checklist (contract→fund→program→assign) `✅` #777 §A — `deriveActivationChecklist` in `lib/enterprise/org-activation.ts`, wired in `home/HomePageClient.tsx`
- [ ] Razorpay billing-account link as a guided step `❌` #720
- [ ] Slug collision handling inline `🟡` #719

## Phase 2 — Identity: members, roles, governance, transitions
**Code:** `[orgId]/members/*`, `lib/api/organizations/membership-transitions.ts`, `lib/enterprise/{governance,role-transitions}.ts`
- [ ] Members list + add/edit/remove `✅` — `members/route.ts`, `[memberId]/route.ts`
- [ ] Role ladder OWNER(100)/MAINTAINER(80)/BILLING_ADMIN(70)/MANAGER(60)/EXPERT(40)/SUPPORT(30)/LEARNER(20) `✅`
- [ ] BILLING_ADMIN rank-independent finance gate (MAINTAINER denied) `✅` — `lib/auth/billing-admin-gate.ts`
- [ ] LEARNER↔EXPERT disjoint transition blocked `🔒` — `lib/enterprise/role-transitions.ts`
- [ ] `sessionGeneration` bump on role/status change (no forced logout) `✅` — `membership-transitions.ts`
- [ ] Anti-lockout: can't remove/demote last OWNER `✅` — `governance.ts`
- [ ] Member-removal pre-check for in-flight money (overage/earnings/refund/dispute) `❌` #779 §C
- [ ] RBAC over-centralization (name/billingEmail OWNER-only) `🟡` #779 §A

## Phase 3 — Invitations & bulk provisioning
**Code:** `[orgId]/invitations/*`, `invitations/accept/route.ts`, `members/bulk/route.ts`, `jobs/cleanup/cleanup-stale-invitations.ts`
- [ ] Send invite (role-scoped) → accept (public token) → join `✅`
- [ ] Re-invite dedup + expiry extension `✅`
- [ ] Stale-invite sweeper (daily) `✅`; real-time isExpired + reject-expired-at-accept `🟡` #779 §B
- [ ] Bulk member import (CSV) `✅ (verify)` — `members/bulk/route.ts`
- [ ] Accept into suspended/capability-removed org guarded `(verify)`

## Phase 4 — SSO & domain claims
**Code:** `[orgId]/sso/*`, `[orgId]/domain-claims/*`, `lib/sso/*`, `lib/auth.ts` (customSession), `jobs/cleanup/sso-cert-expiry-alert.ts`
- [ ] `OrganizationSSOSettings` + `SsoProvider` (SAML/OIDC) config `✅`
- [ ] Domain claim → verify → JIT auto-join (`defaultRoleForAutoJoin=LEARNER`) `✅`
- [ ] `enforceSSO` blocks password login for claimed domains `✅` — `lib/sso/enforce-session.ts`
- [ ] enforceSSO server-side veto on direct BetterAuth requests `🟡 (verify)` #779 §E / #673
- [ ] SAML cert X.509 validation + delete-then-recreate rotation `✅`
- [ ] 30-day cert-expiry alert cron `✅` — `sso-cert-expiry-alert.ts`
- [ ] **SSO break-glass / owner recovery on misconfig** `🟡` #779 §E — `OrganizationSSOSettings.breakGlassUntil` + `/sso/break-glass/route.ts` (OWNER reopens password login while IdP down); API-only, no dashboard control yet

## Phase 5 — SCIM provisioning
**Code:** `[orgId]/scim/tokens/*`, `scim/group-mappings/*`, `lib/scim/*`
- [ ] SCIM tokens (SHA-256 hashed) + rate limit `✅` — `lib/scim/auth.ts`
- [ ] Users CRUD + deactivate→SUSPENDED deprovision `✅` — `lib/scim/operations.ts`
- [ ] Group→role mapping `✅` — `resource-user.ts`
- [ ] Erasure short-circuit (410 Gone for erased users) `✅`
- [ ] SCIM mutations emit webhook + audit `✅`

## Phase 6 — Security & audit
**Code:** `middleware.ts`, `next.config.mjs`, `lib/payments/tax/pan-crypto.ts`, `lib/enterprise/{audit-actions,audit-sanitize}.ts`, `[orgId]/audit/*`
- [ ] Upstash rate limiters (auth/invite/wallet-topup/domain-check) `✅` — `middleware.ts`
- [ ] CSP + security headers (report-only; `ENABLE_CSP_ENFORCE`) `🟡`
- [ ] PAN encryption at rest (`panEncrypted`/`panLast4`) `✅` — `pan-crypto.ts`
- [ ] Audit log 60+ actions (`OrgAuditLog`) + CSV export `✅` — `audit-actions.ts`
- [ ] Audit sanitization on erasure (pseudonymize actor) `✅` — `audit-sanitize.ts`
- [ ] Audit pruning (7y finance / 2y other) `✅` — `jobs/cleanup/prune-audit-logs.ts`
- [ ] Dangerous-mutation guard (status precondition + in-flight count block + in-tx cascade + config-lock predicates) `✅` #779 §A — `lib/enterprise/config-lock.ts`; no `riskLevel` field, the guard is structural

## Phase 7 — Contracts & lifecycle
**Code:** `[orgId]/contracts/*`, `jobs/contracts/expire-contracts.ts`
- [ ] Contract create + DRAFT→ACTIVE→EXPIRED/TERMINATED `✅`
- [ ] Terminate guarded vs live assignments `✅`
- [ ] Contract-expiry/termination cascade to programs `✅` #779 §A — in-tx TERMINATED → programs EXPIRED → assignments CLOSED (kills zombie programs)
- [ ] `Contract.autoRenew` + renewal cycle `✅` #779 §A — `jobs/contracts/auto-renew-contracts.ts`; `autoRenewedAt` idempotency claim gate
- [ ] Contract detail/amend/renew/e-sign UI `🟡` #777 §B / #770
- [ ] Expire-contracts cron `✅` — `expire-contracts.ts`

## Phase 8 — Billing accounts & funding sources
**Code:** `[orgId]/billing-account/route.ts`, `[orgId]/billing/route.ts`
- [ ] `BillingAccount` per org; funding WALLET/INVOICE/LICENSE/PERSONAL `✅`
- [ ] Funding-source change guards (wallet balance / outstanding invoices) `✅`
- [ ] Funding immutable once contract ACTIVE/money moved `🟡` #779 §A
- [ ] Credit limit (`creditLimit`) enforcement at booking `❌` #776 §E

## Phase 9 — Purchase orders & invoicing
**Code:** `billing-account/purchase-orders/*`, `billing-account/invoices/*`, `lib/payments/billing/{invoice-numbering,invoice-rollup}.ts`, `jobs/billing/*`
- [ ] PO create + 3-way match (`requiresPO`) `✅`
- [ ] Invoice rollup (INVOICE_ACCRUAL + OVERAGE_INVOICE_ACCRUAL) `✅` — `invoice-rollup.ts`
- [ ] Atomic gapless numbering `<prefix>-<FY>-<seq>` (Rule 46) `✅` — `invoice-numbering.ts`
- [ ] Invoice pay (Razorpay) ISSUED→PAID + ledger `✅` — `invoices/[invoiceId]/pay`
- [ ] Invoice PDF `✅ (verify post react-pdf #707)` — `invoices/[invoiceId]/pdf`
- [ ] Subscription-invoice cron + accrual settle `✅` — `generate-subscription-invoices.ts` (daily) + `settle-invoice-accruals.ts` (monthly), both now scheduled with `concurrency` groups; the accrual rollup reads inside a Serializable transaction so overlapping runs can't double-issue (#813)
- [ ] Dunning / overdue / suspension `✅` #812 — `jobs/billing/dunning.ts` marks OVERDUE + sends 7-day×3 reminders (`notifyOrgInvoiceOverdue`), then a stage-3 booking-suspend (`ENABLE_DUNNING_SUSPEND`-gated) stamps `dunningSuspendedAt` 7 days past the last reminder and writes `INVOICE_DUNNING_SUSPENDED`, claim + audit in one Serializable transaction
- [ ] Credit notes on refund (GST Sec 34/Rule 53) `✅` #776 — `mintRefundCreditNote` (idempotent on refundId) shared by BOTH the app/cron cascade AND the gateway-refund webhook, so real Razorpay/Stripe refunds of invoiced bookings mint a CN; FY-sequential `<PREFIX>-CN-<FY>-<seq>` — `credit-note-numbering.ts`, `refund.ts`, `webhooks/utils.ts`

## Phase 10 — Wallet & top-ups
**Code:** `billing-account/wallet/*`, `lib/api/organizations/wallet.ts`, `jobs/cleanup/cleanup-abandoned-org-top-ups.ts`
- [ ] Top-up: create order → webhook confirm → Dr CASH / Cr WALLET `✅`
- [ ] Atomic `walletDebit` guard (no negative balance) `✅`
- [ ] `walletBalance` reconciled cache vs WALLET account `✅`
- [ ] Abandoned-top-up cleanup cron `✅` — `cleanup-abandoned-org-top-ups.ts`
- [ ] Pending-top-up visibility / failed notification `🟡` #779 §D

## Phase 11 — Programs & assignments
**Code:** `[orgId]/programs/*`, `lib/api/organizations/{program-helpers,seat-count}.ts`
- [ ] LICENSED_SEAT config (seats, covered engagements/cycle, rate, surcharge, ceiling) `✅`
- [ ] CREDIT_POOL config (credits/cycle = paise money-meter) `✅` #753 fixed
- [ ] Reachable funding-path gate (CREDIT_POOL ⊄ LICENSE) `🔒` — `reachable-paths.ts`
- [ ] Assign member → `ProgramAssignment` + `BookingUtilization` `✅` — `program-helpers.ts`
- [ ] `activeSeatCount` denorm (reconcile `ACTIVE_SEAT_COUNT_DRIFT`) `✅` — `seat-count.ts`
- [ ] Program money-config lock once in use (`configLockedAt`) `✅` #779 §B — stamped at first assignment; `LOCKED_PROGRAM_FIELDS` read-only (`config-lock.ts`)
- [ ] Edit-after-create (safe fields) `✅` #777 §B — `programs/[programId]` PATCH allows safe fields, rejects locked money fields
- [ ] Cycle auto-rollover at `periodEnd` (mint successor / CLOSE) `✅` #779 §A — `cycle-engine.ts` + `jobs/billing/advance-program-cycles.ts` (kills zombie assignments)
- [ ] Assignment soft-delete + explicit status (`AssignmentStatus`) `✅` #779 §A — `assignments/[assignmentId]` sets status=CANCELLED; ROLLED/CLOSED driven by the cycle engine

## Phase 12 — Rate cards & revenue splits
**Code:** `[orgId]/rate-cards/*`, `lib/api/organizations/rate-card.ts`
- [ ] RateCard override chain (org→contract→plan-type→plan-id→membership) `✅`
- [ ] bps splits (platform/org/consultant) sum to 10000 `✅`
- [ ] Wizard writes RateCard to org id (not user id) `❌` #728 (HOST bug)
- [ ] Rate-card snapshot at collaborator-invite time `❌` #779 §G (stale-split risk)

## Phase 13 — Booking & utilization (org-sponsored checkout)
**Code:** `lib/payments/operations/checkout.ts`, `lib/payments/tax/{tax-engine,checkout-context,buyer-country}.ts`, `OrgPayerSelector`
- [ ] Payer selector (card / Bill-to-org / wallet / license) `✅`
- [ ] Funding routing → PaymentLeg (WALLET/INVOICE_ACCRUAL/LICENSE/CARD) `✅`
- [ ] Tax engine: GST + buyer-country detection at checkout `✅` — `tax-engine.ts`
- [ ] Cap counting (engagements vs paise) `✅` — `program-helpers.ts`
- [ ] Referral credit blocked on org-funded bookings `🔒` — `checkout.ts`
- [ ] Pre-checkout cap/overage warning (no surprise billing) `✅` #777 §C — `lib/payments/billing/overage-preview.ts` + `/checkout/overage-preview` route, surfaced in `OrgPayerSelector`
- [ ] Program-assignment validation client-side `🟡` #777 §C
- [ ] Approval-payment path (`operations/approval-payment.ts`) `✅ (verify)`

## Phase 14 — Overage (calc, behaviors, settlement)
**Code:** `lib/payments/billing/overage.ts`, `checkout.ts`, `app/api/overage/*`, `app/dashboard/overage/page.tsx`, `lib/payments/webhooks/overage-handlers.ts`
- [ ] `computeOverage` — pass-through + surcharge bps + circuit breaker `✅`
- [ ] BLOCK → 402 at cap `🔒`
- [ ] CHARGE_ORG → OVERAGE_INVOICE_ACCRUAL leg + `OverageEvent` PENDING→ACCRUED→CHARGED `✅`
- [ ] CHARGE_MEMBER → parent-linked side-charge → `/dashboard/overage` pay → webhook CHARGED `✅`
- [ ] `chargeStatus` lifecycle + REVERSED on refund `✅`
- [ ] 80% cap-near (`ORG_PROGRAM_CAP_NEAR`) + exhausted alerts `✅`
- [ ] CHARGE_MEMBER PENDING-forever timeout/reminder/write-off `❌` #779 §D
- [ ] Buyer-org ORG_PAYABLE settlement netting + `OVERAGE_SETTLEMENT_MISMATCH` `❌` #775
- [ ] CHARGE_ORG cycle-close cron (`settle-overage-events`) `❌` #782

## Phase 15 — Double-entry ledger & reconcile
**Code:** `lib/payments/ledger/post.ts`, `scripts/reconcile/reconcile-ledgers.ts`, `jobs/reconcile/reconcile-ledgers.ts`
- [ ] `postLedgerTxn` Σdebit==Σcredit + idempotent on key `✅`
- [ ] `LedgerTransactionKind` enum (was free String) `✅` #778 §B
- [ ] 10 account kinds + deterministic account id `✅`
- [ ] Reconcile invariant `WALLET_BALANCE_DRIFT` `✅`
- [ ] `LEDGER_TXN_IMBALANCE` `✅`
- [ ] `EARNINGS_LEDGER_DRIFT` `✅`
- [ ] `PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT` `✅`
- [ ] `ACTIVE_SEAT_COUNT_DRIFT` `✅`
- [ ] `PAYMENT_LEG_SUM_MISMATCH` `✅`
- [ ] `ORG_PAYOUT_TOTAL_MISMATCH` `✅`
- [ ] `CREDIT_POOL_CONSUMED_DRIFT` `✅` #775
- [ ] `overageCount` reconcile invariant `❌` #778 §G
- [ ] `LEDGER_BALANCE_SNAPSHOT_DRIFT` (maintained `LedgerAccountBalance` vs journal) `✅` #776 — O(1) balance reads replace the O(n) groupBy scan
- [ ] `REFUND_BOOKING_COHERENCE` (refund ↔ utilization-reversal coherence) `✅` #776
- [ ] `COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN` (a COMPLETED payout with no original `PAYOUT`/`ORG_PAYOUT` posting) `✅` #812/#813 — covers **both** org and consultant payouts, keyed on the original posting's idempotencyKey so a reversal row can't mask a missing original
- [ ] Money type Int32→BigInt (₹2.14cr overflow) `✅` #780 — shipped across the money columns; verified in the 2026-06-12 triage and against the current schema (this row previously lagged the fix)
- [ ] Reconcile run → `ok:true`, 0 findings on fresh reseed `✅`

## Phase 16 — Earnings & payouts
**Code:** `lib/payments/payouts/*`, `[orgId]/{payouts,earnings,payout-account}/route.ts`, `jobs/payouts/*`, `jobs/earnings/*`
- [ ] Consultant earnings 3-way split `✅` — `earnings-service.ts`
- [ ] Org earnings (HOST/HYBRID) `✅` — `org-payout-service.ts`
- [ ] Earning status machine (PENDING/HELD/READY/PAID/REFUNDED/PENDING_TRUST) `✅` — `earning-status.ts`
- [ ] Payout batch create + ledger (Dr *_PAYABLE / Cr CASH + TDS) `✅` — `create-payout-batch.ts`
- [ ] TDS 194-O + MSME 43B(h) on payout `🟡` (engine divergence #778 §E) — `mustPayByDate` now stamped on BOTH payout paths incl. consultant/SELF (#776); the alert sweep covers both
- [ ] **Gateway disbursement (`ENABLE_LIVE_PAYOUTS`)** `❌` gated → expect PROCESSING #776 §B — go-live runbook + sandbox smoke now exist (`docs/enterprise/45-…`, `scripts/smoke/org-payout-sandbox-smoke.ts`); flag stays OFF until sandbox-proof
- [ ] Razorpay Route (split settlement) `❌` scaffold — `razorpay-route.ts`
- [ ] Stripe Connect path `🟡 (verify)` — `stripe-connect.ts`
- [ ] Crons scheduled: `create-payout-batch`, `process-payouts`, `handle-stuck-payouts`, `reconcile-payout-status`, `release-earnings`, `release-pending-trust-earnings`, `sync-payment-earnings` `✅` (all have `.github/workflows/*.yml` — corrects #776 §B; the real gap is the live-payout gate, not scheduling)
- [ ] Consultant-payout idempotency key NOT NULL `✅` #778
- [ ] Payout-completed notification (`ORG_PAYOUT_COMPLETED`) wired `🟡 (verify #718)`
- [ ] Form 16A / TDS certificate to payee `❌` #778 §F

## Phase 17 — Refunds, disputes, chargebacks
**Code:** `lib/payments/operations/refund.ts`, `jobs/refunds/*`, `jobs/disputes/*`
- [ ] Refund cascade (legs + earnings + utilization reversal) `✅` — `refund.ts`
- [ ] Refund ledger reversal always balanced (platformPlug residual) `✅` #778 §C
- [ ] Multi-booking (CLASS) refund reversal `🟡` #776 — `CLASS_MULTI` source built + unit-tested in `reversal-engine.ts`, but NOT yet wired to a production caller (no flow resolves a consolidated class into child payment ids). Engine is foundational; production wiring is a follow-up.
- [ ] Gateway refund reconcile cron `✅` — `reconcile-pending-refunds.ts`, `cascade-refund-earnings.ts`
- [ ] `Refund.failureReason` + REFUND_FAILED notification `❌` #779 §D
- [ ] Disputes: created/lost handlers + deadline alerts `✅` — `jobs/disputes/{reconcile-disputes,handle-lost-disputes,alert-dispute-deadlines}.ts`
- [ ] Per-org dispute surface + chargeback money-path `🟡` #776 — read surface (`[orgId]/disputes`) + org-wallet-first chargeback (`applyOrgChargeback`) shipped; org Novu notification still pending #779 §D
- [ ] Payout reversal / clawback (gateway-side) `🟡` #716/#812 — the COMPLETED-then-bank-bounced `payout.reversed` path now reverses cleanly on **both** sides: `markOrgPayoutReversed` and `markConsultantPayoutReversed` each claim COMPLETED→REVERSED, post the inverse PAYOUT journal (idempotencyKey `payout-reversal:<id>`), and re-open the linked earnings to READY; the broader refund-driven clawback against an already-paid payout is still the manual `PAYOUT_CLAWBACK` v1

## Phase 18 — Compliance & tax
**Code:** `lib/compliance/*`, `[orgId]/{consent,data-exports}/*`, `jobs/compliance/*`
- [ ] GST breakdown (CGST/SGST/IGST, place of supply, HSN, RCM, export zero-rate) `✅` — `gst.ts`
- [ ] IRN / e-invoice (ClearTax) `🟡` env-gated — `irp.ts`, `jobs/compliance/irp-uploader.ts`
- [ ] TDS 194-O (0.1%, no-PAN 5%, 206AA, DTAA) `✅` — `tds.ts` (+ divergent `tax/tds-service.ts` 194J `❌` #778 §E)
- [ ] Refund-driven TDS reversal `✅` #813 — shared `recordTdsReversal` (`tax/tds-service.ts`) writes a negative `isReversal` `TDSRecord` (integer-paise proportion, capped at the original so refund-then-chargeback can't double-reverse); filed-aware FY/quarter stamping (unfiled → original's FY/quarter, filed → current IST-reckoned FY/quarter), provisional pending CA sign-off; `getIndianFinancialYear`/`getIndianFYQuarter` are now IST-aware
- [ ] MSME 43B(h) deadline `✅` — `msme.ts`, `jobs/compliance/msme-payment-alerts.ts`
- [ ] DPDP consent grant/withdraw `✅` — `dpdp.ts`, `[orgId]/consent`
- [ ] DPDP erasure + financial-record retention `✅` — `lib/compliance/erasure/`
- [ ] Consent retention sweeper + breach-deadline alerts `✅` — `jobs/compliance/{consent-retention-sweeper,databreach-deadline-alerts}.ts`
- [ ] Data export (`OrgDataExportJob`) `✅` — `data-exports/*` (request + 7-day signed-URL download), `jobs/cleanup/process-data-exports.ts` (Stream omitted 🟡 #776 §I)
- [ ] GST TCS u/s 52 + GstTcsBatch + GstTcsAdjustment `❌` schema-now #778 §D
- [ ] CreditNote + TdsAdjustment models `❌` #778 §D
- [ ] taxEntityType + consumerStateCode `❌` #778 §D
- [ ] Form 26Q/27Q + GSTR-1/3B/8 + 15CA/15CB (`form15.ts` stub) `❌` #778 §F
- [ ] `taxEntityType` / AATO einvoice-threshold flag `❌` #778 §D

## Phase 19 — Outbound webhooks
**Code:** `[orgId]/webhooks/*`, `lib/enterprise/outbound-webhooks/*`, `jobs/cleanup/{dispatch-outbound-webhooks,archive-webhook-events}.ts`
- [ ] Endpoint CRUD + 8-event catalog `✅` — `event-types.ts`
- [ ] HMAC-SHA256 signing + 24h dual-sign rotation grace `✅` — `signing.ts`
- [ ] Delivery worker: retry schedule + replay window `✅` — `worker.ts`, `dispatch.ts`; re-queues stale `IN_FLIGHT` rows by `updatedAt` and claims rows atomically, so overlapping ticks can't double-deliver (#812)
- [ ] Delivery log + redeliver `✅` — `[endpointId]/deliveries/[deliveryId]/redeliver`
- [ ] Dispatch + archive crons `✅` — `dispatch-outbound-webhooks.ts`, `archive-webhook-events.ts`

## Phase 20 — Stream (chat / video / recordings)
**Code:** `[orgId]/stream/{calls,channels}/route.ts`, `jobs/stream/*`, `actions/stream/chat/channel.action.ts`
- [ ] Org-scoped channels (`custom.organization_id`) `✅`
- [ ] Org recording retention (`streamRecordingRetentionDays`) `✅`
- [ ] Recording cleanup/mark-expired/transfer crons `✅` — `jobs/stream/{cleanup-old,mark-expired,transfer-expiring}.ts` + `stream-sync.ts`
- [ ] DPDP erasure scrubs Stream chat/recordings `❌` #776 §I
- [ ] Stream data in org export `❌` #776 §I

## Phase 21 — Notifications (Novu)
**Code:** `lib/novu/{workflows,org-workflows}.ts`
- [ ] 16 org workflows wired: invite-sent/accepted, invoice-issued/paid, license-renewal, wallet-topup, payout-completed/failed/reversed, program cap-near/exhausted/overage-due, expert-removed, data-export, sso-cert-expiring/provider-deleted `✅`
- [ ] **Action-needed surfaces:** invoice-overdue/dunning (`notifyOrgInvoiceOverdue` + home banner), payout-stuck, verification-needed, wallet-low now covered by the dunning cron + action center (`deriveActionCenter`) `🟡` #779 §F/§G — still missing as dedicated Novu workflows: top-up-failed, dispute-deadline (org), SSO-misconfigured
- [ ] Per-event-type operator preferences `🟡` #779 §G

## Phase 22 — Catalog, discovery & public surfaces
**Code:** `[orgId]/catalog/*`, `organizations/public/route.ts`, `app/explore/enterprise/organisations/*`
- [ ] Org-scoped plan catalog + search `✅` — `catalog/route.ts`, `catalog/search`
- [ ] Public org catalog + detail `✅` — `organizations/public`
- [ ] `OrgPlanVisibility` ORG_ONLY leak guard on `/explore` `✅` #726/#776 — curated carousels + topic counts now apply `MARKETPLACE_VISIBILITY` (was leaking via `explore-programs.ts`)
- [ ] Plan → checkout linking from public detail `❌` #777 §E
- [ ] Expert filtering + social proof on org detail `🟡` #777 §E

## Phase 23 — Member / expert surfaces & dashboards
**Code:** `app/dashboard/organization/[orgId]/{home,my-program,my-arrangement,...}`, `app/dashboard/overage`
- [ ] Operator console pages functional (`home/members/programs/contracts/billing/payouts/audit/settings`) `✅` mostly #777 §B
- [ ] `/my-program` learner allocation + utilization `✅`
- [ ] `/my-arrangement` expert earnings + payout recipient `✅`
- [ ] Add-EXPERT management UI `❌` #729
- [ ] Expert appointment visibility `❌` #754
- [ ] State-driven "action required" home `✅` #779 §F — `deriveActionCenter` in `lib/enterprise/org-activation.ts` (overdue, cap-near, contract-expiring, overage-as-expansion, wallet-low, stuck-payout), wired in `home/HomePageClient.tsx`
- [ ] Reimbursements nav link for PERSONAL orgs `🟡` #714

## Phase 24 — Cross-cutting (appointments / trials / waitlist / reimbursements / documents / referrals)
**Code:** `[orgId]/{appointments,trials,waitlist,reimbursements,documents,recordings}/route.ts`
- [ ] `Appointment.organizationId` stamped on org-sponsored bookings `✅` #768
- [ ] Org appointments list `✅`; expert "Join" affordance `❌` #748
- [ ] Trials org-tagged (`TrialSession.organizationId`) `✅`; trial→paid conversion / expiry `❌` #779 §J
- [ ] Waitlist org-context `✅`; promotion re-checks cap/funding `❌` #779 §D
- [ ] Reimbursements (PERSONAL orgs) + CSV export `✅` — `reimbursements/export`
- [ ] Org documents + recordings `✅`; KYB/contract document lifecycle `❌` #776 §J
- [ ] Referral credit ↔ org-funding conflict guard `🔒` (checkout) + reconcile backstop `❌` #778 §A

## Phase 25 — Background jobs / cron inventory
**Code:** `jobs/**`, `.github/workflows/*.yml`
- [ ] Every job in `jobs/` has a scheduled `.github/workflows/*.yml` `✅ (~48 present)` — audit #709 for collisions
- [ ] Reconcile-ledgers nightly `✅` · billing/invoice crons `✅` · payout crons `✅` · cleanup sweepers `✅` · compliance crons `✅` · stream crons `✅` · dispute/refund crons `✅`
- [ ] Cron collision audit on Supabase pooler `🟡` #709

## Phase 26 — Observability, system events, maintenance
**Code:** `lib/enterprise/system-events.ts`, `MaintenanceWindow` model, `jobs/alerts/alert-orphaned-payments.ts`
- [ ] `recordSystemEvent`/`recordSystemError` helpers `✅` (thin adoption ~7 callsites 🟡 #776 §K)
- [ ] Real monitoring sink (Sentry/BetterStack/Datadog) `✅` #776 §K — `recordSystemEvent`/`recordSystemError` ship to BetterStack Telemetry (flag-gated `ENABLE_BETTERSTACK_TELEMETRY`); callsites at reconcile-fail / stuck-payout / webhook-backlog / HMAC-fail — `lib/observability/betterstack-telemetry.ts`
- [ ] Orphaned-payment alert cron `✅` — `alert-orphaned-payments.ts`
- [ ] `MaintenanceWindow` (org-scoped) gates payout batch `🟡`; admin write API / Novu / invoice-cron gate `❌` #776 §J

## Phase 27 — Data fixtures, hierarchy & feature flags
**Code:** `prisma/seedFiles/15a-create-organizations.ts`, `lib/feature-flags.ts`, hierarchy columns
- [ ] Seed cohort: Wipro (SPONSOR/INVOICE/LICENSED_SEAT), LearnPro (HOST), IIT (HYBRID/WALLET), Rahul (solo HOST), tour-owner `✅` — verification fixture
- [ ] Org hierarchy (`parentOrganizationId`/`rootOrganizationId`) `✅ DROPPED` — the inert columns were grep-verified to have zero readers and removed in the #705 schema freeze. Subsidiary scoping remains a future structural change if a conglomerate buyer materializes. (There was never a `depth` column.)
- [ ] Feature flags inventory `✅` — the flags actually exported from `lib/feature-flags.ts` are `ENABLE_HOST_ORGS`, `ENABLE_LIVE_PAYOUTS`, `ENABLE_TDS_ADMIN_VIEW`, `ENABLE_BETTERSTACK_TELEMETRY`, and `ENABLE_DUNNING_SUSPEND` (centralized in #863). IRP is gated only by the `ENABLE_IRP_UPLOADER` GitHub Actions repo variable, not an app const. The previously-listed `ENABLE_ROUTED_WALLET`, `ENABLE_CONSOLIDATED_INVOICE`, `ENABLE_CSP_ENFORCE`, and `DPDP_SWEEPER_DELETE` are not in the module.

---

> **How to read status:** `✅` verify it works · `🟡` works with a documented limitation · `❌` not built / gated (don't be surprised) · `🔒` verify the block fires · `(verify)` confirm against code. Every `❌`/`🟡` maps to a scheduled fix in the v0–v4 mega-audits (#768/#776/#777/#778/#779).
