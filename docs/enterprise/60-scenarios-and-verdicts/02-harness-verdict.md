---
title: Harness verdict
band: 60-scenarios-and-verdicts
audience: sde2
status: live
last-reviewed: 2026-06-05
---

# Harness verdict

The evaluation harness exercises four representative org scenarios plus a
set of cross-cutting checks — **36 line items**, **re-derived against
current code** after the v2 mega-audit (#777/#778/#779) shipped.
Current verdict: **31 ✅ / 5 🟡 / 0 🔴** as of **2026-06-07**.

**How to read this verdict.** Each row is one capability the harness asserts, scored from the customer's POV: **✅** means a seed user can drive it end-to-end *today* and get the right money/state; **🟡** means the schema is final and the happy path is correct, but a follow-on (a gateway call, a cron schedule, a cascade) is deliberately gated **off** — it stops short, it isn't wrong. The **evidence** for each row lives in three places, named in its Notes cell: the **code path** (`lib/…` / route / `jobs/…`), the **worked Dr/Cr** in [scenarios-and-examples](01-scenarios-and-examples.md) (linked per row), and the **click-through** to see it live in [verification-guide](../90-audits/03-verification-guide.md). A row is only ✅ if all three line up on a fresh reseed.

> **Seed cohort:** the four scenarios below map onto the deterministic
> seed cohort. See `00-overview.md → Seed / production-shaped grid` for the
> canonical slugs / capability shape per scenario, plus the
> `tour-owner@familiarise.dev` operator handle used by the harness sign-in
> path. The worked transcriptions for every line item are in
> [scenarios-and-examples](01-scenarios-and-examples.md).

Every 🟡 is a row where the **schema is final and the happy path works**,
but a populator (a cron schedule), a gateway integration (live payouts,
recurring mandates), or a downstream cascade (the `TdsAdjustment` model) is
deliberately **not wired** this wave. No 🔴 outstanding —
nothing in scope produces a wrong result; the gaps are *missing follow-on
automation*, not incorrect behaviour.

Legend:

- ✅ — implemented end-to-end against the current schema; verifiable on the seed.
- 🟡 — schema final + core path live, but an integration / cron schedule /
  cascade that completes the loop is stubbed or gated **off**. Behaviour is
  correct as far as it goes; it just stops short by design.
- 🔴 — not implemented / produces a wrong result. (None at this verdict.)
- 🔒 — config-lock / immutability guard relevant to the row.

## 1. Subsidiary billing (Wipro shape — SPONSOR · INVOICE · LICENSED_SEAT)

Items 1–7 exercise the postpaid invoice path end-to-end — contract creation and signing, `LICENSED_SEAT` program with an overage circuit breaker, per-booking accrual legs, cycle-close invoicing, contract supersession, and the IRN uploader — noting where the 🟡 operational gaps currently pause automation.

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 1 | Sponsor org `canSponsor=true, canHost=false, fundingSource=INVOICE` creates + signs a Contract | ✅ | `POST /api/organizations` + `POST /contracts` + `PATCH /contracts/[id]` (DRAFT→ACTIVE, `signedAt`). |
| 2 | `LICENSED_SEAT` Program with per-cycle cap + `overageBehavior=CHARGE_ORG` | ✅ | `POST /programs`, discriminated-union Zod body. Money config **locks 🔒** on the first assignment (`configLockedAt`, #779 §B). |
| 3 | Booking accrues a `PaymentLeg(source=INVOICE_ACCRUAL)` + `BookingUtilization` | ✅ | `lib/payments/operations/checkout.ts` calls `recordBookingUtilization` and writes the accrual leg in the same Serializable TX as the Payment. |
| 4 | Cap exhaustion → CHARGE_ORG overage with surcharge + circuit breaker | ✅ | `recordOverageAtCheckout` → `OverageEvent PENDING`; `overageSurchargeBps` markup; `maxOveragePerCyclePaise` breaker falls back to `BLOCK` (`PROGRAM_CAP_EXHAUSTED`). Pre-checkout preview at `/checkout/overage-preview` (#777 §C). See [scenarios-and-examples §5.12](01-scenarios-and-examples.md). |
| 5 | Cycle close rolls accrued bookings + overage into one `OrganizationInvoice` | ✅ | `settle-invoice-accruals.ts` (monthly, 1st, 04:00 UTC) + `generate-subscription-invoices.ts` (daily, 01:00 UTC) are now both **scheduled** with `concurrency` groups (#813); they walk `OverageEvent PENDING→ACCRUED`, and the accrual rollup reads inside a Serializable transaction so overlapping runs can't double-issue. Manual `POST /invoices` still works as an escape hatch. |
| 6 | Contract terminate / supersede + cascade (no zombie assignments) | ✅ | Terminate PATCH is guarded (live-assignment + outstanding-invoice blocks) then cascades programs→EXPIRED, assignments→CLOSED in one tx. Supersede route mints successor + re-points programs (#779 §A). Route-level only — no dashboard button (see Summary). |
| 7 | E-invoice (IRN) mapper + uploader | 🟡 | `buildIrpPayload` (NIC schema v1.1) + `irp-uploader.ts` cron are real and env-gated behind `ENABLE_IRP_UPLOADER` (off) + `CLEARTAX_*` creds; flag-off default is correct for sub-₹5cr (#778). |

## 2. Mixed compensation (LearnPro / Acme — HOST)

Items 8–12 cover the HOST (earn-only) shape: wallet top-up atomicity, the overdraft guard at checkout, `payoutRecipient=ORGANIZATION` collapsing the expert split, rate-card snapshot correctness, and where the live-payout gate currently stops the money.

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 8 | WALLET top-up via Razorpay → `WalletTopUp` (PENDING→CONFIRMED) + balanced `TOPUP` posting, atomic | ✅ | `confirmTopUp` posts `Dr CASH / Cr WALLET(org)`; `walletBalance` cache bumped in the same TX; idempotent on `providerOrderId` + `idempotencyKey`. |
| 9 | WALLET debit at checkout → conditional UPDATE + `BOOKING` posting | ✅ | `walletDebit()` raw conditional UPDATE on the cache (overdraft guard); the `Dr WALLET` leg posts in the booking tx. |
| 10 | EXPERT memberships with `payoutRecipient=ORGANIZATION` collapse the split | ✅ | Settlement reads the membership flag; the earnings row omits the expert-share leg (booked to the org). |
| 11 | Contract-scoped RateCard bump preserves historical bps via `*Applied` snapshot | ✅ | `bumpRateCard()` + `OrganizationEarnings.{platform,org,consultant}BpsApplied`; a bump never rewrites settled history. |
| 12 | Host-org payout (`ORG_PAYOUT`) with TDS + MSME deadline | 🟡 | `createOrgPayoutBatch` computes TDS (194-O default / 206AA fallback) + `mustPayByDate`, posts `Dr ORG_PAYABLE / Cr CASH + TDS_PAYABLE`, and **freezes at PROCESSING** — gateway disbursement is gated off (`ENABLE_LIVE_PAYOUTS=false`, #776 §B). Money doesn't leave the gateway. |

## 3. Hybrid org (IIT Madras — HYBRID · WALLET · CREDIT_POOL)

Items 13–20 verify that a HYBRID org correctly runs sponsor and host flows on the same payment, that the `CREDIT_POOL` money-meter accounts value rather than count, and that the v2 lifecycle additions (cycle rollover, auto-renew, SSO break-glass, wallet floor) behave as designed.

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 13 | HYBRID self-deal — sponsor (wallet out) + host (org earns) on ONE payment | ✅ | One `BOOKING` posts `Dr WALLET(org)` plus `Cr ORG_PAYABLE(org)` (host earnings) — both flows, one payment (see [scenarios-and-examples §5.6](01-scenarios-and-examples.md)). |
| 14 | `CREDIT_POOL` money-meter — credits burn by **price**, not count | ✅ | `consumedPaise` metered against `creditBudgetPerCycle × 100` (1 credit = ₹1); a ₹5,000 session burns more than a ₹500 one (#753). |
| 15 | `LICENSE` funding + LICENSED_SEAT (`coveredEngagementsPerCycle=null`) absorbs bookings | ✅ | Checkout writes `PaymentLeg(source=LICENSE, amountPaise=0)` + increments `BookingUtilization`; no `BOOKING` journal txn (nothing moved). |
| 16 | SSO enforcement + allowedEmailDomains via `OrganizationSSOSettings` | ✅ | `customSession` hook + `shouldRejectSession` / `lib/sso/enforce-session.ts`. |
| 17 | SSO break-glass — OWNER opens a 1–72h (default 4h) IdP-outage window | ✅ | `POST/DELETE /sso/break-glass`; sets `breakGlassUntil`, auth layer skips the `enforceSSO` gate while `> now`; who/why in the audit row (#779 §E). Route-level only — no dashboard button. |
| 18 | Cycle rollover — ended ACTIVE assignment ROLLs (successor minted) vs CLOSEs | ✅ | `advance-program-cycles.ts` (02:15 UTC, scheduled) + pure `decideCycleTransition`; ROLL zeroes counters + sets `rolledToAssignmentId`/`rolledAt`; CLOSE on contract-inactive / autoRenew-off / clamped (#779 §A, [scenarios-and-examples §5.11](01-scenarios-and-examples.md)). |
| 19 | Contract auto-renew (idempotent claim-gate) | ✅ | `auto-renew-contracts.ts` (02:30 UTC, scheduled) claims via `autoRenewedAt`, mints a RENEWAL successor, flips old → EXPIRED in one tx; `supersededByContractId @unique` is the double-run backstop. |
| 20 | Wallet floor / auto-top-up | 🟡 | `wallet-low-balance.ts` (23:45 UTC, scheduled) detects the dip and **notifies** finance + stamps the cooldown — **NOTIFY-ONLY**. `autoTopUpEnabled`/`autoTopUpAmountPaise`/`autoTopUpMandateId` are written-but-unread (no recurring mandate; no money moves, #777 §C). |

## 4. Solo marketplace consultant (Arjun — the org-layer no-op)

This scenario confirms that an independent consultant with no org membership flows through the standard marketplace path untouched by the enterprise layer — look here to verify the org layer is a true no-op for that shape.

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 21 | `resolveOrgShare()` returns null for an independent expert | ✅ | `lib/payments/payouts/earnings-service.ts`; the marketplace path is untouched by the enterprise layer. |
| 22 | `ConsultantProfile.isIndependent` flips correctly on membership add/remove | ✅ | Written by member CRUD. |

## Cross-cutting

Each row covers a capability that spans all four org shapes — RBAC, audit trails, config locking, SSO, compliance workflows, and reconciliation — where a gap would affect every scenario above.

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 23 | `OrgAuditLog` row emitted for every mutating route | ✅ | Handlers emit via `AUDIT_ACTIONS` constants (incl. the v2 actions: `CONTRACT_SUPERSEDED`, `CONTRACT_AUTO_RENEWED`, `PROGRAM_ASSIGNMENT_ROLLED`, `VERIFICATION_RESUBMITTED`, break-glass `SETTINGS_CHANGED`). |
| 24 | Field-level RBAC on money-bearing org fields | ✅ | `requireOrgBillingAdminOrOwner` + org-PATCH allowlists gate billing email / funding / branding-money fields to OWNER/BILLING_ADMIN (#779 §A). |
| 25 | Config lock 🔒 — program money config + contract terms immutable once in use | ✅ | `lib/enterprise/config-lock.ts`: `Program.configLockedAt` (`PROGRAM_CONFIG_LOCKED`) on first assignment; `LOCKED_CONTRACT_FIELDS` on a non-DRAFT/billing contract (`CONTRACT_TERMS_LOCKED`). Change-by-supersede, never mutate. |
| 26 | Program archive / soft-delete | ✅ | `Program.archivedAt` hides from active lists + the cycle engine skips it; archive PATCH refuses while any ACTIVE in-window assignment exists (`PROGRAM_HAS_ACTIVE_ASSIGNMENTS`); DELETE stays DRAFT-only (#777 §B). |
| 27 | Verification reject → resubmit loop (self-serve) | ✅ | `REJECT` is a sub-state of `PENDING_VERIFICATION` (stamps `verificationReason`/`verificationRejectedAt`); OWNER/MAINTAINER `POST /verification/resubmit` clears it; no `RESUBMIT` enum (#779 §A). |
| 28 | Webhook secret rotation grace | ✅ | Rotating a webhook secret keeps the old secret verifying for a 24h grace window (#777). |
| 29 | `OrgDataExportJob` — DPDP §11 export request → READY → signed-URL download | ✅ | `process-data-exports` cron drives PENDING→PROCESSING→READY; 7-day signed-URL TTL; FAILED/EXPIRED stop the poll. |
| 30 | Refund credit note (CGST Sec 34 / Rule 53) on invoiced refund | ✅ | `mintRefundCreditNote` (unified across cascade + webhook), proportional tax split, gapless per-org `<PREFIX>-CN-<FY>-<SEQ>`, `refundId @unique` idempotency (#776/#778 §D). |
| 31 | Refund-failed notification | ✅ | `reconcile-pending-refunds.ts` (every 15 min) pages the payer on a gateway-rejected `Refund` via `notifyFailedRefunds`, once (`failedNotifiedAt` gate) (#779 §A). |
| 32 | CHARGE_MEMBER overage timeout → FAILED | ✅ | `timeout-member-overages.ts` (23:00 UTC, scheduled, 14-day wall) stamps `chargeTimedOutAt`, flips `OverageEvent → FAILED`, frees the breaker ceiling, notifies the member (#779 §A). |
| 33 | Refund-driven TDS reversal | 🟡 | **Reversal ✅, richer model schema-only.** The refund cascade now calls the shared `recordTdsReversal` (`tax/tds-service.ts`), which writes a negative `isReversal` `TDSRecord` so the quarterly 26Q nets the withholding back out — integer-paise proportion, capped at the original (refund-then-chargeback can't double-reverse), filed-aware FY/quarter stamping, IST-aware (#813). The richer `TdsAdjustment` model is still **schema-only** (the consolidation target, #778 §D/§F), which is why this stays 🟡. |
| 34 | Nightly reconciliation over the journal + derived caches | ✅ | `runReconcileLedgers` emits `WALLET_BALANCE_DRIFT`, `LEDGER_TXN_IMBALANCE`, `EARNINGS_LEDGER_DRIFT`, `PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT`, `ACTIVE_SEAT_COUNT_DRIFT`, `PAYMENT_LEG_SUM_MISMATCH`, `ORG_PAYOUT_TOTAL_MISMATCH`, plus v1 `LEDGER_BALANCE_SNAPSHOT_DRIFT` / `REFUND_BOOKING_COHERENCE` (#776). `ok:true` on a fresh reseed. Wired `reconcile-ledgers.yml` (nightly 03:45 UTC) + admin route. |
| 35 | LICENSED_SEAT cap counts engagements across plan types | ✅ | One `Appointment` = one engagement (#710). CONSULTATION/WEBINAR debit 1 at checkout; CLASS debits N at enrolment; SUBSCRIPTION debits 1 per allocation lazily. Counter increment is a guarded conditional UPDATE (cap-check + increment can't race). |

## Summary

- **31 ✅** — core capability / funding / program / rate-card / wallet, the
  live checkout-leg wiring (rows 3, 9, 15), HYBRID self-deal (13), the
  credit money-meter (14), engagement-cap counting (35), reconciliation
  (34), the now-scheduled cycle-close invoicing (5), and the **v2 lifecycle
  surfaces that ship complete**: cycle rollover (18) + auto-renew (19) +
  their crons, contract terminate/ supersede + cascade (6), config lock +
  archive (25, 26), the OverageEvent system with surcharge + breaker +
  member-timeout (4, 32), field-level RBAC (24), SSO break-glass (17),
  verification resubmit (27), webhook rotation grace (28), data export (29),
  refund credit notes (30), refund-failed notify (31).
- **5 🟡** — schema-final, happy-path-correct, but each stops short by
  design (one row each):
  1. **Live payouts OFF** (row 12) — `ENABLE_LIVE_PAYOUTS=false`; org +
     consultant payouts freeze at `PROCESSING`, money never leaves the
     gateway. The full posting + TDS is computed; only the disbursement
     call is gated.
  2. **Dunning suspension config-gated off by default** (row 36) — stage 3
     now writes `dunningSuspendedAt` and blocks new sponsored bookings, but
     only when `ENABLE_DUNNING_SUSPEND` is set (#812); with the flag unset,
     dunning stays notify-only (mark OVERDUE + 7-day × ≤3 reminders).
  3. **Wallet auto-top-up notify-only** (row 20) — detects the dip and
     alerts; no recurring mandate, no auto-charge, no `WalletTopUp`.
  4. **`TdsAdjustment` model schema-only** (row 33) — the refund-driven
     reversal itself is now live via a negative `TDSRecord` (`recordTdsReversal`,
     #813); only the richer `TdsAdjustment` consolidation model is unwired.
  5. **IRP uploader gated off** (row 7) — mapper + cron are real but
     behind `ENABLE_IRP_UPLOADER` + `CLEARTAX_*`; correct for sub-₹5cr.
- **Caveat on two ✅ rows — route-level only, no dashboard UI:** contract
  **supersede/renew** (row 6) and **SSO break-glass** (row 17) work
  end-to-end via the route/cron and are counted ✅, but neither has a
  dashboard button yet (#777 §B / #779 §E) — the UI surfaces the *effect*
  (superseded/renewed rows, the audit entry), so drive them via the route.
- **0 🔴** — every scenario produces a correct result or a 🟡 with a known,
  bounded follow-up.

### Dunning (row 36 — folded into the Wipro/INVOICE scenario)

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 36 | ISSUED invoice past `dueDate` → OVERDUE + 7-day × ≤3 reminders → optional suspend | 🟡 | Reminders **✅**: the `dunning.ts` cron (23:30 UTC ≈ 05:00 IST, **scheduled**) marks `ISSUED → OVERDUE` (`markedOverdueAt`) and sends `notifyOrgInvoiceOverdue` on a 7-day cadence capped at 3 (`dunningReminderCount`), each claim idempotency-gated. Stage 3 now stamps `dunningSuspendedAt` 7 days past the last reminder, writes `INVOICE_DUNNING_SUSPENDED`, and blocks new sponsored bookings (claim + audit in one Serializable tx, #812) — but it is **`ENABLE_DUNNING_SUSPEND`-gated and off by default**, which keeps the row **🟡**. See [scenarios-and-examples §5.13](01-scenarios-and-examples.md) / [invoicing §7](../10-money-and-ledger/08-invoicing.md). |

> **Cron schedule cross-check** (GitHub Actions → `jobs/**`, verified
> 2026-06-07): `generate-subscription-invoices` 01:00 (daily) ·
> `advance-program-cycles` 02:15 · `auto-renew-contracts` 02:30 ·
> `expire-contracts` 03:00 · `reconcile-ledgers` 03:45 ·
> `settle-invoice-accruals` 04:00 (monthly, 1st, `ENABLE_CONSOLIDATED_INVOICE`-gated) ·
> `timeout-member-overages` 23:00 · `dunning` 23:30 · `wallet-low-balance`
> 23:45 (all UTC). `irp-uploader` 02:30 (gated `ENABLE_IRP_UPLOADER`). The
> two invoice jobs flagged unscheduled in the prior verdict now both have
> workflows with `concurrency` groups (#813 — row 5).

### Related docs

- [scenarios-and-examples](01-scenarios-and-examples.md) — the worked
  Dr/Cr transcription for every line item here.
- [design-partner-customer-set](03-design-partner-customer-set.md) — the
  sales rubric these readiness levels feed.
- [contract-lifecycle](../30-programs-and-lifecycle/07-contract-lifecycle.md) ·
  [cycle-engine-and-rollover](../30-programs-and-lifecycle/08-cycle-engine-and-rollover.md) — the v2
  lifecycle state machines (rows 6, 18, 19).
- `docs/enterprise/90-audits/03-verification-guide.md` — the seeded logins + click-through
  flows to verify each row live.
