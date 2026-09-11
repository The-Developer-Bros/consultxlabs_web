# B2C ↔ B2B Funding Seam

> How org money flows through a consumer-facing checkout, how the three org linkage fields on `Payment` divide responsibility, and where the seam becomes visible in refunds and ledger attribution.

---

## Three Org Linkage Fields on Payment

Every `Payment` row can carry up to three org-scoped fields set at checkout time (`lib/payments/operations/checkout.ts`):

| Field | Type | On-delete | Purpose |
|---|---|---|---|
| `organizationId` | `String?` | `SetNull` | Reporting tag. Answers "which org's member made this booking?" Used by analytics, audit feeds, and the `INVOICE_REFUNDED` audit row (Step 8 of refund cascade). Can be NULL even when org money moved — see §invisible path below. |
| `billingAccountId` | `String?` | `SetNull` | Settlement pointer. Identifies whose `BillingAccount` is charged (wallet debit or invoice accrual). Non-null for `WALLET`/`INVOICE`/`LICENSE` checkouts. `BillingAccount.ownerOrgId` is the definitive wallet owner. |
| `billableToOrgInvoiceId` | `String?` | `SetNull` | Billing rollup. Stamped by the monthly settle-accruals job (`jobs/billing/settle-invoice-accruals.ts`) when this payment's `INVOICE_ACCRUAL` leg is rolled into an `OrganizationInvoice`. `null` = still pending in the current period. |

Schema source: `prisma/schema.prisma:4136–4242` (`model Payment`).

---

## fundingSource Gates at Checkout

`BillingAccount.fundingSource` (`prisma/schema.prisma:1100`, enum `FundingSource`) selects the money path:

```
PERSONAL  → org is tagged for reporting only; learner pays card.
WALLET    → debit BillingAccount.walletBalance atomically (walletDebit helper).
INVOICE   → accrue to the org's monthly invoice; no real-time charge.
LICENSE   → absorbed by a LICENSED_SEAT program; amount billed = 0.
```

Resolution happens in `lib/payments/operations/checkout.ts:1986`:

```typescript
fundingSource = org.billingAccount?.fundingSource ?? "PERSONAL";
```

### skipPayment — the instant-confirm path

For any non-PERSONAL org-funded checkout the gateway is bypassed entirely:

```typescript
// checkout.ts:2316
const skipPayment = isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment;
// isOrgSponsoredPayment = isOrgWalletPayment || isOrgInvoicedPayment || isOrgLicensedPayment  (checkout.ts:2179)
```

A synthetic `paymentIntent` id (prefix `org_wallet_` / `org_license_` / `org_invoice_`) is minted locally; no Razorpay/Stripe call is made. The `Payment` row is created with `paymentStatus: SUCCEEDED` immediately (`checkout.ts:2385–2425`). Appointments are confirmed (non-tentative) in the same transaction — no webhook is required to complete the booking.

---

## PaymentLeg Sources and *_REVERSAL Siblings

Each `Payment` carries zero or more `PaymentLeg` rows (append-only; `prisma/schema.prisma:4270–4290`):

