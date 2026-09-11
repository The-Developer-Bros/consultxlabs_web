---
title: Enterprise Production-Grade Checklist
band: 90-audits
audience: sde4
status: live
last-reviewed: 2026-05-02
---

# Enterprise Production-Grade Checklist

> **Superseded (2026-06-05):** This is a point-in-time Round-2 audit. For the
> current enterprise status see [`readiness-audit`](01-readiness-audit.md) (v2 mega-audit
> addendum, #777/#778/#779) and [`subsystem-checklist`](02-subsystem-checklist.md) (live
> per-subsystem status). Kept for history; do not treat scores below as current.

Date: 2026-05-02

Supersedes: `ENTERPRISE_PRODUCTION_GRADE_CHECKLIST_2026_05_01.md`

Scope: Prisma enterprise schema, `docs/enterprise/**`, enterprise dashboard and API routes, booking/payment/refund/payout logic, finance and compliance docs, compliance helpers/jobs, org context filters and switchers, cross-cutting auth/Novu/Stream/storage/cron integrations, and prior readiness notes in `tasks/enterprise-readiness-1.txt`.

Method note: Serena MCP was requested but is not available in this session. This audit uses high-efficiency local reads with `rg`, targeted `sed`, schema/document cross-checks, and a targeted enterprise file manifest.

## Executive Readiness Score

| Readiness lens | Score | Confidence | Verdict |
|---|---:|---|---|
| Overall enterprise subsystem production-grade readiness | 86 / 100 | Medium-high | Strong design-partner candidate after the 2026-05-02 Round 2 fixes, but not broad self-serve enterprise GA. |
| Controlled design-partner readiness | 90 / 100 | Medium-high | Viable with manual finance/compliance operations, explicit WIP boundaries, and daily reconciliation. |
| Broad enterprise GA readiness | 78 / 100 | Medium | Compliance, live payout operations, scope semantics, and admin evidence trails still need closure. |
| Financial correctness | 86 / 100 | Medium | Payment legs, wallet, utilization, invoice accrual, overage source separation, and payout state are real; refund/clawback paths still carry high-risk edge cases. |
| Compliance readiness | 82 / 100 | Low-medium | TDS withholding now wired into the org payout pipeline (Section 194-O default, 206AA fallback). MSME deadline derivation uses real `Organization.msmeStatus` + `msmeWrittenAgreementOnFile`. DPDP consent is stamped at signup and gates Stream upsert. GST place-of-supply is env-driven (`SUPPLIER_STATE_CODE`). Per-org sequential invoice numbering is live with atomic counter. PR-3 still owns: GSTIN registry verify, Form 26Q quarterly return generation, in-app consent withdrawal UI, IRN production approval. See `docs/compliance/15-india-compliance-shipping-checklist.md`. |
| Dashboard/operator readiness | 86 / 100 | Medium-high | Org pages, org-workspace pages, PO/consent sidebar entries, and billing copy are now broad; personal dashboard scope filter semantics still need cleanup. |
| Cross-cutting integration readiness | 79 / 100 | Medium | BetterAuth/Novu/Redis/Supabase/rate limiting are strong; Stream org scope, recordings retention, compliance ops, and monitoring remain partial. |

Bottom line: the enterprise subsystem is materially better than the May 1 board because org activity pages, runtime appointment org stamping, wallet-in-billing, overage leg separation, invitation rate limiting, GST/MSME/TDS derivation, scheduled IRP/MSME/DataBreach compliance crons, and HRIS upload body protection have moved forward. It is still not "production-grade" in the enterprise GA sense until compliance production approval, payout submission proof, refund/clawback correctness, and scope semantics are hardened.

## 2026-05-02 Response Reconciliation

The follow-up response corrected several false or stale findings from the two readiness agents. The current local code confirms:

- Invoice payment POST is idempotent by persisted `OrganizationInvoice.providerPaymentOrderId`; repeated calls reuse the same Razorpay order.
- Audit CSV export has a hard stream ceiling: `CSV_CHUNK_SIZE = 500` and `MAX_ITERATIONS = 400`, or 200,000 rows.
- `/dashboard/organization/[orgId]/contracts` uses `useRequireOrgAccess` with `minRole: "MAINTAINER"` and `canSponsor: true`.
- `Contracts`, `Audit`, `Purchase Orders`, and `Consent` are present in the org sidebar with role/capability gates.
- `computeMsmePaymentDeadline` implements MICRO/SMALL 15/45-day logic and MEDIUM/NONE default-terms behavior.
- The CHARGE_ORG P2002 overage bug is fixed by `PaymentLegSource.OVERAGE_INVOICE_ACCRUAL`.
- The CHARGE_MEMBER overage message now accurately says the sponsored booking is blocked and the user should contact the org admin or book personally.
- Org invitation POST now has `orgInviteLimiter` at 20/hour per org.
- The IRP uploader header now distinguishes the env-gated ClearTax connector from the still-not-production-approved cron wiring.

