# Referral System — Architecture & Flows

This document walks through the referral system end to end: from how a referral code is generated, to how a new user signs up through it, to how rewards are earned and spent. Each section builds on the previous one to tell the full story of a referral's lifecycle.

---

## Table of Contents

1. [The Big Picture](#1-the-big-picture)
2. [Referral Code Generation](#2-referral-code-generation)
3. [The Signup Journey](#3-the-signup-journey)
4. [Qualification and Rewards](#4-qualification-and-rewards)
5. [Spending Credits at Checkout](#5-spending-credits-at-checkout)
6. [Expiration and Cleanup](#6-expiration-and-cleanup)
7. [Custom Vanity Codes](#7-custom-vanity-codes)
8. [The Complete Lifecycle](#8-the-complete-lifecycle)

---

## 1. The Big Picture

The referral system creates a viral growth loop. Every existing user becomes a potential ambassador for the platform. The mechanics are straightforward: share a link, earn credits when your referral pays for something. But the implementation has several moving parts that need to work together cleanly.

Here's the high-level flow that every referral follows:

```
  User A (existing)                                    User B (new)
       │                                                    │
       │  1. Generates referral link                        │
       │     familiarise.com/r/kaustav3x7                   │
       │                                                    │
       │  2. Shares via social media,                       │
       │     email, or direct message                       │
       │─────────────────────────────────────────────────>│
       │                                                    │
       │                                    3. Clicks link  │
       │                                    4. Signs up     │
       │                                    5. Gets ₹200    │
       │                                       credit       │
       │                                                    │
       │                                    6. Makes first  │
       │                                       paid booking │
       │                                       (within 30d) │
       │                                                    │
       │  7. Earns ₹500 credit  <───────────────────────────│
       │                                                    │
       │  8. Both use credits                               │
       │     at future checkouts                            │
```

The system involves three database models (`ReferralCode`, `Referral`, `ReferralCredit`), seven API endpoints, two cron jobs, and integration points in the signup page and payment webhook. Let's walk through each stage.

---

## 2. Referral Code Generation

Every journey starts with a code. When a user visits their referral dashboard and clicks "Get Referral Link," the system either returns their existing code or generates a new one.

### How codes are generated

The algorithm tries to create a human-readable code based on the user's name, falling back to a random string if there's a collision:

```
Step 1:  Take the user's name         →  "Kaustav Ghosh"
Step 2:  Lowercase, strip non-alpha   →  "kaustavghosh"
Step 3:  Take first 8 characters      →  "kaustavg"
Step 4:  Append 4 random alphanumeric →  "kaustavga3x7"
Step 5:  Try inserting into database
         ├─ Success → done
         └─ Unique constraint fails → generate fallback: "ref" + 9 random chars
```

This approach gives most users a recognizable, memorable code while guaranteeing uniqueness through the database constraint. The code is stored in the `ReferralCode` model, which has `@unique` on the `code` field.

### What happens under the hood

```
User                  Frontend              POST /api/referrals/code         Service
 │                       │                          │                          │
 │  Click "Get Link"     │                          │                          │
 │──────────────────────>│                          │                          │
 │                       │  POST (empty body)       │                          │
 │                       │─────────────────────────>│                          │
 │                       │                          │                          │
 │                       │                          │  1. Look up existing     │
 │                       │                          │     code for this user   │
 │                       │                          │                          │
 │                       │                          │  [Found] → return it     │
 │                       │                          │                          │
 │                       │                          │  [Not found] →           │
 │                       │                          │  2. Generate name-based  │
 │                       │                          │     code                 │
 │                       │                          │  3. Insert with default  │
 │                       │                          │     reward config        │
 │                       │                          │     (₹500 / ₹200)       │
 │                       │                          │  4. Return new code      │
 │                       │                          │                          │
 │                       │  { code, customCode }    │                          │
 │                       │<─────────────────────────│                          │
 │                       │                          │                          │
 │  Display:             │                          │                          │
 │  familiarise.com      │                          │                          │
 │  /r/kaustavga3x7      │                          │                          │
 │<──────────────────────│                          │                          │
```

The `POST` endpoint is idempotent — calling it repeatedly for the same user always returns the same code. This is important because the dashboard fetches the code on every page load via a `useQuery` hook, and we don't want to create duplicates.

The `ReferralCode` record also stores running statistics (`totalReferrals`, `successfulReferrals`, `totalEarned`) that are incremented as referrals progress through their lifecycle. These power the stats cards on the dashboard.

---

## 3. The Signup Journey

This is where the referral link does its work. A new user clicks the link, arrives at the platform, signs up, and gets their welcome bonus.

### Step by step

The flow has three distinct phases: landing, signup, and application.

**Phase 1 — Landing (`/r/[code]`)**: This is a server-rendered Next.js page. When a user visits `familiarise.com/r/kaustavga3x7`, the server calls `validateReferralCode()` from the referral service. If the code is valid and active, the user is redirected to `/auth/signup?ref=kaustavga3x7`. If invalid, they're redirected to `/auth/signup` without the `ref` parameter. This is a pure redirect — no UI is shown on the `/r/` page itself.

**Phase 2 — Signup page**: The signup page reads the `?ref=` query parameter. If present, it makes a `GET /api/referrals/code/check/{code}` call (which is a public, unauthenticated endpoint) to fetch the referrer's name and the referee reward amount. This powers the banner that says "Referred by Kaustav Ghosh — You'll get ₹200 bonus!" The page also has an optional text input where users can manually enter a referral code if they didn't use a link.

**Phase 3 — Application**: After the user successfully creates their account (through BetterAuth), the frontend calls `POST /api/referrals/apply` with the code. This is where the actual referral record is created.

```
                         /r/kaustavga3x7
                               │
                               ▼
                    ┌────────────────────────┐
                    │  Validate code          │
                    │  (server-side)          │
                    └──────────┬─────────────┘
                               │
                   ┌───────────┴───────────┐
                   │ Valid                  │ Invalid
                   ▼                       ▼
         ┌──────────────────┐    ┌──────────────────┐
         │ redirect 302     │    │ redirect 302     │
         │ /auth/signup     │    │ /auth/signup     │
         │ ?ref=CODE        │    │ (no ref param)   │
         └────────┬─────────┘    └──────────────────┘
                  │
                  ▼
         ┌──────────────────────────────────────┐
         │  Signup page shows:                   │
         │  "Referred by Kaustav Ghosh"          │
         │  "You'll receive ₹200 bonus"          │
         │                                       │
         │  User fills in name, email, password   │
         │  → Creates account via BetterAuth      │
         └────────┬─────────────────────────────┘
                  │
                  ▼
         ┌──────────────────────────────────────┐
         │  POST /api/referrals/apply            │
         │  { code: "kaustavga3x7" }             │
         │                                       │
         │  Service: applyReferralCode()          │
         │                                       │
         │  Validations:                          │
         │  ✓ Code exists and is active           │
         │  ✓ User is not self-referring          │
         │  ✓ User hasn't been referred before    │
         │                                       │
         │  On success:                           │
         │  1. Create Referral (SIGNED_UP)        │
         │  2. Create ReferralCredit (₹200)       │
         │     for the new user                   │
         │  3. Increment totalReferrals on code   │
         └──────────────────────────────────────┘
```

### Why the "apply" step is separate from signup

The referral application happens in a separate API call after account creation — not during signup itself. This is intentional:

1. **Auth-first**: The `/api/referrals/apply` endpoint requires authentication. The user must have a valid session before we create referral records linked to their user ID.
2. **Decoupling**: If the referral system has a bug, it shouldn't block account creation. Signup succeeds independently.
3. **Manual entry**: Users who arrive without a link but know a code can enter it manually on the signup page. The same POST endpoint handles both cases.

### The `referredUserId @unique` constraint

A user can only be referred once. The `Referral` model has `referredUserId String @unique`, which means if someone tries to apply a second referral code, the database rejects it. The API returns a friendly "You have already been referred" error.

---

## 4. Qualification and Rewards

At this point, User B has signed up and received their ₹200 welcome bonus. But User A (the referrer) hasn't earned anything yet. The referral is in `SIGNED_UP` status — a holding state that means "this person signed up, but we're not sure they're a real, engaged user yet."

### What triggers qualification

The qualifying action is the user's **first successful payment** on the platform. This could be booking a consultation, subscribing to a mentorship program, purchasing a webinar ticket, or enrolling in a class. The trigger point is in the payment webhook handler.

When a payment succeeds, `handlePaymentSuccess()` in `lib/payments/webhooks/handlers.ts` calls:

```typescript
processQualifyingAction(userId, "first_paid_booking");
```

This function is the heart of the reward logic. Here's what it does:

```
processQualifyingAction(userId, action)
        │
        ▼
  Find Referral WHERE
    referredUserId = userId
    AND status = "SIGNED_UP"
        │
        ├── Not found → return (user wasn't referred, or already qualified)
        │
        ▼
  Atomically claim the reward in ONE guarded write:
  UPDATE Referral
    WHERE status = "SIGNED_UP"
      AND signedUpAt >= (now - 30 days)   ← window folded into the WHERE
    SET status → REWARDED ...
        │
        ├── 0 rows updated (lost the race, or past the window)
        │        │
        │        ▼
        │   If still un-rewarded SIGNED_UP AND signedUpAt < cutoff:
        │     UPDATE Referral status → EXPIRED (no rewards given)
        │
        ▼ 1 row updated (claimed within window)
  Qualify and reward:
  1. UPDATE Referral
       status → REWARDED
       qualifiedAt = now
       qualifyingAction = "first_paid_booking"
       referrerRewardAmount = 50000
       refereeRewardAmount = 20000

  2. CREATE ReferralCredit for referrer
       amount = 50000 (₹500)
       source = REFERRAL_BONUS
       expiresAt = now + 6 months

  3. UPDATE ReferralCode
       successfulReferrals += 1
       totalEarned += 50000
```

### The 30-day window

The qualification window exists to prevent gaming. Without it, someone could sign up via a referral link, never use the platform, and then make a purchase months later — giving the referrer a reward for a connection that was essentially cold. The 30-day window ensures the referral has some causal relationship to the signup.

If the window expires and the user later makes a purchase, the referral status changes to `EXPIRED` rather than `REWARDED`. The referrer gets nothing. The cron job (`scripts/referrals/expire-referrals.ts`) handles bulk expiration daily, but the `processQualifyingAction` function also handles it inline to avoid a race between the cron job and a late payment.

As of #692 (REF-3), the window check is no longer evaluated in application code separately from the status guard. Previously `processQualifyingAction` compared `Date.now()` against `signedUpAt` in JavaScript and then issued a separate update to flip the status, which left a gap between the read and the write. The window condition is now folded directly into the reward `updateMany` WHERE clause as `signedUpAt >= cutoff` alongside the `status = "SIGNED_UP"` guard, so claiming the reward and deciding it is still in-window are a single atomic operation. If that guarded update affects zero rows — because a concurrent call already claimed it, or because the referral is genuinely past the window — the function only then issues the `EXPIRED` transition, and only for a referral that is still an un-rewarded `SIGNED_UP` whose `signedUpAt` is before the cutoff. Reward-versus-expire is therefore a single guarded decision that two concurrent webhooks cannot both win.

### Why the referral goes directly to REWARDED (not QUALIFIED)

The plan originally had `QUALIFIED` and `REWARDED` as separate states, but in the current implementation, qualification and reward happen atomically in the same transaction. There's no intermediate step where the referral is qualified but the reward hasn't been given yet. The `QUALIFIED` status could be used in the future if we add manual approval or delayed rewards, but for now `SIGNED_UP → REWARDED` is the happy path.

---

## 5. Spending Credits at Checkout

Both users now have credits in their wallet (User B has ₹200 from signup, User A has ₹500 from the referral reward). These credits can be spent on any service purchase.

### How the checkout page works

When a user reaches a checkout page (for any service type — consultation, subscription, webinar, or class), the frontend calls `GET /api/referrals/credits/available` to check if the user has a credit balance. This is a lightweight endpoint that returns just the total and currency:

```json
{ "data": { "totalAvailable": 70000, "currency": "INR" } }
```

If the balance is greater than zero, the checkout page shows a toggle:

```
┌─────────────────────────────────────────────┐
│  ☑ Apply referral credits                    │
│    Available: ₹700.00                        │
│    Applied: -₹500.00 (capped at order total) │
└─────────────────────────────────────────────┘
```

Credits are capped at the order total — you can't use ₹700 in credits on a ₹500 purchase.

### FIFO consumption

When the payment succeeds and credits are applied, the system uses **FIFO by expiry date** — it consumes the credits that expire soonest first. This minimizes the chance of credits expiring unused.

Here's a worked example. Suppose User A has accumulated three credits from different sources:

```
┌────────────────────────────────────────────────────────┐
│ Credit A:  ₹200  remaining, expires June 15, 2026      │  ← consumed first
│ Credit B:  ₹500  remaining, expires August 1, 2026     │  ← consumed second
│ Credit C:  ₹100  remaining, never expires              │  ← consumed last
└────────────────────────────────────────────────────────┘
```

User A wants to apply ₹400 at checkout:

**Iteration 1**: Consume Credit A completely (₹200). Remaining to apply: ₹200. Credit A is now fully used (`usedAt` is set).

**Iteration 2**: Consume ₹200 from Credit B (which has ₹500). Remaining to apply: ₹0. Credit B now has ₹300 remaining.

**Result**: ₹400 applied. Credit A depleted. Credit B partially used. Credit C untouched.

The function `applyCreditsToPayment()` in `lib/referrals/service.ts` implements this as a sequential loop over credits ordered by `expiresAt ASC` (nulls last, since credits with no expiry should be consumed last).

---

## 6. Expiration and Cleanup

Two daily cron jobs handle the referral system's cleanup needs.

### Referral expiration

**Script**: `scripts/referrals/expire-referrals.ts`

This job finds all referrals that are still in `SIGNED_UP` status (meaning the referred user never made a payment) where the signup happened more than 30 days ago, and sets their status to `EXPIRED`.

```sql
-- Conceptually:
UPDATE "Referral"
SET status = 'EXPIRED', "updatedAt" = NOW()
WHERE status = 'SIGNED_UP'
  AND "signedUpAt" < NOW() - INTERVAL '30 days'
```

This is a cleanup operation — it doesn't affect rewards (those were already handled or skipped by `processQualifyingAction`). It just ensures the referral dashboard shows accurate statuses.

### Credit expiration

**Script**: `scripts/referrals/expire-credits.ts`

This job finds all credits with `remainingAmount > 0` that have passed their `expiresAt` date, and sets `remainingAmount` to 0.

```sql
-- Conceptually:
UPDATE "ReferralCredit"
SET "remainingAmount" = 0
WHERE "remainingAmount" > 0
  AND "expiresAt" IS NOT NULL
  AND "expiresAt" < NOW()
```

Expired credits are effectively "zeroed out" — they still exist in the database for historical purposes (the user can see them in their credit history), but they can't be used at checkout.

Both jobs should be scheduled to run daily via a task scheduler (e.g., Vercel Cron, GitHub Actions, or a simple crontab).

---

## 7. Custom Vanity Codes

Users can optionally set a vanity code (e.g., `kaustav` instead of `kaustavga3x7`). This makes referral links more memorable and professional-looking.

### How it works

The `POST /api/referrals/code/customize` endpoint accepts a `customCode` string with these rules:

- 3-20 characters long
- Alphanumeric only (a-z, 0-9), lowercased before storage
- Must not collide with any existing `code` or `customCode` in the database

The vanity code is stored in the `customCode` field on `ReferralCode`. The original auto-generated `code` is preserved — both work as referral links. The validation endpoint (`GET /api/referrals/code/check/[code]`) checks both columns.

On the dashboard, the consultant's referral page has a "Set Custom Code" input field. Consultees don't have this feature (a deliberate simplification for MVP).

---

## 8. The Complete Lifecycle

Putting it all together, here's the full journey of a referral from creation to completion:

```
 DAY 0                     DAY 0                        DAY 5                     DAY 5+
 ─────                     ─────                        ─────                     ─────

 User A generates          User B clicks link           User B books a            Credits used
 referral code             and signs up                 consultation              at checkout

 ┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐      ┌──────────────┐
 │ ReferralCode │         │ Referral created │         │ Payment webhook  │      │ FIFO credit  │
 │ created      │─────>│ status: SIGNED_UP│─────>│ fires              │─────>│ consumption  │
 │              │         │                  │         │                  │      │              │
 │ code:        │         │ Credit created   │         │ processQualify   │      │ Credits      │
 │ kaustavga3x7 │         │ for User B (₹200)│         │ Action()         │      │ applied to   │
 └──────────────┘         └──────────────────┘         │                  │      │ payment      │
                                                        │ Referral status  │      │              │
                                                        │ → REWARDED       │      │ Remaining    │
                                                        │                  │      │ balance      │
                                                        │ Credit created   │      │ decremented  │
                                                        │ for User A (₹500)│      └──────────────┘
                                                        └──────────────────┘


 DAY 180+ (if unused)
 ─────────────────────

 ┌──────────────────┐
 │ Cron job runs    │
 │                  │
 │ Expired credits: │
 │ remaining → 0    │
 │                  │
 │ Expired referrals│
 │ status → EXPIRED │
 └──────────────────┘
```

### The unhappy paths

Not every referral ends in a reward. Here are the alternative outcomes:

**User B never pays (30 days elapse)**: The referral stays in `SIGNED_UP` until the daily cron job sets it to `EXPIRED`. User A earns nothing. User B still has their ₹200 welcome credit (it expires independently after 6 months).

**User B pays on day 35**: When `processQualifyingAction` runs, it sees the referral is past the 30-day window and sets it to `EXPIRED` inline. No reward for User A.

**User B was already referred by someone else**: The `referredUserId @unique` constraint prevents a second referral. The `/api/referrals/apply` endpoint returns "You have already been referred."

**User A tries to refer themselves**: The service checks `referralCode.userId !== newUserId` and returns "You cannot refer yourself."

**Referral code is deactivated by admin**: The `isActive` flag on `ReferralCode` is checked during validation. Deactivated codes return `{ valid: false }` from the check endpoint, and the `/r/[code]` page redirects to plain signup.
