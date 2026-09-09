# RazorpayX Payout Flow

> How consultants receive their earnings through RazorpayX Payouts.

**Last Updated**: 2026-02-14

---

## Overview

Consultant payouts for Indian consultants are handled through **RazorpayX Payouts** — a separate product from Razorpay Payments. RazorpayX provides direct fund transfers to consultant bank accounts or UPI IDs.

> **Important**: This system uses **RazorpayX Payouts** (Contacts + Fund Accounts + Payouts API), not Razorpay Route (Linked Accounts + Transfers). These are different Razorpay products.

---

## Key Concepts

### RazorpayX Architecture

```
+---------------------------------------------------------------------+
|                FAMILIARISE RAZORPAYX ACCOUNT                        |
|                                                                      |
|  +------------------+  +------------------+  +------------------+    |
|  |    Contact        |  |    Contact        |  |    Contact        |  |
|  |  (Consultant A)   |  |  (Consultant B)   |  |  (Consultant C)   |  |
|  +--------+---------+  +--------+---------+  +--------+---------+    |
|           |                     |                     |              |
|  +--------+---------+  +--------+---------+  +--------+---------+    |
|  |  Fund Account     |  |  Fund Account     |  |  Fund Account     |  |
|  |  Bank: HDFC       |  |  UPI: rahul@upi   |  |  Bank: SBI        |  |
|  +------------------+  +------------------+  +------------------+    |
+---------------------------------------------------------------------+
           |                     |                     |
           v                    v                     v
   +--------------+    +--------------+    +--------------+
   |  HDFC Bank   |    |  UPI Wallet  |    |  SBI Bank    |
   |  ****4521    |    |              |    |  ****3412    |
   +--------------+    +--------------+    +--------------+
```

### Key Terms

| Term             | Description                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| **Contact**      | A consultant registered in RazorpayX (holds name, email, phone)         |
| **Fund Account** | A bank account or UPI ID attached to a Contact                          |
| **Payout**       | A fund transfer from the platform's RazorpayX account to a Fund Account |

The consultant never needs a Razorpay account or dashboard access. We handle everything through the API.

---

## Consultant Onboarding

### What We Collect

1. **Basic details**: Name, email, phone
2. **Bank details**: Account number, IFSC code, account holder name
3. **OR UPI ID**: For UPI-based payouts

### Onboarding Flow

```
Consultant provides bank/UPI details
        |
        v
Create Contact in RazorpayX
(POST /contacts)
        |
        v
Create Fund Account
(POST /fund_accounts)
  - bank_account: name, IFSC, account number
  - OR vpa: UPI address
        |
        v
Optional: Penny Testing Validation
(POST /fund_accounts/validations)
  - Sends Rs. 1, immediately reversed
  - Verifies bank account is valid
        |
        v
Consultant ready for payouts
```

### What We Store

| We Store                                 | RazorpayX Stores           |
| ---------------------------------------- | -------------------------- |
| Contact ID                               | Full personal details      |
| Fund Account ID                          | Bank account numbers, IFSC |
| Masked display (e.g., HDFC \*\*\*\*4521) | Beneficiary name           |
| KYC status                               | Verification status        |
| Payout history                           | Transaction records        |

We **never** store full bank account numbers. Only RazorpayX IDs and masked display values.

---

## Payout Modes

RazorpayX supports multiple transfer modes, automatically selected based on amount and account type:

| Mode     | Speed            | Limit                              | When Used                       |
| -------- | ---------------- | ---------------------------------- | ------------------------------- |
| **UPI**  | Instant          | Per-bank limits                    | Fund Account is VPA (UPI ID)    |
| **IMPS** | Instant          | Up to Rs. 5,00,000 per transaction | Bank account, amount ≤ Rs. 5L   |
| **NEFT** | Batched (hourly) | No limit                           | Bank account, amount > Rs. 5L   |
| **RTGS** | Real-time        | Rs. 2,00,000 minimum               | Available but not auto-selected |

**Auto-selection logic**:

- VPA fund account → **UPI**
- Bank account, amount ≤ Rs. 5L → **IMPS**
- Bank account, amount > Rs. 5L → **NEFT**

---

## Payout Lifecycle

### Earnings Flow

