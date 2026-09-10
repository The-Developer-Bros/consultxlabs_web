# Trial Sessions

## Overview

A trial session is a one-time session that lets a consultee try a consultant's subscription plan before committing to a paid subscription. Trials are tied to a `SubscriptionPlan` that has `trialEnabled: true`, and each consultee-consultant pair is limited to exactly one trial (enforced by a unique constraint).

Key characteristics:

- Priced per plan via `trialPriceInPaise` (free by default until paid-trial checkout is wired, after which the default flips to ₹100; the consultant can always set it to ₹0 for a genuinely free trial)
- A platform-wide minimum sits under every plan's trial price: admin or staff set `PlatformPricingConfig.minTrialPriceInPaise` via `PATCH /api/admin/trial-pricing`, and the plan create/update routes reject prices below it. The floor defaults to 0, which keeps free trials allowed.
- Booking a trial whose price is above 0 is rejected with a "Paid trials are not yet available" error until the payment wiring ships. The schema is already shaped for it: `TrialSession.pendingPaymentUrl` carries the checkout hand-off and `TrialSession.paymentId` links the settled `Payment`.
- Duration configured per plan via `trialDurationMinutes` (default 30 min)
- Consultant must approve and schedule the session
- Successful trials can convert into a full subscription

**Source files:**

- Model: `prisma/schema.prisma` (TrialSession, TrialSessionStatus)
- API: `app/api/trials/route.ts`, `app/api/trials/[trialId]/route.ts`, `app/api/trials/check-eligibility/route.ts`
- Locking: `utils/appointmentlock.ts` (lockSlotBooking, unlockSlotBooking — the shared slot-interval lock)
- Auto-completion: `scripts/appointments/auto-complete-appointments.ts`
- Notifications: `lib/novu/workflows.ts`

---

## Data Model

### TrialSession

| Field                       | Type                 | Default   | Description                                      |
| --------------------------- | -------------------- | --------- | ------------------------------------------------ |
| `id`                        | `String` (cuid)      | auto      | Primary key                                      |
| `status`                    | `TrialSessionStatus` | `PENDING` | Current lifecycle status                         |
| `notes`                     | `String?` (Text)     | null      | Consultee's questions or goals for the trial     |
| `consulteeProfileId`        | `String`             | required  | FK to ConsulteeProfile                           |
| `consultantProfileId`       | `String`             | required  | FK to ConsultantProfile                          |
| `subscriptionPlanId`        | `String`             | required  | FK to SubscriptionPlan (must have trial enabled) |
| `appointmentId`             | `String?` (unique)   | null      | FK to Appointment (set when SCHEDULED)           |
| `convertedToSubscriptionId` | `String?` (unique)   | null      | FK to Subscription (set when CONVERTED)          |
| `requestedAt`               | `DateTime`           | `now()`   | When the trial was requested                     |
| `completedAt`               | `DateTime?`          | null      | When the session was completed                   |
| `createdAt`                 | `DateTime`           | `now()`   | Record creation timestamp                        |
| `updatedAt`                 | `DateTime`           | auto      | Last update timestamp                            |

### Constraints

| Constraint                                            | Type   | Purpose                                   |
| ----------------------------------------------------- | ------ | ----------------------------------------- |
| `@@unique([consulteeProfileId, consultantProfileId])` | Unique | One trial per consultee-consultant pair   |
| `appointmentId @unique`                               | Unique | One-to-one relationship with Appointment  |
| `convertedToSubscriptionId @unique`                   | Unique | One-to-one relationship with Subscription |

### Indexes

| Index                 | Purpose                     |
| --------------------- | --------------------------- |
| `consultantProfileId` | Filter trials by consultant |
| `subscriptionPlanId`  | Filter trials by plan       |

### TrialSessionStatus Enum

| Value       | Description                           |
| ----------- | ------------------------------------- |
| `PENDING`   | Requested, awaiting consultant action |
| `SCHEDULED` | Time slot confirmed                   |
| `COMPLETED` | Trial session finished                |
| `CONVERTED` | Consultee subscribed after trial      |
| `CANCELLED` | Cancelled by consultee                |
| `REJECTED`  | Declined by consultant                |

---