## 2026-05-02 Round 2 Reconciliation

Validation of the updated docs surfaced a sixth false finding and additional pending items, all addressed in commit Round 2:

- **FF-6 (GST):** Both the checklist and [`readiness-audit`](01-readiness-audit.md) previously claimed `deriveGstBreakdown()` returned zero tax. False - `lib/compliance/gst.ts:68-128` implements zero-rated export when `buyerCountry !== "IN"`, intra-state CGST 9% + SGST 9% (`Math.round(taxPaise/2)` split), inter-state IGST 18%, HSN defaulting to 999293, and place-of-supply derivation. Compliance score lifted accordingly. Only what is still missing for GA: GSTIN registry API verification, RCM routing, LUT enforcement.
- **IRP cron schedule wired:** `.github/workflows/irp-uploader.yml` runs daily at 02:30 UTC. The cron body already iterates `OrganizationInvoice.irpStatus = PENDING` rows within the 30-day CBIC window and calls `generateIrn`; this PR adds the GH Actions schedule and a `require.main === module` self-executor.
- **MSME alert cron schedule wired:** `.github/workflows/msme-payment-alerts.yml` runs daily at 04:30 UTC. Stale "derivation is a stub" header comment removed; the function has been live since the 2026-04 TDS/MSME PR.
- **DataBreach 72-hour DPDP deadline cron added:** `jobs/compliance/databreach-deadline-alerts.ts` plus an hourly schedule. Sweeps `DataBreach WHERE reportedAt IS NULL` and emails the DPDP-officer inbox (env: `DATABREACH_ALERT_EMAIL`) for rows at most 12h before, or past, the 72-hour Section 8(6) deadline. Closes part of #701 without committing to the full DPDP cascade.
- **HRIS CSV-upload body-size guard:** `app/api/organizations/[orgId]/hris/csv-upload/route.ts` now returns 413 when `Content-Length > 5 MB`. The Zod 5,000-row cap remains; this catches malicious bodies before they're buffered into memory.

## Compliance Reality Check

The repo's India compliance docs should be treated as implementation planning, not legal signoff. Current external references used for this checklist:

- GST e-invoicing: official GST IRP material states that Notification 10/2023 applies e-invoicing to businesses with AATO of INR 5 crore and above from 2023-08-01: <https://einvoice6.gst.gov.in/content/crossed-the-e-invoicing-turnover-limit-here-are-5-things-to-do-next/>
- DPDP Rules: PIB states the DPDP Rules, 2025 were notified on 2025-11-14 and give effect to the DPDP Act, 2023: <https://www.pib.gov.in/PressReleasePage.aspx?PRID=2190655>
- RBI PA-CB: RBI circular RBI/2023-24/80 dated 2023-10-31 governs payment aggregators for cross-border import/export transactions: <https://rbi.org.in/Scripts/NotificationUser.aspx/upload/Scripts/NotificationUser.aspx?Id=12561>

Production implication:

- IRN generation and signed QR are not optional for affected B2B invoices. `OrganizationInvoice.irpStatus` and the ClearTax scaffold are useful, but production needs configured credentials, payload validation, retry dashboards, and accountant/legal signoff.
- DPDP is no longer merely a future law to watch. Consent, notice, withdrawal, breach, retention, and data-principal-right workflows need operational readiness.
- Cross-border payment flows must avoid pretending that a generic Stripe/Razorpay integration solves PA-CB/FEMA/Form 15CA/CB/FIRC obligations.
- MSME 15/45-day payment logic should remain finance-reviewed even where code exists, because implementation correctness depends on counterparty registration, written-agreement evidence, and payment-date proof.

## Correctly Fixed

