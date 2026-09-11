# Referral System

**Status**: Implemented (Feb 2026)
**Branch**: `feat/referral-collaborator-system`

## Overview

The referral system enables viral growth by rewarding both referrers and referees with platform credits. Any user (consultant or consultee) can generate a unique referral link, share it, and earn credits when the referred user makes their first paid booking.

### Goals

- Lower customer acquisition cost through word-of-mouth
- Incentivize both sides of the marketplace (referrer + referee)
- Create a credit-based wallet that drives repeat purchases
- Track referral lifecycle from signup through qualification

### Key Design Decisions

| Decision             | Choice                          | Rationale                                 |
| -------------------- | ------------------------------- | ----------------------------------------- |
| Who can refer        | Both consultants and consultees | Maximizes growth surface                  |
| Qualifying action    | First paid booking              | Ensures real engagement, not just signups |
| Reward type          | Platform credits (not cash)     | Drives GMV, avoids payout complexity      |
| Qualification window | 30 days                         | Balances urgency with fairness            |
| Credit expiry        | 6 months                        | Prevents stale liabilities                |
| Credit consumption   | FIFO by expiry date             | Minimizes expired unused credits          |
| Anti-fraud           | Deferred for MVP                | Ship fast, add safeguards later           |

> **Planned evolution (decisions finalized 2026-06-17).** The flat ₹500/₹200,
> role-blind scheme above is the shipped MVP. It is being superseded by a
> role-weighted, demand-biased policy with a seller-side commission waiver,
> tightened guardrails, and a conservative launch. The full target model,
> decision log, and trade-offs live in
> [04-reward-economics-and-decisions.md](./04-reward-economics-and-decisions.md),
> and the capture-and-apply flow that fixes the OAuth referral drop is in
> [05-auth-onboarding-integration.md](./05-auth-onboarding-integration.md).
> Tracking issue: [#880](https://github.com/Practitionist/familiarise_web/issues/880).

---

## Architecture

### Data Model

```
┌─────────────────────────────────────────────────────────────┐
│                          User                                │
│  id, name, email, role                                       │
├──────────────┬──────────────────────┬───────────────────────┤
│              │                      │                        │
│    1:1       │    1:1 (as referee)  │    1:many              │
│              │                      │                        │
▼              ▼                      ▼                        │
┌──────────┐  ┌──────────┐  ┌──────────────┐                  │
│ Referral │  │ Referral │  │ ReferralCredit│                  │
│ Code     │  │          │  │              │                  │
│          │  │          │  │ amount       │                  │
│ code     │  │ status   │  │ remaining    │                  │
│ custom   │  │ rewards  │  │ source       │                  │
│ Code     │  │ qualify  │  │ expiresAt    │                  │
│ rewards  │  │ dates    │  │              │                  │
└──────────┘  └──────────┘  └──────────────┘                  │
     │              ▲                                          │
     │  1:many      │                                          │
     └──────────────┘                                          │
```

### Models

**ReferralCode** — One per user. Stores the shareable code and reward configuration.

| Field                 | Type    | Description                          |
| --------------------- | ------- | ------------------------------------ |
| `id`                  | String  | Primary key (cuid)                   |
| `userId`              | String  | Owner (unique — one code per user)   |
| `code`                | String  | Auto-generated code (unique)         |
| `customCode`          | String? | Vanity code set by user (unique)     |
| `referrerReward`      | Int?    | Reward for referrer in paise         |
| `refereeReward`       | Int?    | Reward for referee in paise          |
| `totalReferrals`      | Int     | Total signups via this code          |
| `successfulReferrals` | Int     | Referrals that reached REWARDED      |
| `totalEarned`         | Int     | Cumulative referrer rewards in paise |
| `isActive`            | Boolean | Can be deactivated by admin          |

**Referral** — Created when a new user signs up via a referral link.

| Field                  | Type           | Description                                            |
| ---------------------- | -------------- | ------------------------------------------------------ |
| `id`                   | String         | Primary key (cuid)                                     |
| `referralCodeId`       | String         | FK to ReferralCode                                     |
| `referredUserId`       | String         | The new user (unique — user can only be referred once) |
| `status`               | ReferralStatus | Lifecycle state                                        |
| `referrerRewardAmount` | Int?           | Reward paid to referrer (paise)                        |
| `refereeRewardAmount`  | Int?           | Reward given to referee (paise)                        |
| `signedUpAt`           | DateTime       | When the referred user signed up                       |
| `qualifiedAt`          | DateTime?      | When qualifying action occurred                        |
| `qualifyingAction`     | String?        | e.g. `"first_paid_booking"`                            |

**ReferralCredit** — A credit entry in the user's wallet.

| Field             | Type         | Description                        |
| ----------------- | ------------ | ---------------------------------- |
| `id`              | String       | Primary key (cuid)                 |
| `userId`          | String       | Credit owner                       |
| `amount`          | Int          | Original credit amount (paise)     |
| `currency`        | String       | Default `"INR"`                    |
| `source`          | CreditSource | How this credit was earned         |
| `referralId`      | String?      | Optional link to specific referral |
| `usedAmount`      | Int          | How much has been consumed         |
| `remainingAmount` | Int          | `amount - usedAmount`              |
| `expiresAt`       | DateTime?    | When this credit expires           |
| `usedAt`          | DateTime?    | When fully consumed                |
| `usedOnPaymentId` | String?      | Reserved for future use            |

### Enums

```
ReferralStatus:
  SIGNED_UP   — User signed up but hasn't made a paid booking yet
  QUALIFIED   — User made first paid booking within 30 days
  REWARDED    — Referrer has received their credit reward
  EXPIRED     — 30-day qualification window elapsed
  FRAUDULENT  — Flagged by admin (reserved, not auto-triggered)

CreditSource:
  REFERRAL_BONUS  — Earned by referring someone who qualified
  REFEREE_BONUS   — Given to new user upon signup via referral
  PROMOTION       — Platform promotional campaign
  COMPENSATION    — Customer support compensation
  MANUAL          — Added manually by admin/staff
```

---

## Reward Amounts

All amounts are stored in **paise** (smallest INR unit: 100 paise = 1 INR).

| Reward                | Amount (paise) | Amount (INR) |
| --------------------- | -------------- | ------------ |
| Referrer bonus        | 50,000         | 500          |
| Referee welcome bonus | 20,000         | 200          |

These defaults are defined as constants in `lib/referrals/service.ts`:

```typescript
const DEFAULT_REFERRER_REWARD = 50000; // ₹500
const DEFAULT_REFEREE_REWARD = 20000; // ₹200
const QUALIFICATION_WINDOW_DAYS = 30;
const CREDIT_EXPIRY_MONTHS = 6;
```

---

## File Map

| File                                              | Purpose                                       |
| ------------------------------------------------- | --------------------------------------------- |
| `lib/referrals/service.ts`                        | Core business logic (all referral operations) |
| `app/api/referrals/code/route.ts`                 | GET/POST user's referral code                 |
| `app/api/referrals/code/customize/route.ts`       | POST set vanity code                          |
| `app/api/referrals/code/check/[code]/route.ts`    | GET validate code (public)                    |
| `app/api/referrals/route.ts`                      | GET list user's referrals                     |
| `app/api/referrals/apply/route.ts`                | POST apply code to new user                   |
| `app/api/referrals/credits/route.ts`              | GET credit balance + history                  |
| `app/api/referrals/credits/available/route.ts`    | GET available balance (lightweight)           |
| `app/r/[code]/page.tsx`                           | Referral landing page (redirect)              |
| `app/dashboard/consultant/.../referrals/page.tsx` | Consultant referral dashboard                 |
| `app/dashboard/consultee/.../referrals/page.tsx`  | Consultee referral dashboard                  |
| `scripts/referrals/expire-referrals.ts`           | Cron: expire stale referrals                  |
| `scripts/referrals/expire-credits.ts`             | Cron: expire old credits                      |
| `prisma/seedFiles/14a-create-referral-codes.ts`   | Seed data                                     |

---

## Related Docs

- [01 — Architecture & Flows](./01-architecture.md)
- [02 — API Reference](./02-api-reference.md)
- [03 — Credit System](./03-credit-system.md)