```
Payment captured (webhook)
        |
        v
+-------------------+
|  Earnings: PENDING |  Hold period active
|  (ON_HOLD)        |
+--------+----------+
         |
         | Hold period expires
         |   - Consultation: 24 hours
         |   - Webinar: 48 hours
         |   - Subscription: 7 days
         |   - Class: 24 hours
         v
+-------------------+
|  Earnings: READY  |  Available for payout
+--------+----------+
         |
         | Weekly payout job runs
         v
+-------------------+
| Earnings: PROCESSING |  Included in payout batch
+--------+----------+
         |
         | RazorpayX webhook confirms
         v
+-------------------+
|  Earnings: PAID   |  Funds in consultant's bank
+-------------------+

Special states:
  REFUNDED  — Payment was refunded, earnings cancelled
  DISPUTED  — Customer raised dispute, earnings frozen
```

### Payout Batch Cycle

```
Weekly payout job runs (cron)
        |
        v
Find all consultants with:
  - Earnings status = READY
  - Total >= Rs. 500 (minimum payout)
  - Active fund account
        |
        v
Create Payout records (one per consultant)
  - Amount < Rs. 5,000 → auto-approved
  - Amount >= Rs. 5,000 → needs admin approval
        |
        v
Admin approves pending payouts (if needed)
        |
        v
Process approved payouts:
  - Call RazorpayX Payouts API
  - Include idempotency key (required since March 2025)
  - Auto-select payout mode (IMPS/NEFT/UPI)
        |
        v
RazorpayX processes transfer
        |
        v
Webhook confirms status
```

### Payout Constants

| Constant               | Value     | Description                                    |
| ---------------------- | --------- | ---------------------------------------------- |
| Minimum payout         | Rs. 500   | Below this, payout is skipped until next cycle |
| Auto-approve threshold | Rs. 5,000 | Below this, no admin approval needed           |
| Max retry attempts     | 3         | After 3 failures, flagged for manual review    |
| GST rate               | 18%       | Applied to platform fees                       |
| SAC code               | 999293    | Service Accounting Code for tax                |

**Source**: `lib/payments/payouts/constants.ts`

---

## Payout States

### RazorpayX Payout Status Mapping