| Area | What is now correctly fixed | Evidence |
|---|---|---|
| Runtime org activity stamping | `Payment.organizationId` and `billingAccountId` are populated at checkout for every org-attributed payment. `Appointment.organizationId` is now written at checkout for org-context bookings (consultation, subscription, webinar, class). `Waitlist.organizationId` and `Recording.organizationId` are populated at write time via `resolveEventHostOrgId` (waitlist creates) and `meetingSession.slotOfAppointment.appointment.organizationId` (recording webhook handlers). No backfill needed — only mock data exists. | `lib/payments/operations/checkout.ts`, `lib/stream/recording-handlers.ts` |
| Org activity dashboards | Org appointments, waitlist, trials, documents, recordings, and reimbursements pages now exist under `/dashboard/organization/[orgId]/**` and route to org-scoped APIs. | `app/dashboard/organization/[orgId]/**`, `app/api/organizations/[orgId]/**` |
| Wallet and billing unification | Wallet UI now lives under `billing/WalletTab.tsx`; the earlier `/credits` split called out in docs is no longer present in the current route manifest. | `app/dashboard/organization/[orgId]/billing/**` |
| Core schema anchors | Enterprise schema covers capability booleans, memberships, billing accounts, contracts, programs, utilization, payment legs, org earnings, org payouts, org invoices, SSO settings, domain claims, audit logs, and activity org IDs. | `prisma/schema.prisma` |
| Payment leg discipline | `PaymentLeg` exists with source uniqueness and checkout writes legs for card, wallet, invoice accrual, license, and referral-credit flows. | `PaymentLeg`, `PaymentLegSource`, `lib/payments/operations/checkout.ts` |
| Program cap accounting | `BookingUtilization`, `ProgramAssignment.engagementsUsed`, lazy subscription debits, and reversal markers exist; terminology has moved to engagement-based counting. | `BookingUtilization`, `lib/api/organizations/program-helpers.ts` |
| Wallet debit atomicity | Wallet debit uses a conditional update and ledger rows to prevent negative balances under concurrent bookings. | `lib/api/organizations/wallet.ts` |
| Rate-card historical settlement | Rate-card snapshots are persisted on utilization/earnings so future rate-card edits do not rewrite prior bookings. | `RateCard`, `BookingUtilization`, `OrganizationEarnings` |
| SSO foundations | BetterAuth SSO plugin, org SSO settings, domain claims, domain-check endpoint, session enrichment, and anti-lockout guards exist. | `lib/auth.ts`, `app/api/auth/sso/domain-check/route.ts`, org SSO routes |
| Better org dashboard model | The repo now has distinct org dashboards and org-workspace dashboards instead of forcing enterprise operators into consultant/consultee dashboards. | `docs/enterprise/12-dashboard-pages.md`, `app/dashboard/org-workspace/**` |
| TDS derivation | `computeTdsForPayout` is no longer a zero-value stub; it handles default 194O, explicit overrides, PAN fallback, lower-rate certificate, and DTAA lookup. | `lib/compliance/tds.ts` |
| MSME deadline derivation | `computeMsmePaymentDeadline` now implements 15/45-day logic for MICRO/SMALL and default terms for MEDIUM/NONE. | `lib/compliance/msme.ts` |
| RazorpayX org payout submission path | Live org payout submission is gated by `ENABLE_LIVE_PAYOUTS` and the Razorpay path is scaffolded with idempotency; it is no longer only a `NotImplementedError` placeholder. | `lib/payments/payouts/org-payout-service.ts` |
| IRP retry telemetry | IRP uploader now persists retry count, last error, and failed status after bounded retries instead of silently dropping failures. | `jobs/compliance/irp-uploader.ts`, `OrganizationInvoice` |
| Marketplace leakage guard | Org-owned plan visibility enum and indexes exist; public marketplace queries have a clear schema-level visibility concept. | `OrgPlanVisibility`, plan models |
| CHARGE_ORG overage leg source | Overage now uses `OVERAGE_INVOICE_ACCRUAL`, avoiding the prior `@@unique([paymentId, source])` collision with the base `INVOICE_ACCRUAL` leg. | `prisma/schema.prisma`, `lib/payments/operations/checkout.ts`, `lib/payments/payment-legs.ts` |
| CHARGE_MEMBER overage copy | The error now accurately blocks sponsored checkout and tells the user to extend the program or book personally; it no longer says the booking succeeded. | `lib/payments/operations/checkout.ts` |
| Invoice payment idempotency | `providerPaymentOrderId` is persisted and reused for repeated invoice pay POSTs, preventing double order creation on retry/double-click. | `app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts` |
| Audit export bounds | CSV export streams in chunks with `MAX_ITERATIONS=400` and `CSV_CHUNK_SIZE=500`, capping export work at 200,000 rows. | `app/api/organizations/[orgId]/audit/export/route.ts` |
| Org invitation rate limiting | Invite POST is rate-limited per org before the Serializable transaction. | `lib/rate-limit.ts`, `app/api/organizations/[orgId]/invitations/route.ts` |
| PO and consent navigation | Purchase Orders and Consent are first-class sidebar entries instead of deep-link-only pages. | `app/dashboard/organization/[orgId]/layout.tsx` |
| Wallet billing copy | Wallet-funded orgs no longer see misleading NET-60 payment-terms copy. | `app/dashboard/organization/[orgId]/billing/BillingPageClient.tsx` |
| GST tax derivation | `deriveGstBreakdown()` computes zero-rated export, intra-state CGST+SGST, inter-state IGST, HSN defaulting, and place-of-supply derivation. It is not a zero-tax safe-default stub. | `lib/compliance/gst.ts` |
| IRP uploader schedule and self-exec | IRP uploader now has a daily GitHub Actions schedule and self-executes under `npx tsx`; connector remains env-gated and production-approval pending. | `.github/workflows/irp-uploader.yml`, `jobs/compliance/irp-uploader.ts` |
| MSME alert schedule and self-exec | MSME payment alerts now have a daily GitHub Actions schedule and self-execute under `npx tsx`; the header no longer calls the 15/45-day derivation a stub. | `.github/workflows/msme-payment-alerts.yml`, `jobs/compliance/msme-payment-alerts.ts` |
| DPDP DataBreach deadline tracking | A new hourly cron alerts on unreported DataBreach rows within 12 hours of the 72-hour reporting deadline, or already overdue. | `.github/workflows/databreach-deadline-alerts.yml`, `jobs/compliance/databreach-deadline-alerts.ts` |
| HRIS upload body guard | CSV-shaped HRIS JSON upload now rejects `Content-Length > 5 MB` before `req.json()` buffers the body. | `app/api/organizations/[orgId]/hris/csv-upload/route.ts` |