## Status Lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING : Consultee requests trial
    PENDING --> SCHEDULED : Consultant approves & picks slot
    PENDING --> REJECTED : Consultant declines
    PENDING --> CANCELLED : Consultee cancels
    SCHEDULED --> COMPLETED : Session ends (auto or manual)
    SCHEDULED --> CANCELLED : Consultee cancels
    COMPLETED --> CONVERTED : Consultee subscribes
    REJECTED --> [*]
    CANCELLED --> [*]
    CONVERTED --> [*]
```

Valid transitions (enforced in `app/api/trials/[trialId]/route.ts`):

| From        | Allowed targets                      |
| ----------- | ------------------------------------ |
| `PENDING`   | `SCHEDULED`, `CANCELLED`, `REJECTED` |
| `SCHEDULED` | `COMPLETED`, `CANCELLED`             |
| `COMPLETED` | `CONVERTED`                          |
| `CONVERTED` | (terminal)                           |
| `CANCELLED` | (terminal)                           |
| `REJECTED`  | (terminal)                           |

### Cancellation Behavior (PATCH CANCELLED and DELETE)

Both `PATCH` (with `status: CANCELLED`) and `DELETE` now exhibit identical cleanup behavior:

- **Appointment/slot cleanup**: If the trial has a linked appointment, the associated `SlotOfAppointment` records and the `Appointment` record are deleted inside a transaction.
- **Notifications**: Both paths send cancellation notifications to both parties via Novu (`trial-session-cancelled`).
- **Transaction wrapping**: All database operations (status update, appointment deletion, slot deletion) are wrapped in a Prisma `$transaction` to ensure atomicity.

Previously, PATCH CANCELLED did not clean up appointments/slots, and DELETE did not send cancellation notifications. Both paths now handle both concerns.

### Conversion Handler (PATCH CONVERTED)

The `CONVERTED` transition requires a `subscriptionId` in the request body. The handler validates:

1. The subscription exists and belongs to the same plan as the trial (`subscriptionPlanId` match).
2. The subscription belongs to the same consultee as the trial.
3. The trial is linked to the subscription via `convertedToSubscriptionId`.
4. An activity log entry is created via `logTrialConverted()`.

```json
{
  "status": "CONVERTED",
  "subscriptionId": "subscription-uuid-here"
}
```

---

## Booking Flow

```mermaid
sequenceDiagram
    participant Consultee
    participant API as /api/trials
    participant DB as Database
    participant Redis
    participant Novu

    Consultee->>API: POST /api/trials (request trial)
    API->>DB: Check unique constraint (one trial per pair)
    API->>DB: Verify plan has trialEnabled
    API->>DB: Create TrialSession (PENDING)
    API->>Novu: trial-session-requested (to consultant)
    API-->>Consultee: 201 Created

    Note over API: Consultant reviews request

    Consultee->>API: PATCH /api/trials/id with status SCHEDULED and slotData
    API->>Redis: lockSlotBooking(consultantProfileId, startsAt, endsAt)
    API->>DB: $transaction: validate availability (both participants) + create Appointment (TRIAL) + update TrialSession
    API->>Redis: unlockSlotBooking()
    API->>Novu: trial-session-scheduled (to consultee)
    API-->>Consultee: 200 OK

    Note over API: Session takes place

    Note over API: Hourly cron runs
    API->>DB: Find SCHEDULED trials past endTime + 1h buffer
    API->>DB: Update to COMPLETED, set completedAt
    API->>DB: Create ActivityLog (TRIAL_COMPLETED)
    API->>Novu: trial-session-completed (to both parties)