RazorpayX has three intermediate payout states and five terminal ones, and every terminal state must map to a terminal internal state. If a terminal gateway state is read as an intermediate one, the payout never leaves PROCESSING, its earnings stay BATCHED, and the consultant is neither paid nor re-queued. The mapping below is the full set as documented at [RazorpayX Payout Status](https://razorpay.com/docs/x/payouts/status-details/).

| RazorpayX Status | Internal Status | Description                                               |
| ---------------- | --------------- | --------------------------------------------------------- |
| `queued`         | PENDING         | Queued due to low balance                                 |
| `pending`        | PENDING         | Awaiting approval in the RazorpayX approval workflow      |
| `processing`     | PROCESSING      | Being processed by RazorpayX                              |
| `processed`      | COMPLETED       | Funds transferred to bank                                 |
| `reversed`       | FAILED          | Bank returned the funds; RazorpayX credited us back       |
| `rejected`       | FAILED          | Approval was refused or lapsed                            |
| `failed`         | FAILED          | The transfer failed at RazorpayX, the bank, or in transit |
| `cancelled`      | CANCELLED       | A queued payout was cancelled manually                    |

An unrecognised status deliberately maps to PENDING rather than to a terminal state, because "we do not know yet" must keep the reconciler polling instead of settling a payout on a guess.

---

## Webhook Events

| Event              | When It Fires                  | What We Do                                    |
| ------------------ | ------------------------------ | --------------------------------------------- |
| `payout.processed` | Funds transferred successfully | Mark payout COMPLETED, earnings as PAID       |
| `payout.reversed`  | Bank returned funds            | Mark payout FAILED, restore available balance |
| `payout.rejected`  | RazorpayX rejected payout      | Mark payout FAILED, alert admin               |
| `payout.failed`    | Transfer failed at the bank    | Mark payout FAILED, return earnings to READY  |
| `payout.queued`    | Insufficient balance, queued   | Update payout status to PENDING               |
| `payout.pending`   | Payout pending processing      | Update payout status                          |
| `payout.cancelled` | Payout cancelled               | Mark payout CANCELLED                         |

**Source**: `app/api/webhooks/razorpay/route.ts` (payout event handling section)

---

## Environment Variables

| Variable                   | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `RAZORPAYX_KEY_ID`         | RazorpayX API key (falls back to `RAZORPAY_KEY_ID`)    |
| `RAZORPAYX_KEY_SECRET`     | RazorpayX API secret (falls back to `RAZORPAY_SECRET`) |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX account number (required, no fallback)       |
| `RAZORPAYX_WEBHOOK_SECRET` | Webhook signature verification secret                  |

---

## Idempotency

Since March 2025, RazorpayX **requires** an idempotency key on every payout request. This prevents duplicate payouts if a request is retried.

The key must be deterministic for a given payout, because that is the only property that makes a retry safe. `generateIdempotencyKey` in `lib/payments/payouts/razorpay-payouts.ts` therefore returns `payout_{payoutId}` and nothing else. An earlier version appended a timestamp, which produced a fresh key on every attempt and so defeated the mechanism entirely: a retry after a timeout would have submitted a second payout for the same earnings. Do not reintroduce a clock, a random suffix or an attempt counter into this key.

The key is sent via the `X-Payout-Idempotency` header. When the payout row already carries an `idempotencyKey`, that value is used ahead of the generated one, so every attempt on a given row lands on the same RazorpayX idempotency slot.

RazorpayX bounds that header at 4 to 36 characters drawn from letters, digits, hyphens, underscores and spaces, and answers anything else with a 400. Two of our keys overshoot it: an organization payout derives `payout_<uuid>`, which is 43 characters, and a consultant payout persists `payout_<consultantProfileId>_<batchId>`, which is 72. `boundPayoutIdempotencyKey` therefore folds any key the gateway would refuse onto a 34-character digest of itself at the point the header is written. The fold is a pure function of the key, so determinism is preserved and a retry still returns the original payout rather than creating a second one. The persisted `idempotencyKey` is left alone, because it is also the row's unique constraint and the Stripe transfer key, and neither of those is bounded the way this header is.

---

## Common Scenarios

### Normal Weekly Payout

```
Mon-Fri:  Sessions happen, earnings accumulate
          Each payment creates PENDING earnings

+24-168h: Hold periods expire
          Earnings become READY

Weekly:   Payout job runs
          Groups READY earnings by consultant
          Creates payouts (auto-approve if < Rs. 5,000)

+0-2 days: Funds arrive in consultant's bank account
           Webhook: payout.processed
```

### Failed Payout

```
Payout initiated → RazorpayX processes → Bank rejects

Webhook: payout.reversed or payout.rejected
  - Payout marked FAILED
  - Earnings restored to READY
  - Admin alerted
  - Will retry on next payout cycle (up to 3 attempts)
```

### Refund During Hold Period

```
Customer pays Rs. 1,000
Earnings created: Rs. 776 (PENDING, in hold)

Customer requests refund before hold expires:
  - Refund processed
  - Earnings cancelled (REFUNDED)
  - Consultant never sees funds
```

---

## Error Handling

| Error                 | Resolution                                   |
| --------------------- | -------------------------------------------- |
| Insufficient balance  | Queue payout, process when balance available |
| Invalid fund account  | Consultant needs to update bank details      |
| Account closed        | Consultant needs new bank details            |
| Rejected by RazorpayX | Check compliance, contact support            |

After 3 failed attempts, the payout is flagged for manual review.

---

## Source Files

| File                                          | Purpose                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `lib/payments/payouts/razorpay-payouts.ts`    | RazorpayPayoutsService class — contacts, fund accounts, payouts        |
| `lib/payments/payouts/payout-service.ts`      | Provider-agnostic orchestration — batch creation, approval, processing |
| `lib/payments/payouts/constants.ts`           | Hold periods, minimum amounts, fee percentages                         |
| `lib/payments/payouts/earnings-service.ts`    | Earnings calculation (flat 20% platform fee)                           |
| `app/api/webhooks/razorpay/route.ts`          | Webhook handler for payout events                                      |
| `app/api/consultant/payout-accounts/route.ts` | Consultant API for managing payout accounts                            |

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [01-setup.md](./01-setup.md) — Setup and configuration
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) — Payment flow and revenue split
- [Payouts Overview](../../payouts/README.md) — Full payout system documentation
- [Payouts: Razorpay Implementation](../../payouts/07-razorpay-implementation.md) — Detailed implementation reference