## Incorrectly Fixed Or High-Risk Fixes

| Area | Problem | Why it matters | Required correction |
|---|---|---|---|
| `OrgContextFilter` serialization drift | `serializeOrgFilter` maps `__personal__` to `none` and `__all__` to omitted param, while `resolveOrgScope` expects `personal`, orgId, or privileged `all`. Current mounted pages bypass this with hand-written mapping. | The component helper is stale and dangerous for future mount points; "All activity" means "all mine" in UI but `all` means staff/admin union in API. | Rename normal user union to `mine` or `all_mine`, remove `none`, and make component, hook, and API share one serialization contract. |
| Compliance comments drift | Some code comments/docs still call parts of MSME/GST/IRP "stubbed" even where helpers now do real derivation or env-gated calls. | Stale comments make auditors and implementers misclassify production risk. | Continue the docs drift pass so comments distinguish real derivation from missing ops, sandbox proof, dashboards, and signoff. |
| Stream org scope | Stream channel creation still defaults org metadata to null in generic stream channel creation. | Enterprise operators cannot reliably inspect all org video/chat activity, and retention/discovery boundaries are unclear. | Add org metadata to Stream channels/calls and reconcile it from appointment org context. |

## Partly Fixed

| Area | Current state | Remaining gap |
|---|---|---|
| Org scope across personal dashboards | `useOrgScope`, `resolveOrgScope`, and mounted filters exist on consultant planner/requests/documents and consultee appointments. | Semantics are inconsistent for "all mine" vs privileged `all`; payments/history/resources/messages are not uniformly scope-aware. |
| Org activity pages | Dedicated org pages exist for appointments, waitlist, trials, documents, recordings, reimbursements. | Need E2E proof that every new booking type, shared webinar/class, recording webhook, document upload, and waitlist join is stamped consistently. |
| SSO | Backend primitives and UI exist. | Needs real IdP acceptance run: domain claim, provider config, password/OAuth rejection for enforced domain, SSO login, session bridge, dashboard access, anti-lockout. |
| Invoicing | OrganizationInvoice, payment rollup fields, invoice PDF endpoints, invoice pay route, IRP fields, and retry telemetry exist. | PDF generation must be verified under production-like build/start; IRP payloads need live sandbox proof and accountant approval. |
| GST | `deriveGstBreakdown` now computes export, intra-state, and inter-state tax in code. | GSTIN registry verification, invoice sequence controls, LUT/export proof, RCM routing, accountant signoff, and production IRP payload validation need closure. |
| MSME | Deadline computation, alert job, AND real-data wiring all in place. `createOrgPayoutBatch` reads `Organization.msmeStatus` + `msmeWrittenAgreementOnFile` (new columns) and passes them to `computeMsmePaymentDeadline` — the protective 15/45-day branch fires for MICRO/SMALL host orgs. | Operator UI to set `msmeStatus` on the org settings page (today the column is admin-edited via Prisma). Finance dashboard for outstanding MSME deadlines (the alert email surfaces the same info). |
| TDS | Computation exists AND is wired into `lib/payments/payouts/org-payout-service.ts:createOrgPayoutBatch`: TDS is computed on every org payout, deducted from gross, and persisted (`tdsSectionApplied`, `tdsAmountPaise`, `dtaaRateApplied`). Settlement ledger reflects the post-TDS amount. | Quarterly Form 26Q / 27Q return-file generation, TDS certificate emission to host orgs, non-resident path coverage. CA sign-off on Section 194-O default still needed. |
| Form 15CA/15CB and FEMA | Schema fields and stub function exist. | Still blocks cross-border consultants unless handled manually off-platform. |
| DPDP | Consent artifact hashing, retention date, and DataBreach 72-hour deadline alerts exist. | `checkConsent` still always returns true; notice, withdrawal, breach intake/reporting workflow, erasure, multilingual notices, and consent-manager operations are incomplete. |
| Org payouts | Batch creation, PROCESSING transition, RazorpayX submission scaffold, failure classification, and clawback fields exist. | Needs live gateway smoke, webhook completion to UTR, Stripe Connect branch, idempotency proof, and payout reversal playbook. |
| Refunds | Reversal helpers, proportional utilization reversal, org earnings refunded amount, and clawback fields exist. | Multi-leg refunds, partial refunds after payout, credit notes, org invoice unbilling, and payout clawback automation remain GA blockers. |
| Reconciliation | Ledger reconciliation and admin route exist. | Needs soak period, alert routing, and hard failure policy for payment-leg sum mismatch and ledger drift. |
| Dashboards | Org/operator dashboards are broad and route inventory is good. | Analytics remains mostly stat-card level; admin/staff/consultant/consultee scope experiences are uneven. |
| Monitoring | Docs define monitoring and runbooks. | Needs real BetterStack/Sentry/Grafana dashboards, alert thresholds, and on-call runbooks tied to production signals. |