```

### Step-by-step

1. **Request** -- Consultee calls `POST /api/trials` with `consulteeProfileId`, `consultantProfileId`, `subscriptionPlanId`, and optional `notes`. The API checks the unique constraint and verifies `trialEnabled` on the plan.
2. **Eligibility check** -- `GET /api/trials/check-eligibility` can be called beforehand to verify the consultee has not already used their trial with this consultant.
3. **Approve & Schedule** -- Consultant calls `PATCH /api/trials/[trialId]` with `status: "SCHEDULED"` and `slotData: { startsAt, endsAt }`. The system acquires a distributed lock, validates slot availability, then creates an `Appointment` (type `TRIAL`) and a `SlotOfAppointment` inside a Prisma transaction.
4. **Session** -- Both parties join the meeting via Stream video call.
5. **Auto-complete** -- The hourly cron marks `SCHEDULED` trials as `COMPLETED` once all appointment slots have ended (with a 1-hour buffer).
6. **Conversion** -- If the consultee subscribes, the trial status transitions to `CONVERTED` and `convertedToSubscriptionId` is set.

### Paying for a trial

A priced trial is paid for on our own checkout page at
`/checkout/plans/trial/[trialId]`, and every "Pay Now" affordance in the product
has to land there. The page exists because the gateway pay-link on
`TrialSession.pendingPaymentUrl` opens straight into Razorpay with none of the
context a buyer needs: the branded page names the amount, shows the held session
in the viewer's own timezone, states the deadline the hold expires at, and only
then hands off (#1167).

The one place that decision is made is `trialCheckoutHref` in
`lib/appointments/trial-checkout-href.ts`. It returns the branded href for a
trial row and `null` for everything else, and a caller that gets `null` falls
back to opening `vm.pendingPaymentUrl` in a new tab. The `TrialSession` id only
survives in the synthetic view-model id the mappers mint (`trial-<id>`), which
is why the helper parses that prefix rather than reading a field. Both Pay Now
buttons on the appointment detail page and the one in the appointment sheet call
it, because the branch previously lived inline in the sheet and a second entry
point added on the detail page shipped without it, quietly regressing paid
trials back to the raw gateway link (#1428, #1429).

If you add a new surface that offers to pay for a booking, call the helper
first; do not re-derive the branch, and do not link to `pendingPaymentUrl`
directly.

---

## How Trial Differs from Consultation

| Aspect                | Trial                                                             | Consultation                                                  |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| **Payment**           | Per plan's `trialPriceInPaise` (0 = free, the default until paid-trial checkout ships)         | Required (via checkout)                                       |
| **Duration**          | Fixed per plan (`trialDurationMinutes`, default 30 min)           | Variable (`durationInHours`, 0.5-4h)                          |
| **Lock type**         | `lockSlotBooking()` -- shared `slot-booking:` atom keys           | `lockSlotBooking()` -- shared `slot-booking:` atom keys       |
| **Uniqueness**        | One per consultee-consultant pair                                 | Multiple allowed                                              |
| **Conversion**        | Leads to Subscription (`convertedToSubscriptionId`)               | Standalone                                                    |
| **Status field**      | `status` (TrialSessionStatus enum)                                | `status` (AppointmentStatus enum)                          |
| **Appointment type**  | `TRIAL`                                                           | `CONSULTATION`                                                |
| **Booking flow**      | Request -> consultant schedules                                   | Direct checkout or request-based                              |
| **Scheduling period** | None                                                              | None                                                          |
| **Slot count**        | Single slot (1)                                                   | `Math.ceil(durationInHours / 0.5)` slots                      |

---

## Concurrency Protection

Trial scheduling takes the SAME lock as every other direct slot writer: `lockSlotBooking()` in `utils/appointmentlock.ts`, which acquires one key per 30-minute atom of the requested interval. Until #1169 PR 1 trials locked a private `trial-slot-booking:` namespace that no other path read, so a trial and a consultation checkout for the same consultant-minute never contended — and because the trial slot also carried no `consultantProfileId`, it fell outside the `slot_no_confirmed_overlap` exclusion constraint too (#1093 §1). Both halves are fixed: the slot is stamped with `consultantProfileId` at creation, and the availability check now runs inside the scheduling transaction and covers the consultee's calendar as well as the consultant's.

Because the consultee-calendar check is only a read, the route also takes `lockConsulteeBooking(consulteeUserId)` before the slot lock, following the same consultant → consultee → slot lock order that checkout uses. Without it, two trials for the same consultee with two different consultants would hold disjoint consultant-keyed atoms, pass the consultee check concurrently, and both commit — the exact cross-consultant double-book the consultant-keyed exclusion constraint cannot see.

**Redis key pattern:** `slot-booking:{consultantProfileId}:{atomStartISO}` (one key per 30-minute atom)

| Parameter           | Value                                    |
| ------------------- | ---------------------------------------- |
| Default TTL         | 60,000 ms (60 seconds)                   |
| Retry count         | 5 per atom (interval config)             |
| Base retry delay    | 200 ms                                   |
| Retry jitter        | 200 ms (random)                          |
| Exponential backoff | Yes                                      |
| Drift factor        | 0.01                                     |
| Release mechanism   | Atomic Lua script (check value then DEL) |

The locks are acquired before slot validation and released in a `finally` block regardless of success or failure. On lock contention, the API returns HTTP 423 (Locked); when Redis is unreachable, acquisition fails closed with HTTP 503 (`BookingLockUnavailableError`) instead of reading as contention.

Slot validation inside the lock checks for overlaps across all appointment types (consultations, subscriptions, webinars, classes, and other trials).

---

## Auto-Completion

**File:** `scripts/appointments/auto-complete-appointments.ts`
**Schedule:** Hourly (via GitHub Actions cron job)
**Buffer:** 1 hour after session end time

The `completeTrials()` function:

1. Queries `TrialSession` records where `status = SCHEDULED` and all linked `SlotOfAppointment.endsAt < (now - 1 hour)`
2. Updates each to `status = COMPLETED` with `completedAt = now()`
3. Creates an `ActivityLog` entry with `activityType = TRIAL_COMPLETED` and `metadata: { autoCompleted: true }`

Additionally, the `GET /api/trials` endpoint performs an inline auto-complete check (without the buffer) to keep the UI current between cron runs.

---

## Conversion to Subscription

When a consultee decides to subscribe after a trial, the trial status transitions from `COMPLETED` to `CONVERTED`:

```
TrialSession.convertedToSubscriptionId --> Subscription.id
Subscription.convertedFromTrial --> TrialSession
```

This is a one-to-one relationship (both FKs carry `@unique`). The conversion is triggered by a `PATCH` to `/api/trials/[trialId]` with `status: "CONVERTED"` and a `subscriptionId` in the body. The handler:

1. Validates the `subscriptionId` is provided (returns 400 if missing).
2. Confirms the subscription belongs to the same plan and consultee as the trial.
3. Sets `convertedToSubscriptionId` on the trial record.
4. Calls `logTrialConverted()` to create an `ActivityLog` entry with `activityType = TRIAL_CONVERTED`.

The link enables:

- Tracking trial-to-subscription conversion rates
- Displaying conversion status on the consultant dashboard
- Activity log entries with `activityType = TRIAL_CONVERTED`

---

## Notifications

Trial events trigger Novu workflows defined in `lib/novu/workflows.ts`. All trial workflows use the `TrialSessionPayload` type.

| Workflow ID               | Trigger                     | Recipients   |
| ------------------------- | --------------------------- | ------------ |
| `trial-session-requested` | Consultee requests trial    | Consultant   |
| `trial-session-scheduled` | Consultant schedules trial  | Consultee    |
| `trial-session-completed` | Trial session ends          | Both parties |
| `trial-session-cancelled` | Trial cancelled or rejected | Both parties |

**Payload type** (`TrialSessionPayload`):

| Field            | Type      | Description                     |
| ---------------- | --------- | ------------------------------- |
| `consultantName` | `string`  | Consultant display name         |
| `consulteeName`  | `string`  | Consultee display name          |
| `planTitle`      | `string`  | Subscription plan title         |
| `dateTime`       | `string?` | Scheduled time (ISO format)     |
| `status`         | `string`  | Current trial status            |
| `dashboardUrl`   | `string`  | Link to relevant dashboard page |

Users can disable trial notifications via `NotificationPreference.trialNotifications`.

---

## API Reference

| Method   | Endpoint                        | Auth Required              | Purpose                                       |
| -------- | ------------------------------- | -------------------------- | --------------------------------------------- |
| `GET`    | `/api/trials`                   | Yes (session)              | List trials (paginated, filterable)            |
| `POST`   | `/api/trials`                   | Yes (session)              | Request a new trial session                    |
| `GET`    | `/api/trials/[trialId]`         | Yes (session)              | Get a specific trial session                   |
| `PATCH`  | `/api/trials/[trialId]`         | Yes (session)              | Update status (schedule, complete, convert)    |
| `DELETE` | `/api/trials/[trialId]`         | Yes (session)              | Cancel a PENDING or SCHEDULED trial            |
| `GET`    | `/api/trials/check-eligibility` | Yes (session)              | Check if consultee can request a trial         |
| `GET`    | `/api/trials/stats`             | Yes (session + ownership)  | Trial session statistics (own profile only)    |

**Note**: `/api/trials/stats` was previously in `PUBLIC_API_PREFIXES` (no auth required). It now requires authentication and enforces an ownership check -- users can only view stats for their own consultant profile.
