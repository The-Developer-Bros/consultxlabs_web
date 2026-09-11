# Referral Credits — Detailed Guide

## Overview

Referral credits are a platform currency denominated in paise (100 paise = 1 INR). They function as a wallet system where users accumulate credits from referral rewards and spend them on service purchases.

---

## Credit Sources

| Source           | Recipient                | Amount              | Trigger                           |
| ---------------- | ------------------------ | ------------------- | --------------------------------- |
| `REFEREE_BONUS`  | New user (referee)       | ₹200 (20,000 paise) | Signs up via referral link        |
| `REFERRAL_BONUS` | Existing user (referrer) | ₹500 (50,000 paise) | Referee makes first paid booking  |
| `PROMOTION`      | Any user                 | Variable            | Platform campaign (admin-created) |
| `COMPENSATION`   | Any user                 | Variable            | Customer support resolution       |
| `MANUAL`         | Any user                 | Variable            | Staff/admin manual entry          |

---

## Credit Lifecycle

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   CREATED    │────>│   ACTIVE     │────>│  PARTIALLY   │────>│   CONSUMED   │
│              │     │              │     │   USED       │     │              │
│ amount=50000 │     │ remaining=   │     │ remaining=   │     │ remaining=0  │
│ remaining=   │     │  50000       │     │  30000       │     │ usedAt=now   │
│  50000       │     │              │     │              │     │              │
│ usedAmount=0 │     │ usedAmount=0 │     │ usedAmount=  │     │ usedAmount=  │
│              │     │              │     │  20000       │     │  50000       │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                            │
                            │ (if expiresAt < now)
                            ▼
                     ┌──────────────┐
                     │   EXPIRED    │
                     │              │
                     │ remaining→0  │
                     │ (by cron)    │
                     └──────────────┘
```

There is no explicit `status` field on ReferralCredit. Status is inferred:

- **Active**: `remainingAmount > 0` and (`expiresAt IS NULL` or `expiresAt > now`)
- **Partially Used**: `usedAmount > 0` and `remainingAmount > 0`
- **Consumed**: `remainingAmount = 0` and `usedAt IS NOT NULL`
- **Expired**: `remainingAmount = 0` and was zeroed by the expiry cron job

---

## Consumption Algorithm (FIFO)

When a user applies credits at checkout, the system consumes from the oldest-expiring credit first:

```typescript
// lib/referrals/service.ts — applyCreditsToPayment()

async function applyCreditsToPayment(userId: string, amount: number) {
  // 1. Fetch all active credits, ordered by expiresAt ASC (nulls last)
  const credits = await prisma.referralCredit.findMany({
    where: {
      userId,
      remainingAmount: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { expiresAt: "asc" }, // Earliest expiry first
  });

  let remaining = amount;

  // 2. Consume credits one by one
  for (const credit of credits) {
    if (remaining <= 0) break;

    const deduction = Math.min(credit.remainingAmount, remaining);

    await prisma.referralCredit.update({
      where: { id: credit.id },
      data: {
        remainingAmount: credit.remainingAmount - deduction,
        usedAmount: credit.usedAmount + deduction,
        ...(credit.remainingAmount - deduction === 0
          ? { usedAt: new Date() }
          : {}),
      },
    });

    remaining -= deduction;
  }

  return amount - remaining; // Actual amount applied
}
```

### Example

User has 3 credits:

| Credit | Amount | Remaining | Expires    |
| ------ | ------ | --------- | ---------- |
| A      | ₹200   | ₹200      | 2026-06-15 |
| B      | ₹500   | ₹300      | 2026-08-01 |
| C      | ₹100   | ₹100      | never      |

User wants to apply ₹400 at checkout:

1. Consume Credit A: ₹200 → remaining = ₹0, usedAt = now. ₹200 left to apply.
2. Consume Credit B: ₹200 of ₹300 → remaining = ₹100. ₹0 left to apply.
3. Credit C untouched.

Result: ₹400 applied. Credit A fully consumed. Credit B partially used.

---

## Expiry

### Rules

- Credits from referral rewards expire **6 months** after creation
- `PROMOTION` credits may have custom expiry dates
- `MANUAL` credits can be set to never expire (`expiresAt = null`)

### Cron Job

```
File: scripts/referrals/expire-credits.ts
Schedule: Daily

Action:
  For all credits where:
    - remainingAmount > 0
    - expiresAt IS NOT NULL
    - expiresAt < now()

  Set remainingAmount = 0
```

---

## Refund Reversal

When a payment that consumed referral credits is refunded, `reverseCreditsForPayment` restores the consumed amount to the originating credit so the balance is made whole again. As of #692 (REF-2), that restoration is skipped for any credit that has since expired. Putting `remainingAmount` back onto a lapsed credit would only create dead balance that the daily expiry cron immediately re-zeroes and that the available-balance query already filters out, so the buyer would gain nothing. When a refund touches an expired credit the reversal instead logs the skipped amount and leaves the usage record in place, so the credit reads as genuinely consumed rather than briefly resurrected. Reissuing fresh credit for a refund of an already-expired purchase is a deliberate product decision and is not done automatically.

---

## Available Balance Calculation

```sql
SELECT SUM(remaining_amount)
FROM referral_credits
WHERE user_id = ?
  AND remaining_amount > 0
  AND (expires_at IS NULL OR expires_at > NOW())
```

This is what `GET /api/referrals/credits/available` returns.

---

## Dashboard Display

### Credit History Table

Shown on both consultant and consultee referral dashboard pages:

| Column    | Source                             |
| --------- | ---------------------------------- |
| Amount    | `amount` formatted as INR          |
| Source    | `source` enum label                |
| Remaining | `remainingAmount` formatted as INR |
| Expires   | `expiresAt` formatted, or "Never"  |
| Status    | Derived: Active / Used / Expired   |

### Available Balance Card

Prominent stat card showing total available credits:

```
┌───────────────────────┐
│  Credit Balance        │
│  ₹700.00              │
│  Available to use      │
└───────────────────────┘
```

---

## Edge Cases

| Scenario                                 | Behavior                                    |
| ---------------------------------------- | ------------------------------------------- |
| Credits exceed order total               | Only apply up to order total                |
| All credits expired                      | Toggle hidden, no credits applied           |
| Credit expires mid-checkout              | Caught at payment time; partial application |
| User has credits from multiple sources   | All treated equally in FIFO queue           |
| Concurrent credit usage (race condition) | Transactional updates prevent double-spend  |