## Enterprise Logic Audit

### Organization Model

- [x] Capability model uses `canSponsor` and `canHost` instead of a fragile org-kind enum.
- [x] `FundingSource` separates PERSONAL, WALLET, INVOICE, LICENSE, and reserved PROJECT.
- [x] `OrgStatus`, domain verification, SSO settings, audit log, and deletion policy are modeled.
- [x] `OrgWorkspaceProfile` gives enterprise operators their own dashboard identity.
- [x] Hierarchy columns exist (`parentId`, `rootId`, `depth`).
- [ ] Hierarchy UI/rollup billing is still mostly future work.
- [ ] Provider/host orgs are still marked as partially gated in creation docs/comments.
- [ ] Some docs still describe older states or prior stub status and need a docs drift pass.

### Roles And Permissions

- [x] Typed `Membership` is the source of truth, with distinct `MemberRole`.
- [x] Server-side access helpers gate org APIs.
- [x] Role transition rules prevent disallowed LEARNER/EXPERT transitions.
- [x] Sidebar visibility is cosmetic; API gates still matter.
- [x] Contracts page has a client guard (`useRequireOrgAccess`) and server/API gates.
- [ ] Keep page-level guard documentation current for every deep-link page; do not infer absence without checking the page.
- [ ] Need automated IDOR tests for every org route, especially document/recording/activity exports.

### Lifecycle, Audit, And Deletion

- [x] Organization creation, verification, settings, invitations, members, contracts, programs, SSO, billing, and payout actions have audit concepts.
- [x] Deletion policy favors soft/deactivate semantics for business records.
- [ ] Audit completeness should be asserted with route tests, not maintained by human memory.
- [ ] Retention and deletion are not DPDP-complete until withdrawal/erasure and legal-hold behavior are implemented.

## Money And Booking Audit

### Booking Payment Algorithm

- [x] Checkout uses lock-protected two-phase booking/payment creation.
- [x] Redis locks and serializable transactions are used around high-contention booking paths.
- [x] Org-sponsored checkout resolves funding source, membership, program assignment, credit limit, and referral-credit restrictions.
- [x] `Appointment.organizationId` is now written at checkout for org-context bookings.
- [x] `Payment.organizationId` and `billingAccountId` are written for org-attributed payments.
- [x] WALLET debits atomically; INVOICE accrues; LICENSE absorbs booking amount with zero-value leg.
- [x] SUBSCRIPTION cap utilization is lazy at consultant allocation.
- [x] CHARGE_ORG overage no longer collides with base invoice-accrual legs because it uses `OVERAGE_INVOICE_ACCRUAL`.
- [x] CHARGE_MEMBER overage messaging now accurately describes a blocked sponsored checkout.
- [ ] Shared webinar/class semantics need explicit tests for owner org vs sponsoring org vs multi-org attendees.
- [ ] Overage behavior still needs E2E coverage across funding source x plan type x cap behavior before GA.
- [ ] Payment leg sum checks log warnings; settlement/test jobs need hard assertion coverage for all source combinations.

### Funding Sources

