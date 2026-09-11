# Recurring Events Journey: Subscriptions & Classes

> Complete end-to-end lifecycle of recurring appointments from plan creation through final payout. Read this if you need to understand how subscriptions and classes differ from one-time events (consultations/webinars), how slot allocation works for multi-session programs, and how the payout system interacts with session delivery.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Consultant Creates a Plan](#2-consultant-creates-a-plan)
3. [Consultee Discovers & Purchases](#3-consultee-discovers--purchases)
4. [Slot Allocation](#4-slot-allocation)
5. [Sessions & Meetings](#5-sessions--meetings)
6. [Payout Lifecycle](#6-payout-lifecycle)
7. [Collaborators](#7-collaborators)
8. [Cancellation & Refunds](#8-cancellation--refunds)
9. [Cron Jobs & Automation](#9-cron-jobs--automation)
10. [Key Differences: Subscription vs Class](#10-key-differences-subscription-vs-class)
11. [Cross-References](#11-cross-references)

---

## 1. Overview

Recurring events are multi-session programs that span days, weeks, or months. The platform supports two recurring event types:

| Aspect | **Subscription** | **Class** |
|--------|------------------|-----------|
| Relationship | 1:1 (one consultant, one consultee) | 1:many (one consultant + collaborators, many consultees) |
| Duration | `durationInMonths` (1-24) | `durationInMonths` (1+) |
| Sessions/week | `sessionsPerWeek` (0-7) | `sessionsPerWeek` (1+) |
| Session duration | `sessionDurationInHours` (0.5-4) | `sessionDurationInHours` (0.5-4) |
| Total sessions | `sessionsPerWeek x weeks x months` | `sessionsPerWeek x weeks x months` |
| Capacity | Always 1 consultee | `maxParticipants` (configurable) |
| Trial | Yes (30 or 60 min) | No |
| Collaborators | No | Yes (co-instructors, TAs, guest lecturers) |
| Certificates | No | Optional |
| Recording | No | Optional (Stream S3 or Supabase permanent) |

Both share the same core flow: **Plan Creation -> Checkout -> Payment -> Slot Allocation -> Sessions -> Payout**.

---

## 2. Consultant Creates a Plan

### 2a. Subscription Plan

**UI Component:** `app/dashboard/consultant/[consultantId]/(features)/planner/components/EventPlannerForSubscription.tsx`
**Service:** `app/dashboard/consultant/[consultantId]/(features)/planner/services/plans/subscription-service.ts`
**API:** `POST /api/plans/subscriptions` (`app/api/plans/subscriptions/route.ts`)
**Schema validation:** `SubscriptionPlanSchema` in `schemas/plans.ts`

**What the consultant fills in:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Plan name (uniqueness checked via `checkDuplicateTitle()`) |
| `description` | Text | Plan description |
| `price` | Int (paise) | Total subscription price (e.g., 50000 = Rs 500) |
| `durationInMonths` | Int (1-24) | How many months the subscription runs |
| `sessionsPerWeek` | Int (0-7) | How many sessions per week |
| `sessionDurationInHours` | Float (0.5-4) | Duration of each individual session |
| `trialEnabled` | Boolean | Whether to offer a trial first |
| `trialDurationMinutes` | 30 or 60 | Trial session length |
| `trialPriceInPaise` | Int (paise) | Trial price (0 = free, the default until paid-trial checkout ships) |
| `subscriptionContents[]` | Array | Session-by-session curriculum (title, description, order) |
| `topics[]` | Array | Topic tags for discoverability |
| `learningOutcomes[]` | Array | What the consultee will learn |
| `language`, `level`, `prerequisites`, `materialProvided` | Strings | Metadata |

**What happens server-side:**
1. Validates input with Zod schema
2. Finds or creates `Topic` records
3. Calculates `totalSessions` using `SlotCalculationService.countWeeks()`:
   - `totalSessions = sessionsPerWeek x countWeeks(schedulingStart, schedulingEnd)`
   - Where `countWeeks()` counts Sunday-start weeks in the date range
4. Calculates `totalHours = totalSessions x sessionDurationInHours`
5. Creates `SubscriptionPlan` record with `SubscriptionContent[]` (curriculum)
6. Returns the created plan

### 2b. Class Plan

**UI Component:** `app/dashboard/consultant/[consultantId]/(features)/planner/components/EventPlannerForClass.tsx`
**Service:** `app/dashboard/consultant/[consultantId]/(features)/planner/services/events/class-service.ts`
**API:** `POST /api/plans/classes` (`app/api/plans/classes/route.ts`)
**Schema validation:** `ClassPlanSchema` in `schemas/plans.ts`

**Additional class-specific fields:**

| Field | Type | Description |
|-------|------|-------------|
| `maxParticipants` | Int | Capacity limit for enrollment |
| `sessionsPerWeek` | Int | Sessions per week (replaces `sessionsPerWeek`) |
| `recordingEnabled` | Boolean | Whether sessions are recorded |
| `recordingStoragePolicy` | Enum | `STREAM_ONLY` (2-week temp) or `SUPABASE_PERMANENT` |
| `certificateProvided` | Boolean | Whether completers get a certificate |
| `classContents[]` | Array | Ordered curriculum items (title, description, hoursAllotted) |
| `collaborators` | Via UI | Co-instructors invited through CollaboratorsTab |

**Key difference from subscription:** Class plans support co-instructors — `Collaborator[]` rows carrying `collaboratorType: CLASS`, whose revenue shares are stored as integer basis points in `revenueShareBps` (#784 merged the old `ClassCollaborator` and `WebinarCollaborator` models into one `Collaborator`; #772 B5 moved the share off a float percentage) — and the capacity system via `maxParticipants`.

---

## 3. Consultee Discovers & Purchases

### 3a. Discovery

Consultees find plans through:
- **Explore pages:** Browse consultants and their plans
- **Plan detail pages:** e.g., `app/explore/programs/plans/classes/[classPlanId]/page.tsx`
- **Direct links:** Shared by consultants

### 3b. Checkout Flow

**Checkout pages:**
- Subscription: `app/checkout/plans/subscription/[planId]/page.tsx`
- Class: `app/checkout/plans/class/[planId]/page.tsx`

**What the consultee sees:**
- Plan details (title, description, curriculum, duration)
- Consultant profile and reviews
- Price with optional discount code
- Referral credit balance (if any)
- Payment gateway selection (Razorpay for India, Stripe for international)

**API call:** `POST /api/checkout` (`app/api/checkout/route.ts`)

**Checkout request includes:**
- `planId` (required)
- `paymentGateway` (required)
- `schedulingPeriodStartsAt` / `schedulingPeriodEndsAt` (for subscriptions)
- `discountCode` (optional)
- `referralCreditAmount` (optional)

### 3c. Payment Processing

**Handler:** `lib/payments/operations/checkout.ts` -> `handleCheckout()`

**Sequence:**

```
Consultee clicks "Pay"
    |
    v
POST /api/checkout
    |-- Validate input (Zod)
    |-- Authenticate user
    |-- Resolve tax context (buyer country)
    |-- Auto-route to optimal gateway (Razorpay domestic, Stripe international)
    |
    v
handleCheckout()
    |-- Create Payment record (status: PENDING)
    |-- For Subscription:
    |   |-- Create Subscription record (status: PENDING)
    |   |-- Create placeholder Appointment (appointmentType: SUBSCRIPTION)
    |   |-- Store schedulingPeriod dates
    |-- For Class:
    |   |-- Create Appointment linked to Class (appointmentType: CLASS)
    |   |-- Enroll consultee (connect to appointment)
    |-- Create payment intent with gateway
    |-- Return payment URL/link to frontend
    |
    v
Consultee completes payment on Razorpay/Stripe
    |
    v
Gateway sends webhook -> POST /api/checkout/verify (or /api/webhooks/razorpay, /api/webhooks/stripe)
    |
    v
Webhook handler (lib/payments/webhooks/handlers.ts):
    |-- Verify signature
    |-- Update Payment.paymentStatus = SUCCEEDED
    |-- Call createEarningsFromPayment() -> creates ConsultantEarnings
    |-- Call createInvoiceFromPayment() -> creates Invoice with GST
    |-- Send payment success notification (Novu + email)
    |-- For Subscription: update status to APPROVED or SCHEDULED
```

**Important:** The two-phase commit pattern is used here. Appointments are created with tentative slots (`isTentative = true`) before payment confirmation. The webhook atomically confirms them. See `docs/booking/06-booking-lifecycle.md` for the full pattern explanation.

---

## 4. Slot Allocation

This is the core scheduling engine that converts a purchased plan into concrete appointment time slots.

### 4a. Architecture

```
Frontend (useSlotAllocation hook)
    |
    v
Validation: POST /api/bookings/{subscriptions|classes}/[id]/validate
    |
    v
Allocation: PATCH /api/bookings/{subscriptions|classes}/[id]/allocate
    |
    v
SlotValidationService (business rules)
    |
    v
SlotAllocationService (Prisma transaction, 60s timeout)
    |
    v
Database: Appointment + SlotOfAppointment records created
```

**Core services:**
- `utils/slotAllocation/SlotCalculationService.ts` -- Pure math, no DB. Counts weeks, calculates required slots, groups by day/week.
- `utils/slotAllocation/SlotValidationService.ts` -- Business rule validation. Checks conflicts, availability match, consecutive slots, weekly limits.
- `utils/slotAllocation/SlotAllocationService.ts` -- Main engine. Creates appointments in Prisma transactions with distributed locks.

**Frontend hook:** `app/dashboard/consultant/[consultantId]/(features)/shared/hooks/useSlotAllocation.ts`

### 4b. The Three Allocation Modes

| Mode | Trigger | How It Works |
|------|---------|-------------|
| **Auto** (`isAuto: true`) | Consultant clicks "Auto-allocate" | System searches consultant's `SlotOfAvailabilityWeekly` for first-fit consecutive blocks. Uses Redis distributed lock (`lockAutoAllocate`) to prevent concurrent allocations. Searches forward from `schedulingPeriodStartsAt`. |
| **Manual** (`slots: string[]`) | Consultant selects specific times on calendar | Consultant provides exact ISO datetime strings for each slot. Must pass all validation checks (no conflicts, within availability, within scheduling period). |
| **Requested** (`useRequestedSlots: true`) | Consultee proposed times during checkout | Uses slots pre-proposed by consultee in the booking request. Consultant approves by triggering allocation with this flag. |

### 4c. Slot Math

**Atomic unit:** 30-minute slots. There are 48 slots per day (00:00-23:30 UTC).

**For a subscription** with `sessionsPerWeek=2`, `sessionDurationInHours=1`, `durationInMonths=1`:
1. `weeks = countWeeks(startDate, endDate)` -- e.g., 4 weeks
2. `totalSessions = sessionsPerWeek x weeks = 2 x 4 = 8` sessions
3. `slotsPerSession = ceil(sessionDurationInHours / 0.5) = ceil(1 / 0.5) = 2` slots
4. `totalSlots = totalSessions x slotsPerSession = 8 x 2 = 16` thirty-minute slots

**For a class**, the math is identical but uses `sessionsPerWeek` instead of `sessionsPerWeek`, and slots are shared across all enrolled consultees.

### 4d. Availability Model

Consultants set their availability in two ways:

1. **Weekly recurring** (`SlotOfAvailabilityWeekly`):
   - `startDay/endDay`: Day of week enum (MONDAY-SUNDAY)
   - `startTimeUtc/endTimeUtc`: Minutes since midnight UTC (0-1439, stored as `Int @db.SmallInt`)
   - `utcOffsetMinutes`: Timezone offset for display
   - Can span overnight (e.g., Friday 22:00 UTC to Saturday 02:00 UTC)

2. **Custom one-off** (`SlotOfAvailabilityCustom`):
   - `startsAt/endsAt`: Full ISO timestamps
   - For special availability dates

**Timezone handling:** Dashboard sends times in user's local timezone. `utils/schedule/formatting.ts` (`formatSlotsForApi()`) converts to UTC, handling overnight and DST edge cases.

### 4e. Validation Pipeline

Before allocation, `SlotValidationService` checks:
1. All slots are in the future
2. No conflicts with existing non-tentative appointments
3. All slots fall within consultant's weekly or custom availability
4. All slots are within the subscription/class scheduling period
5. Slots are consecutive where required (per session)
6. Weekly distribution limits are respected (no more than `sessionsPerWeek` sessions in a Sunday-start week)
7. **For classes:** `maxParticipants` occupancy check via `occupancyPolicy.ts`

### 4f. What Gets Created

For a subscription with 8 sessions, 2 slots per session:

```
Subscription (id: "sub_123", status: SCHEDULED)
  |
  +-- Appointment #1 (appointmentType: SUBSCRIPTION, subscriptionId: "sub_123")
  |     +-- SlotOfAppointment (startsAt: Mon 10:00, endsAt: Mon 10:30, completionStatus: SCHEDULED)
  |     +-- SlotOfAppointment (startsAt: Mon 10:30, endsAt: Mon 11:00, completionStatus: SCHEDULED)
  |
  +-- Appointment #2
  |     +-- SlotOfAppointment (Wed 14:00 - 14:30)
  |     +-- SlotOfAppointment (Wed 14:30 - 15:00)
  |
  ... (8 appointments total, each with 2 slots)
```

For a class, the same appointment structure is created during allocation (1 appointment per session). When new consultees enroll via checkout, `handleClassCheckout()` links them to ALL existing `SlotOfAppointment` records via the M2M `user` relation -- no new Appointments are created per enrollee. All participants (consultant + all consultees) share the same slots.

---

## 5. Sessions & Meetings

### 5a. Before the Session

- Both consultant and consultee see upcoming sessions on their dashboard calendars
- Appointment reminders sent via Novu (email/push) at configured intervals (cron: `appointment-reminders`, every 6h)
- Stream.io chat channel created for communication between sessions

### 5b. During the Session

- Consultant starts the session -> Stream.io video call via `MeetingSession` with `streamCallId`
- Both parties join via `app/meetings/` pages
- **For classes:** All enrolled consultees + collaborators join the same call
- **Recording:** If `recordingEnabled = true` on the plan, consultant can start/stop recording
  - Stored on Stream S3 (2-week temporary)
  - If `recordingStoragePolicy = SUPABASE_PERMANENT`, auto-transferred to Supabase by cron before Stream expiry

### 5c. After the Session

**Completion tracking** (`SlotOfAppointment.completionStatus`):

| Status | Meaning |
|--------|---------|
| `SCHEDULED` | Future session, not yet held |
| `COMPLETED` | Session held -- `MeetingSession` record exists OR manually marked |
| `UNVERIFIED` | Past the end time but no `MeetingSession` record (possible offline session) |
| `CANCELLED` | Explicitly cancelled |
| `RESCHEDULED` | Replaced via reallocation |

**Auto-complete cron** (`scripts/appointments/auto-complete-appointments.ts`, runs hourly):
- Finds slots where `endsAt < now()` and `completionStatus = SCHEDULED`
- If `MeetingSession` exists for that appointment -> mark `COMPLETED`
- If no `MeetingSession` -> mark `UNVERIFIED`

---

## 6. Payout Lifecycle

### 6a. Current Implementation

**Earnings creation:** When payment succeeds (webhook), `createEarningsFromPayment()` in `lib/payments/payouts/earnings-service.ts` creates a `ConsultantEarnings` record:
- `grossAmount`: Full payment amount (in paise)
- `platformFee`: `grossAmount x 20%` (from `PAYOUT_CONSTANTS.PLATFORM_FEE_PERCENTAGE`)
- `consultantShare`: `grossAmount - platformFee` (80%)
- `status`: PENDING
- `holdUntil`: `now() + HOLD_PERIOD_HOURS[type]`

**Hold periods** (from `lib/payments/payouts/constants.ts`):

| Event Type | Hold Period | Rationale |
|------------|-------------|-----------|
| Consultation | 24 hours | One-time, quick dispute window |
| Webinar | 48 hours | Group event, more complexity |
| Subscription | 168 hours (7 days) | Recurring, higher scam risk |
| Class | 24 hours | Group recurring, faster release |

**Earnings lifecycle:**
```
PENDING (in hold) -> READY (hold expired) -> PAID (in payout batch)
                  -> HELD (dispute opened) -> READY (dispute resolved)
                  -> REFUNDED (refund processed)
```

**Automated cron jobs:**

| Job | Schedule | What It Does |
|-----|----------|-------------|
| `release-earnings` | Hourly | PENDING -> READY when `holdUntil <= now()` |
| `create-payout-batch` | Monday 8PM UTC | Groups READY earnings by consultant, creates Payout records |
| `process-payouts` | Monday 9PM UTC | Sends APPROVED payouts to RazorpayX/Stripe Connect |

**Batch creation logic:**
1. For each consultant with READY earnings:
   - Sum `consultantShare` amounts
   - Check >= Rs 500 minimum (`MINIMUM_PAYOUT_AMOUNT`)
   - Check verified default `PayoutAccount` exists
   - Create `Payout` record (auto-approve if < Rs 5000, else needs admin approval)
   - Link all READY `ConsultantEarnings` to the payout

**Payout processing:**
1. Get or create Contact in RazorpayX
2. Get or create Fund Account (bank/UPI)
3. Calculate TDS deduction (Section 194J: 10% with PAN, 20% without, threshold Rs 50K/FY)
4. Create payout via RazorpayX API with idempotency key
5. Status: APPROVED -> PROCESSING -> COMPLETED (via webhook)

### 6b. Current Gap for Recurring Events

**The problem:** For a 3-month subscription with 12 sessions priced at Rs 6,000, the current system creates ONE earnings record for the full Rs 6,000 with a 7-day hold. The consultant gets the full amount after 7 days -- before delivering any of the 12 sessions.

**Risk:** A scammer consultant could collect payment, deliver zero sessions, and receive the full payout. The consultee's only recourse would be to file a dispute after the fact.

**Planned fix:** Milestone-based payouts (see GitHub issue). Each completed session triggers release of 1/N of the total earnings, with its own 7-day hold period.

---

## 7. Collaborators

Collaborators are additional consultants who participate in class or webinar delivery. Only applicable to classes and webinars (not subscriptions or consultations).

### 7a. Invitation Flow

**Service:** `lib/collaborators/service.ts`
**UI:** `components/collaborators/CollaboratorsTab.tsx` (embedded in class/webinar plan creation form)

1. Plan owner searches for consultant by name/email
2. Sets `role` (CO_INSTRUCTOR, TEACHING_ASSISTANT, GUEST_LECTURER, CONTENT_CREATOR)
3. Sets `revenueSharePercentage` (0-90%, validated: total shares cannot exceed 90%, owner keeps min 10%). The percentage is the API surface only; `pctToBps()` converts it to `revenueShareBps` at the database boundary, so the 90% cap is enforced as 9000 bps.
4. Invitation created with status: PENDING
5. Invitee receives Novu notification
6. Invitee responds via `InvitationsPanel` component: ACCEPT or DECLINE

**Revenue share validation:** Uses serializable Prisma transaction to prevent concurrent invitations from overshooting the 90% cap.

### 7b. Revenue Split

When payment comes in for a class with collaborators:

```
Payment Rs 1,000 for a class with:
  - Owner (60% share)
  - Co-instructor A (25% share)
  - Co-instructor B (15% share)

Step 1: Platform fee calculated ONCE on total gross
  grossAmount = Rs 1,000
  platformFee = Rs 1,000 x 20% = Rs 200
  totalConsultantPool = Rs 1,000 - Rs 200 = Rs 800

Step 2: Pool split among participants by share percentage
  Owner (60%):  consultantShare = Rs 480
  Collab A (25%): consultantShare = Rs 200
  Collab B (15%): consultantShare = Rs 120
```

Each party gets their own `ConsultantEarnings` record with `role = OWNER` or `COLLABORATOR` and `sharePercentage` set accordingly. **Important implementation detail:** only the owner's record carries the `grossAmount` and `platformFee` values; collaborator records have `grossAmount = 0` and `platformFee = 0`, with only `consultantShare` populated (see `earnings-service.ts:124-125`).

### 7c. Access & Permissions

- ACCEPTED collaborators can access the event via `authorizeEventAccess()` (read access to plan, join meetings)
- PUT/DELETE operations remain owner-only (enforced via DB filter)
- Collaborator availability endpoint: `app/api/collaborators/[consultantProfileId]/availability/route.ts` -- relationship-scoped, includes collaborated event booked slots

---

## 8. Cancellation & Refunds

### 8a. Cancellation

See `docs/booking/08-cancellation-flow.md` for full details.

**For recurring events:**
- `Subscription.status` -> `CANCELLED` with `cancellationReason`, `cancellationNotes`, `cancelledAt`, `cancelledBy`
- `Class.status` -> `CANCELLED`
- All future `SlotOfAppointment` records -> `completionStatus: CANCELLED`
- Completed sessions remain marked as `COMPLETED`

### 8b. Refund Policy

**Current:** Full or partial refund via `Refund` model, processed through original payment gateway.

**For recurring events with milestone payouts (planned):**
- PAID milestones: Not refundable (sessions delivered)
- READY milestones: Refundable
- PENDING milestones (session completed, in hold): Refundable
- PENDING milestones (session not completed): Refundable immediately

Existing `refundedShareAmount` field on `ConsultantEarnings` tracks partial refund amounts.

---

## 9. Cron Jobs & Automation

Recurring events depend on these automated jobs:

| Job | Schedule | Purpose | Source |
|-----|----------|---------|--------|
| `auto-complete-appointments` | Hourly | Mark past sessions COMPLETED/UNVERIFIED | `scripts/appointments/auto-complete-appointments.ts` |
| `tentative-slots` | Every 2 hours | Clean up stale tentative slots (> 24 hours, `TENTATIVE_EXPIRATION_HOURS = 24`) | `app/api/cleanup/tentative-slots/` |
| `expire-stale-requests` | Daily | Mark PENDING requests as EXPIRED (> 30 days) | `app/api/cleanup/` |
| `release-earnings` | Hourly | PENDING -> READY when hold expires | `jobs/earnings/release-earnings.ts` |
| `create-payout-batch` | Weekly Mon | Collect READY earnings into batches | `jobs/payouts/create-payout-batch.ts` |
| `process-payouts` | Weekly Mon | Send approved payouts to gateways | `jobs/payouts/process-payouts.ts` |
| `appointment-reminders` | Every 6h | Send upcoming session reminders | `app/api/cleanup/appointment-reminders/` |
| `transfer-expiring-recordings` | Daily | Move Stream recordings to Supabase | `app/api/cleanup/transfer-expiring-recordings/` |
| `mark-expired-recordings` | Daily | Clean up expired Stream recordings | `app/api/cleanup/mark-expired-recordings/` |

All cron jobs are triggered via GitHub Actions workflows in `.github/workflows/` and hit API endpoints in `app/api/cleanup/` that verify a `CRON_SECRET` header.

---

## 10. Key Differences: Subscription vs Class

| Aspect | Subscription | Class |
|--------|-------------|-------|
| **Prisma models** | `SubscriptionPlan` -> `Subscription` -> `Appointment[]` | `ClassPlan` -> `Class` -> `Appointment[]` |
| **Participant count** | Always 1:1 | 1:many (up to `maxParticipants`) |
| **Appointments** | 1 Appointment per session, each has N slots | 1 Appointment per session (shared by all participants via M2M user relation on slots) |
| **Slot sharing** | Slots connected to consultant + 1 consultee | New enrollees are linked to ALL existing slots of ALL appointments (`handleClassCheckout` line 1510-1524) |
| **Collaborators** | Not supported | `Collaborator[]` (`collaboratorType: CLASS`) with `revenueShareBps` shares |
| **Trial** | Yes (`TrialSession` model) | No |
| **Recording** | No | Optional |
| **Certificate** | No | Optional |
| **Capacity** | No (1:1) | Yes (per-instance `maxParticipants`; full means sold out) |
| **Curriculum model** | `SubscriptionContent` (session-by-session) | `ClassContent` (ordered, with `hoursAllotted`) |
| **Scheduling field** | `sessionsPerWeek` | `sessionsPerWeek` |
| **Request model** | `Subscription.status` (PENDING -> APPROVED -> SCHEDULED) | `Class.status` (SCHEDULED -> IN_PROGRESS -> COMPLETED) |
| **Hold period** | 168h (7 days) | 24h |

---

## 11. Cross-References

| Topic | Document |
|-------|----------|
| Full booking lifecycle (all event types) | `docs/booking/06-booking-lifecycle.md` |
| Slot math and calculations | `docs/booking/03-slot-math-and-calculations.md` |
| API reference for allocation/validation | `docs/booking/04-api-reference.md` |
| Concurrency and distributed locking | `docs/booking/12-concurrency-and-locking.md` |
| Checkout and payment integration | `docs/booking/10-checkout-payment-integration.md` |
| Cancellation flow | `docs/booking/08-cancellation-flow.md` |
| Trial sessions (subscription-only) | `docs/booking/09-trial-sessions.md` |
| Event capacity (class/webinar-only) | `docs/booking/02-event-types-and-validation.md` |
| Payout architecture | `docs/payments/payouts/01-architecture.md` |
| Earnings lifecycle | `docs/payments/payouts/02-earnings-lifecycle.md` |
| Revenue distribution models | `docs/finances/02-revenue-distribution.md` |
| Collaborator revenue sharing | `docs/collaborators/03-revenue-sharing.md` |
| Cron jobs overview | `docs/booking/13-cron-jobs-and-background-tasks.md` |