| Source | Money event | sourceRef |
|---|---|---|
| `CARD` | External gateway charge | gateway payment id (`pay_xxx` / `ch_xxx`) |
| `WALLET` | BillingAccount wallet debit | `ProgramAssignment.id` |
| `INVOICE_ACCRUAL` | Rolled into month-end org invoice | `ProgramAssignment.id` |
| `OVERAGE_INVOICE_ACCRUAL` | Marginal cap-breach charge (CHARGE_ORG path) | `ProgramAssignment.id` |
| `LICENSE` | Absorbed by LICENSED_SEAT program; amountPaise = 0 | `ProgramAssignment.id` |
| `REFERRAL_CREDIT` | Platform-issued personal credit | `ReferralCreditUsage.id` |
| `INVOICE_ACCRUAL_REVERSAL` | Refund counter-entry for unbilled accrual (#786/#781 §B) | same as original |
| `OVERAGE_INVOICE_ACCRUAL_REVERSAL` | Refund counter-entry for overage accrual | same as original |

Legs are **append-only** — a refund never mutates the original leg; it upserts a negative `*_REVERSAL` sibling (`lib/payments/operations/refund.ts:778`). The `@@unique([paymentId, source])` constraint means one reversal leg per source; subsequent partial refunds decrement the existing reversal leg via `update: { amountPaise: { decrement: reverse } }`.

Invariant: `sum(non-reversal, non-REFERRAL_CREDIT legs.amountPaise) == Payment.amount` when legs are present (LICENSE legs contribute 0). The referral credit sits outside the sum because `Payment.amount` is the post-credit gateway charge, so the credit has already been deducted from it and counting the leg as well would demand it twice (#1347). See [payment legs §3](../enterprise/10-money-and-ledger/09-payment-legs.md#3-invariants).

### Programme overage across the rails (#1458)

A booking that breaches its programme's cap does not settle the same way on every rail, because the rails collect at different moments.

On the **INVOICE** rail the org has not paid anything yet, so the marginal is carved out of the base `INVOICE_ACCRUAL` leg into an `OVERAGE_INVOICE_ACCRUAL` leg and billed at the month-end rollup. On the **WALLET** rail the debit taken when the booking committed is the whole nominal price, so the overage is collected the moment the booking commits: no `OVERAGE_INVOICE_ACCRUAL` leg is written, `Payment.amount` is left exactly at the wallet debit, and the `OverageEvent` is recorded as `CHARGED` and settled against the payment whose `WALLET` leg collected it. Writing a leg there would have broken the leg-sum invariant above and, worse, incrementing `Payment.amount` on top of it made a later cancellation refund the organisation more than its wallet was ever debited.

`CHARGE_MEMBER` is **not available on a WALLET-funded billing account**. Charging the member requires carving the over-cap portion back out of the parent payment, which on this rail would mean crediting the wallet mid-transaction — the credit-back that #715 has never built. The combination is refused when a programme is created or patched, and checkout keeps a fail-closed refusal (`OVERAGE_CHARGE_MEMBER_UNSUPPORTED`, HTTP 409) for any programme configured before that guard existed.

`PROGRAM_CAP_EXHAUSTED` is the contract for the per-cycle overage ceiling. The settlement code throws it as an HTTP 402 with a machine-readable code, the checkout transaction's catch rethrows it unchanged because that code is registered in `BUSINESS_ERROR_CODES`, and the route answers 402 with a toast telling the buyer that the organisation's programme budget for this cycle is used up. It is a modelled outcome, so Sentry records it as expected volume rather than a fault; the two overage funding refusals above are deliberately not modelled, because they mean a programme was configured in a shape no rail can collect on.

---

## Refund Visibility Across the Seam

A refund on an org-funded booking writes up to three separate audit rows via `lib/payments/operations/refund.ts`:

### 1. WALLET_REFUND audit row (Step 4)
Written when a `WALLET` leg is reversed. `walletCredit` credits `BillingAccount.walletBalance` and the refund cascade writes an `OrgAuditLog` entry:

```typescript
// refund.ts:731–748
await tx.orgAuditLog.create({
  organizationId: payment.organizationId ?? credit.ownerOrgId,
  category: "WALLET",
  action: AUDIT_ACTIONS.WALLET.WALLET_REFUND,
  ...
});
```

Attribution: `payment.organizationId` if set; otherwise falls back to `BillingAccount.ownerOrgId` (`walletCredit` returns `ownerOrgId` for exactly this fallback — `lib/api/organizations/wallet.ts:156–159`).

### 2. INVOICE_REFUNDED audit row (Step 8)
Written when `payment.organizationId` is set and no clawback was written for the same org in Step 7:

```typescript
// refund.ts:1117–1134
if (payment.organizationId && !clawbackInitiated) {
  category: "INVOICE",
  action: AUDIT_ACTIONS.INVOICE.INVOICE_REFUNDED,
  ...
}
```

This is the fallback org-side audit record for PERSONAL, INVOICE, and LICENSE-funded refunds where there is no wallet credit or payout clawback.

### 3. Clawback row (Step 7)
Written when the booking's `OrganizationEarnings` row was already paid out (payout `status = COMPLETED`) and is now reversed. The clawback stamps `OrganizationPayout.clawbackAmountPaise` and writes an `AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK` `OrgAuditLog` entry:

```typescript
// refund.ts:997–1013
category: "PAYOUT",
action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
```

Ledger attribution: the double-entry reversal (Step 9, `refund.ts:1137`; the WALLET-account attribution branch at `:1160`) uses `payment.organizationId ?? walletOwnerOrgId` — `walletOwnerOrgId` is populated from `walletCredit.ownerOrgId` captured in Step 4, so the journal never loses its org anchor even on the invisible path.

---

## Wallet Lifecycle

```
initiateTopUp → WalletTopUp(PENDING, providerOrderId @unique)
     ↓ client pays (Razorpay checkout)
confirmTopUp  → WalletTopUp(CONFIRMED), walletBalance += amount
              → double-entry: Dr CASH / Cr WALLET(org)   [lib/api/organizations/wallet.ts:132–153]

checkout (WALLET-funded) → walletDebit → walletBalance -= booking amount  [checkout.ts:2439]

refund        → walletCredit → walletBalance += refund amount
              → WALLET_REFUND audit row
```

**WalletTopUp idempotency:** `providerOrderId` has a `@unique` constraint (`prisma/schema.prisma:1238`). A duplicate webhook delivery hits P2002 and is deduplicated — the wallet is never double-credited.

**Double-entry for topup** (`lib/api/organizations/wallet.ts:132`):
```
Dr CASH(platform)   Cr WALLET(org)
```
Keyed by `topup:<providerOrderId ?? paymentId ?? billingAccountId:balance>`.

**Booking debit** does not post a journal entry at debit time — the Dr WALLET posting comes from the settlement layer (`createEarningsFromPayment`) where the full fee/payable split is known (`lib/api/organizations/wallet.ts:87–91`).

---

## The #835 Invisible Path — Payment.organizationId Can Be NULL

An org-wallet-funded checkout normally sets `Payment.organizationId = org.id`. However, the checkout code traces the org from `validatedData.organizationId` — if that field is absent (e.g., a B2C booking where the learner is an org member but did not pass their org context), the wallet can be debited via `billingAccountId` without `organizationId` being set on the Payment.

Consequence: `payment.organizationId` is NULL while the org's wallet balance decreased.

**How refund.ts resolves it (the fix, `lib/api/organizations/wallet.ts:156–159`):**

```typescript
// walletCredit returns ownerOrgId from BillingAccount
return { balanceAfter, ownerOrgId: acct.ownerOrgId };

// refund.ts:724, 733
walletOwnerOrgId = credit.ownerOrgId;
organizationId: payment.organizationId ?? credit.ownerOrgId,
```

`BillingAccount.ownerOrgId` is the canonical ground-truth org for the wallet regardless of how the Payment row was tagged. All wallet-refund audit rows and Step 9 ledger postings use this fallback, so the double-entry journal is always org-attributed even when `payment.organizationId` is null.

---

## Deeper References

- Payout pipeline (org side): `docs/enterprise/10-money-and-ledger/07-payout-pipeline.md`
- Refund cascade in full: `docs/payments/refunds-disputes/02-refund-flow.md` (and `lib/payments/operations/refund.ts`)
- Enterprise money band / program entitlements: `docs/enterprise/10-money-and-ledger/`
- Wallet top-up API: `lib/api/organizations/wallet.ts`
- Checkout funding resolution: `lib/payments/operations/checkout.ts:1864–2097`
- The booking-side view of this rail: `docs/booking/17-org-funded-checkout.md`