- [x] PERSONAL is reporting-only org tagging where member pays directly.
- [x] WALLET has balance, ledger, top-up, debit, and refund concepts.
- [x] INVOICE has credit limit, billable payment linkage, monthly rollup fields, and payment route.
- [x] LICENSE creates zero-amount booking leg and utilization against a program assignment.
- [ ] PROJECT is schema-reserved only and must stay hidden/blocked.
- [ ] CREDIT_POOL under LICENSE is still described as bogus and rejected at API/UI, not DB.

### Refunds, Payouts, And Clawbacks

- [x] Organization earnings and organization payouts exist separately from consultant earnings.
- [x] Payout idempotency key and gateway payout fields exist.
- [x] Clawback fields exist for refunds after payout.
- [x] RazorpayX submission path exists behind env flag.
- [ ] Stripe Connect org payout branch is deferred.
- [ ] Payout processed webhook to COMPLETED/UTR needs live proof.
- [ ] Partial refund, multi-leg refund, invoice credit note, and paid-payout clawback flows need end-to-end tests.
- [ ] Manual finance runbook is still required for design-partner rollout.

## Compliance Audit

| Compliance area | Repo state | Production verdict |
|---|---|---|
| GST tax split | Real: `deriveGstBreakdown` computes zero-rated export, intra-state CGST 9% + SGST 9%, and inter-state IGST 18% with HSN defaulting and place-of-supply derivation *(FF-6 corrected)*. | Needs GSTIN checksum + registry-lookup verification, invoice-sequence controls, LUT/export proof, RCM routing, accountant signoff, invoice fixture tests. |
| GST e-invoice / IRN | ClearTax scaffold exists; uploader stores retry telemetry and now runs daily through GitHub Actions. | Not GA until live/sandbox credentials, payload mapping, signed QR persistence, 24h cancel rule, and AP acceptance are proven. |
| TDS | Real derivation exists for 194O/194J/194C, PAN fallback, certificate, DTAA. | Needs accountant signoff, payout integration proof, non-resident handling, TDS return workflow. |
| MSME | Deadline helper implements 15/45-day rule; alert job exists and now runs daily through GitHub Actions. | Needs verified counterparty data, written-agreement evidence, finance dashboard proof, and production alert sink proof. |
| Form 15CA/15CB | Stub function returns null references. | Blocks non-resident/cross-border payouts unless handled manually. |
| FEMA/RBI PA-CB | Docs and schema fields exist. | Do not claim cross-border production support until provider route and compliance artifacts are signed off. |
| DPDP | Hashing, retention date, and DataBreach deadline alerts exist. | Not production-complete: consent enforcement, notices, withdrawal, breach intake/reporting workflow, erasure, and audit workflows missing. |
| Data residency | `dataResidencyRegion` exists on Organization. | Enforcement is not proven across storage, Stream, Novu, logs, analytics, and backups. |

## Dashboard And UX Audit

### Organization Dashboard

- [x] `/home`: operator overview exists.
- [x] `/my-program`: learner program allocation and utilization view exists.
- [x] `/my-arrangement`: expert payout/rate-card view exists.
- [x] `/members`, `/experts`, `/learners`, `/invitations`: membership surfaces exist.
- [x] `/contracts`, `/programs`, `/purchase-orders`: commercial setup surfaces exist.
- [x] `/billing`: invoices plus wallet tab exist.
- [x] `/payouts`, `/earnings` API: host-side money views exist.
- [x] `/appointments`, `/waitlist`, `/trials`, `/documents`, `/recordings`, `/reimbursements`: org activity and compliance-ish surfaces exist.
- [x] `/settings`, `/settings/sso`, `/audit`, `/consent`, `/analytics`: admin/security/reporting surfaces exist.
- [x] Contracts, Audit, Purchase Orders, and Consent are visible in sidebar with capability/role gates.
- [ ] Some pages need stronger empty/error state QA and role-deep-link tests.
- [ ] Analytics remains thin for enterprise buyers.
- [ ] Consent dashboard is not DPDP-complete.

### Org Workspace Dashboard

- [x] Cross-org home, activity, billing, settings, and create pages exist.
- [x] Routes are keyed by `OrgWorkspaceProfile`.
- [ ] Settings storage is still described as deferred.
- [ ] Cross-org dashboard should get tests for multi-org owners and deactivated-only org portfolios.

### Personal Dashboards

- [x] OrganizationSwitcher exists in consultee dashboard and org navigation contexts.
- [x] Consultant planner/requests/documents and consultee appointments mount `OrgContextFilter`.
- [ ] Consultee payments/history/resources/messages are not clearly scope-filtered.
- [ ] Consultant earnings/appointments/trials/recordings/collaborations are not uniformly scope-filtered.
- [ ] Admin/staff dashboards have some org filters but not a single uniform enterprise scope model.

### Filters, Switchers, Context

- [x] `useOrgScope` route-pins organization dashboard pages to the path orgId.
- [x] `resolveOrgScope` gates privileged `all` to ADMIN/STAFF.
- [x] `OrganizationSwitcher` gives members a direct path to org dashboards.
- [x] `OrgPayerSelector` exposes personal vs org payer selection at checkout.
- [ ] `OrgContextFilter` label and helper contract remain confusing.
- [ ] The UI concept "All activity" should be renamed to "All mine" or equivalent.
- [ ] A single shared serialization contract should replace page-by-page hand mapping.

## Cross-Cutting Integrations

| Integration | State | Pending |
|---|---|---|
| BetterAuth / SSO | Strong backend scaffolding, SSO provider CRUD, domain-check route, custom session enrichment. | Real IdP run, lockout drills, provider rotation, SSO-only UX. |
| Novu | Org workflow helpers exist for billing, payouts, program exhaustion, wallet top-up, and membership events. | Topic/org scoping and delivery proof for contractual notifications. |
| Stream chat/video | Core marketplace Stream integration exists. | Org metadata on channels/calls, org operator visibility, retention, and recording library. |
| Recordings | `Recording.organizationId` and org recordings page exist. | Webhook stamping proof, retention policy, transfer, deletion, and library UX. |
| Documents | Org document lists inherit through appointment org scope. | Review workflow, export, retention, and role tests. |
| Redis/Upstash | Locking and rate-limit docs exist; booking/wallet/payout locks are used. | Production alerting for lock contention and Redis failures. |
| Supabase/storage | Branding and document storage helpers exist. | Data residency and retention enforcement by org region. |
| Cron/GitHub Actions | Payout, reconciliation, compliance, cleanup jobs exist; IRP, MSME alerts, and DataBreach alerts now have schedules. | Cron staggering, production secrets, Slack/on-call alert routing, and idempotency proof. |
| Monitoring | Monitoring docs exist. | Real dashboards, alert thresholds, SLOs, log scrubbing, and compliance evidence. |

## Logically Pending To Reach 100

### P0 Production Gates

- [ ] Run checkout E2E for every funding source x plan type x overage behavior.
- [ ] Verify org invoice PDF and consumer invoice PDF under production-like build/start or deploy preview.
- [ ] Run real SSO acceptance against at least one OIDC or SAML provider.
- [ ] Run RazorpayX org payout sandbox with webhook completion and UTR capture.
- [ ] Prove org activity stamping for consultation, subscription, webinar, class, trial, waitlist, document, and recording flows.
- [ ] Align `OrgContextFilter`, `useOrgScope`, and `resolveOrgScope` serialization and labels.
- [ ] Add compliance runbook proving GST/TDS/MSME/IRP states for a real design-partner invoice and payout.

### P1 Correctness Hardening

- [ ] Multi-leg refunds with wallet, invoice accrual, license, referral credit, and card legs.
- [ ] Paid-payout clawback workflow and admin finance evidence.
- [ ] Credit notes and invoice unbilling for refunds/cancellations.
- [ ] Contract expiry cron and assignment lifecycle edge cases.
- [ ] Purchase-order 3-way match enforcement where `requiresPO=true`.
- [ ] Org hierarchy rollups for parent/child invoices and analytics.
- [ ] Reconciliation alert routing and 2-4 week zero-drift soak.
- [ ] Admin/staff org-scope filters across payments, payouts, invoices, disputes, refunds, subscriptions, appointments, users.

### P2 GA Polish

- [ ] Enterprise analytics charts and time-series dashboards.
- [ ] HRIS import/sync dedupe and audit UX.
- [ ] DPDP notice, withdrawal, erasure, breach, and multilingual notice workflows.
- [ ] Branded email domains/templates for enterprise buyers.
- [ ] Stream org recording library, retention, and access controls.
- [ ] Org catalog management beyond visibility flags.
- [ ] Operator notification preferences and cross-org settings persistence.
- [ ] Customer-facing runbooks and support escalation playbooks.

### Deferred / Not Production-Blocking For Design Partner

- [ ] PROJECT and RETAINER program types.
- [ ] Full parent-child enterprise billing hierarchy.
- [ ] Agent-of-record and employer-of-record payout arrangements.
- [ ] Advanced provider-org marketplace packaging.
- [ ] Full self-serve HRIS connectors beyond CSV.
- [ ] International expansion beyond manually controlled pilots.

## Production Readiness Checklist

### Correctly Fixed Checklist

- [x] Capability-based org model.
- [x] Typed memberships and roles.
- [x] Org workspace profile.
- [x] Billing account and funding source model.
- [x] Contracts and programs.
- [x] Engagement-based program utilization.
- [x] PaymentLeg model and source enum.
- [x] Appointment/waitlist/recording org IDs.
- [x] Runtime checkout appointment org stamping.
- [x] Org activity dashboards.
- [x] Wallet tab under billing.
- [x] TDS helper upgraded from safe default to real derivation.
- [x] MSME helper upgraded to 15/45-day rule.
- [x] RazorpayX org payout submission scaffold.
- [x] IRP retry telemetry.
- [x] CHARGE_ORG overage source uniqueness fixed with `OVERAGE_INVOICE_ACCRUAL`.
- [x] CHARGE_MEMBER overage error copy corrected.
- [x] Invoice pay endpoint idempotency verified via persisted `providerPaymentOrderId`.
- [x] Audit export row ceiling verified.
- [x] Org invite rate limit added.
- [x] Purchase Orders and Consent sidebar entries added.
- [x] Wallet org billing copy corrected.
- [x] GST derivation corrected as live, not zero-tax stubbed.
- [x] IRP uploader GH Actions schedule added.
- [x] MSME payment alerts GH Actions schedule added.
- [x] DataBreach 72-hour deadline alert cron added.
- [x] HRIS CSV-upload body-size guard added.
- [x] IRP/MSME compliance jobs now self-execute under `npx tsx`.

### Incorrectly Or Riskily Fixed Checklist

- [ ] `OrgContextFilter` helper is stale relative to `resolveOrgScope`.
- [ ] UI label "All activity" is ambiguous and should not map mentally to privileged `all`.
- [ ] Compliance comments/docs still misclassify some now-real helper logic as stubbed.

### Partly Fixed Checklist

- [ ] SSO is implemented structurally but not acceptance-proven.
- [ ] IRP can be env-gated live but is not production-approved.
- [ ] GST derives core tax split but lacks registry verification, RCM/LUT enforcement, sequence proof, and accountant signoff.
- [ ] Payouts can submit to RazorpayX but need sandbox/prod proof and webhook closeout.
- [ ] Refunds reverse some enterprise state but not all real-world money permutations.
- [ ] Dashboards are broad but not uniformly scope-filtered.
- [ ] Stream and recording org context exists only partially.
- [ ] DPDP has artifacts and breach-deadline alerts, not the full legal workflow.

## Coverage Appendix

Targeted scan inputs:

- Root prior-art files: `ENTERPRISE_PRODUCTION_GRADE_CHECKLIST_2026_05_01.md`, `tasks/enterprise-readiness-1.txt`.
- Schema: `prisma/schema.prisma`, plus enterprise seed/backfill scripts.
- Enterprise docs: `docs/enterprise/**`, including overview, API reference, dashboards, harness verdict, monitoring, idempotency, deletion policy, playbooks, explainers, and references.
- Finance/compliance/payment/booking docs: `docs/finances/**`, `docs/compliance/**`, `docs/payments/**`, `docs/booking/**`, `docs/dashboard/**`.
- Enterprise API/dashboard surfaces: `app/api/organizations/**`, `app/api/org-workspace/**`, `app/dashboard/organization/**`, `app/dashboard/org-workspace/**`.
- Personal/admin dashboard scope surfaces: consultant, consultee, staff, and admin dashboard routes with org scope or money relevance.
- Core libs/jobs: `lib/api/organizations/**`, `lib/payments/**`, `lib/compliance/**`, `lib/enterprise/**`, `lib/sso/**`, `lib/dashboard/**`, `jobs/**`.
- Cross-cutting UI: `components/dashboard/OrganizationSwitcher.tsx`, `components/dashboard/OrgContextFilter.tsx`, `app/checkout/components/OrgPayerSelector.tsx`, `components/enterprise/EnterpriseWipBanner.tsx`.
- Test/prompt corpus: enterprise and booking prompts under `prompts/**`, race-condition booking tests, and enterprise-related unit-test references found by search.

High-signal search terms used:

- `TODO`, `FIXME`, `stub`, `STUB`, `WIP`, `not implemented`, `EnterpriseWipBanner`
- `orgScope`, `OrganizationSwitcher`, `OrgContextFilter`, `useOrgScope`, `resolveOrgScope`
- `organizationId`, `PaymentLeg`, `BookingUtilization`, `recordBookingUtilization`
- `IRP`, `IRN`, `TDS`, `MSME`, `DPDP`, `Form 15`, `FEMA`, `PA-CB`
- `walletDebit`, `INVOICE_ACCRUAL`, `LICENSE`, `overage`, `refund`, `clawback`

Known limitation: this checklist is a code/docs readiness audit, not a replacement for production smoke tests, legal/accounting review, or live provider certification.
