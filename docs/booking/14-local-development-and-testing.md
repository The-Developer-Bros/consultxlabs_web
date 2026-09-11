# Local Development and Testing

## 1. Prerequisites

### Required Software

| Tool           | Purpose                            | Install                                 |
| -------------- | ---------------------------------- | --------------------------------------- |
| Node.js (v18+) | Runtime                            | `nvm install 18`                        |
| PostgreSQL     | Database (via Prisma)              | Local install or Docker                 |
| Redis          | Distributed locking, rate limiting | Upstash (cloud) or local `redis-server` |

### Environment Variables

The following variables are required for booking flows. Add them to your `.env` or `.env.local` file:

| Variable                   | Purpose                                  | Example                                             |
| -------------------------- | ---------------------------------------- | --------------------------------------------------- |
| `DATABASE_URL`             | PostgreSQL connection string             | `postgresql://user:pass@localhost:5432/familiarise` |
| `UPSTASH_REDIS_REST_URL`   | Redis for distributed locks              | `https://xxx.upstash.io`                            |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth token                         | `AXxx...`                                           |
| `RAZORPAY_KEY_ID`          | Razorpay test key (Indian payments)      | `rzp_test_xxx`                                      |
| `RAZORPAY_KEY_SECRET`      | Razorpay test secret                     | `xxx`                                               |
| `STRIPE_SECRET_KEY`        | Stripe test key (international payments) | `sk_test_xxx`                                       |
| `STRIPE_PUBLISHABLE_KEY`   | Stripe publishable key                   | `pk_test_xxx`                                       |
| `CRON_SECRET`              | Auth token for cron job endpoints        | Any strong random string                            |
| `NEXTAUTH_SECRET`          | NextAuth session encryption              | Any strong random string                            |
| `NEXTAUTH_URL`             | Base URL for auth callbacks              | `http://localhost:3000`                             |

### Database Setup

```bash
# Generate Prisma client
npx prisma generate

# Push schema to local database
npx prisma db push

# Seed with booking-related data (see Section 3)
npm run db:seed
```

---

## 2. Mock Payments

### The `isMockPayment` Flag

**File**: `actions/checkout.action.ts`

The `checkoutAction` server action accepts an optional `isMockPayment` parameter (default: `false`). When `true`, the payment flow bypasses real gateway charges.

```typescript
export async function checkoutAction(
  data: CheckoutInput,
  isMockPayment: boolean = false,
);
```

### How Mock Payment Flow Differs

| Step                    | Real Payment                                            | Mock Payment                                                         |
| ----------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Payment intent creation | Calls Razorpay/Stripe API                               | Calls gateway API but with test keys                                 |
| Payment status          | Stays `PENDING` until webhook confirms                  | Set to `SUCCEEDED` immediately in the same transaction               |
| Appointment creation    | Created with `isTentative = true`, confirmed by webhook | Created with `isTentative = true`, payment marked `SUCCEEDED` inline |
| Webhook dependency      | Required -- appointment not confirmed without it        | Not required -- status updated directly in `handleCheckout`          |

**File**: `lib/payments/operations/checkout.ts` (lines ~1527-1533)

```typescript
if (isMockPayment) {
  await tx.payment.update({
    where: { id: payment.id },
    data: { paymentStatus: PaymentStatus.SUCCEEDED },
  });
}
```

### When to Use Mock Payments

- **Local development**: Avoid requiring real gateway credentials or webhook tunnels.
- **Integration tests**: Test end-to-end booking creation without payment infrastructure.

> **Note**: Mock payments still create real `Payment` records with `isMockPayment = true` in the database. The `handlePaymentSuccess` handler in `lib/payments/webhooks/handlers.ts` is shared by both webhook-driven and mock payment flows.

---

## 3. Seed Data

### Overview

**File**: `prisma/seed.ts`

The seeder runs in numbered phases. Booking-relevant phases:

| Phase | Script                            | What It Creates                                                                      |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------ |
| 1     | `1a-create-users`                 | Consultant and consultee user accounts with profiles                                 |
| 4a    | `4a-create-consultation-plans`    | Consultation plans with duration and pricing                                         |
| 4b    | `4b-create-subscription-plans`    | Subscription plans with `sessionsPerWeek`, `sessionDurationInHours`, `durationInMonths` |
| 4c    | `4c-create-webinar-plans`         | Webinar plans with duration                                                          |
| 4d    | `4d-create-class-plans`           | Class plans with `sessionsPerWeek` and class contents                                |
| 5a    | `5a-create-slots-of-availability` | Weekly and custom availability slots for consultants                                 |
| 6a    | `6a-create-appointments`          | Appointments with slot records across all event types                                |
| 8b    | `8b-create-payments`              | Payment records linked to appointments                                               |

### Running the Seeder

```bash
# Default seed (medium size)
npm run db:seed

# Size variants
npm run db:seed:small    # SEED_MODE=small -- minimal data for quick iteration
npm run db:seed:medium   # SEED_MODE=medium -- balanced dataset
npm run db:seed:large    # SEED_MODE=large -- stress-test volume

# Validation edge cases only
npm run db:seed:validation
```

### Inspecting Seed Data

```bash
# Open Prisma Studio browser UI
npx prisma studio
```

Prisma Studio lets you browse all tables, filter by fields like `isTentative`, `status`, and `appointmentType`, and inspect relationships.

---

## 4. Common Test Scenarios

### a. Create and Approve a Consultation

1. **Seed or create** a consultant with availability and a consultation plan.
2. **Checkout**: Call `checkoutAction` with `appointmentType: "CONSULTATION"`, a valid `planId`, and `startsAt`/`endsAt` within the consultant's availability. Set `isMockPayment: true` for local dev.
3. **Verify**: The consultation should have `status: "PENDING"` and a tentative appointment.
4. **Approve**: Use the consultant's dashboard Requests tab, or call `SlotAllocationService.allocate` directly with `mode: "requested"` to confirm the requested slots.
5. **Result**: `status` transitions to `APPROVED`, `isTentative` is cleared on all slots.

### b. Set Up a Subscription with Slot Allocation

1. **Create subscription**: Checkout a subscription plan. This creates a subscription with `status: "PENDING"` and a placeholder appointment.
2. **Auto allocation**: Call `SlotAllocationService.allocate({ eventType: "subscription", eventId, mode: "auto" })`. The service finds consecutive slots across weeks within the scheduling period and creates one appointment per session.
3. **Manual allocation**: Call with `mode: "manual"` and provide explicit `slots` array (ISO strings). Slots must be in multiples of `slotsPerCall` (e.g., 2 for 1-hour sessions).
4. **Verify**: Check that `sessionsPerWeek` is not exceeded per Sunday-Saturday week. Use `SubscriptionValidationService.validateSubscriptionSlots` to validate before allocating.

### c. Enroll in a Webinar and Test Capacity

1. **Checkout** a webinar plan with `isMockPayment: true`.
2. **Allocate slots**: Use `mode: "auto"` or `mode: "manual"` with consecutive slots matching the webinar duration.
3. **Fill capacity**: Enroll enough users to reach `maxParticipants`.
4. **Sold out**: The next enrollment attempt should fail with "Webinar is full". Raise the webinar's `maxParticipants` from the planner and confirm registration reopens.

### d. Cancel a Booking and Verify Refund Cascade

1. **POST** to `/api/appointments/{appointmentId}/cancel` with optional `reason` and `notes`.
2. **Verify**:
   - Consultation/subscription: `status` set to `CANCELLED`, `cancellationReason` and `cancelledBy` recorded.
   - Webinar/class: `status` set to `CANCELLED`.
   - Slots deleted (`slotOfAppointment.deleteMany`), then appointment deleted.
   - `notifyAppointmentCancelled` fired to both consultant and consultee.

### e. Reschedule a Subscription Session

1. **POST** to `/api/appointments/{appointmentId}/reschedule?type=SUBSCRIPTION` with optional `slotIds` array in the body.
   - No `slotIds`: marks **all** subscription slots as tentative (entire booking reschedule).
   - With `slotIds`: marks only specified slots as tentative (individual/multiple session reschedule).
2. **Verify**: Affected slots have `isTentative = true`. Only an entire-subscription reschedule (no `slotIds`) reverts the subscription `status` to `PENDING`; a partial reschedule of specific sessions (with `slotIds`) leaves the subscription status untouched and re-tentatives only those slots.
3. **Re-allocate**: Consultant selects new slots via the Requests tab (uses `mode: "requested"`).

**24-hour restriction**: Rescheduling is blocked if any affected slot starts within 24 hours. The API returns a `400` with details.

### f. Test Auto-Allocation vs Manual Allocation

| Aspect               | Auto (`mode: "auto"`)                                | Manual (`mode: "manual"`)              |
| -------------------- | ---------------------------------------------------- | -------------------------------------- |
| Input                | No slots needed                                      | Explicit ISO string array              |
| Strategy             | Finds earliest available consecutive slots           | Validates provided slots against rules |
| Subscription         | Distributes across weeks optimally                   | Validates slot count and weekly limits |
| Reschedule detection | Checks for existing tentative slots                  | Replaces all existing appointments     |
| Validation           | Runs `SlotValidationService.validate` on found slots | Runs validation on provided slots      |

Both paths run inside a 60-second Prisma transaction and call `SlotValidationService.validate` before creating appointments.

---

## 5. Running Tests

### Commands

```bash
# Run all tests
npm run test

# Watch mode (re-runs on file changes)
npm run test:watch

# Run a specific test file
npx jest slotAllocation
npx jest rescheduleCancel
npx jest subscriptionValidation

# Run with verbose output
npx jest --verbose

# Run with coverage report
npx jest --coverage
```

### Configuration

**File**: `jest.config.ts`

- Uses `next/jest` preset with `jsdom` environment (default).
- `rescheduleCancel.test.ts` uses `@jest-environment node` override (route handlers need Web API `Request`/`Response`).
- Setup file: `jest.setup.ts` (global config), plus `__tests__/booking-algorithm/setup.ts` (polyfills `TextEncoder`/`TextDecoder` for Prisma in jsdom).
- Mocks, setup files, and `node_modules` are excluded from test discovery via `testPathIgnorePatterns`.

### Test File Reference

| File                             | What It Tests                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slotAllocationService.test.ts`  | `SlotAllocationService.allocate` -- mode routing (auto/manual/requested), duplicate detection, slot count validation, appointment creation, event data extraction, status updates, existing appointment deletion                                                                                                                                                                                         |
| `slotCalculationService.test.ts` | `SlotCalculationService` -- week counting (`countWeeks`), `startOfWeekSunday`, duration validation, `calculateRequiredSlots` for all event types, `getSlotsPerCall`, `groupSlotsByDay`/`groupSlotsByWeek`, progress calculation                                                                                                                                                                          |
| `slotValidationService.test.ts`  | `SlotValidationService.validate` -- future slot checks (5-second buffer), weekly/custom schedule matching, scheduling period boundaries, conflict detection, event-specific rules (consultation: same-day + consecutive, webinar: consecutive, class: weekly limits + session grouping), 30-minute fixed slot duration                                                                                   |
| `allocationAlgorithms.test.ts`   | `AllocationAlgorithms` -- `manualAllocate` (validation, business rules) and `allocateRequestedSlots` (requested slot validation and delegation; formerly `preAllocate`). Auto mode is not covered here: the client auto-allocator was deleted in #997/#1132, and the server's picks are tested in `slotAllocationService.test.ts` and `preference-scored-allocation.test.ts`.                                                                                                                                               |
| `rescheduleCancel.test.ts`       | Reschedule and cancel API routes -- authentication (401), 404 handling, 24-hour policy enforcement, per-type slot marking (CONSULTATION/SUBSCRIPTION/WEBINAR/CLASS), partial vs entire reschedule, `CancelAppointmentSchema` validation, cancellation data recording, `cleanupTentativeSlots` script                                                                             |
| `subscriptionValidation.test.ts` | `SubscriptionValidationService` -- week key format consistency (Bug A fix), appointment-per-call counting (Bug B fix), weekly limit enforcement (Bug C fix), scheduling period validation, weekly info generation, `getAvailableWeeksForSubscription`, `canScheduleInWeek`, incomplete proposed call detection, `excludeAppointmentIds`                                                                  |
| `calendarUtils.test.ts`          | Calendar utilities -- `mapWeeklySlots`/`mapCustomSlots` (interval generation, UTC consistency), `slotsOverlap`, `getSlotStatus` (booking detection, partial booking, conflicts), `formatSlotsForAPI`, `validateSelectedSlots` (all event types), `groupSlotsByWeek`, `validateSlotDistribution`, `validateDayBasedConsecutiveSlots`, `calculateCallProgress`, `getAppointmentTitle`/`getAppointmentUser` |
| `booking.mockData.ts`            | Shared mock data factories -- `makeTimeSlot`, `makeConsecutiveTimeSlots`, `makeWeekOfAvailability`, `makeSubscriptionPlan`/`makeSubscription`, `makeAppointmentWithSlots`, `makeMockPrisma`, `makeConsultantData`, `makeWeeklyAvailabilitySlot`/`makeCustomAvailabilitySlot`                                                                                                                             |

### Test Count

Run `npm run test` to get the current test count. As of the last audit, the booking algorithm test suite contains 150+ individual test cases across 7 test files.

---

## 6. Testing Cron Jobs Locally

Cron job API endpoints require a `Bearer` token matching the `CRON_SECRET` environment variable. Both `GET` and `POST` methods are supported.

### Invocation Pattern

```bash
# Generic pattern
curl -X GET http://localhost:3000/api/cleanup/{job-name} \
  -H "Authorization: Bearer $CRON_SECRET"
```

### Booking-Related Cron Endpoints

| Endpoint                                   | Schedule                         | Purpose                                                                    |
| ------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------- |
| `/api/cleanup/auto-complete-appointments`  | `0 * * * *` (hourly)             | Transitions appointments to `COMPLETED` after session ends (1-hour buffer) |
| `/api/cleanup/tentative-slots`             | `0 */2 * * *` (every 2h)         | Deletes tentative slots older than 24 hours with no successful payment     |
| `/api/cleanup/stale-pending-consultations` | `30 * * * *` (hourly at :30)     | Cleans up consultations stuck in `PENDING` state                           |
| `/api/cleanup/invalid-appointments`        | `0 * * * *` (hourly)             | Detects and removes duplicate or invalid appointment records               |
| `/api/cleanup/expire-stale-requests`       | `0 1 * * *` (daily at 01:00 UTC) | Expires unanswered consultation/subscription requests                      |
| `/api/cleanup/reconcile-slot-availability` | `15 * * * *` (hourly at :15)     | Reconciles slot availability after payment state changes                   |
| `/api/cleanup/approval-payments`           | See cron config                  | Processes approval-based (pay-later) payment flows                         |
| `/api/cleanup/abandoned-payments`          | See cron config                  | Cleans up abandoned payment intents                                        |

### Example: Test Tentative Slot Cleanup

```bash
# Set your cron secret
export CRON_SECRET="your-local-secret"

# Trigger cleanup
curl -s -X GET http://localhost:3000/api/cleanup/tentative-slots \
  -H "Authorization: Bearer $CRON_SECRET" | jq .
```

Expected response:

```json
{
  "success": true,
  "slotsReleased": 0,
  "appointmentsAffected": 0,
  "errors": [],
  "timestamp": "2025-01-15T10:00:00.000Z"
}
```

### Example: Test Auto-Complete

```bash
curl -s -X GET http://localhost:3000/api/cleanup/auto-complete-appointments \
  -H "Authorization: Bearer $CRON_SECRET" | jq .
```

> **Cross-reference**: See `docs/booking/13-cron-jobs-and-background-tasks.md` for full per-job documentation, thresholds, and safety guarantees. See `docs/guides/cron-setup.md` for deployment-specific setup.

---

## 7. Debugging Tips

### Checking Redis Locks

Slot allocation uses distributed locks via Upstash Redis (`utils/appointmentlock.ts`). To inspect lock state:

- **Upstash Console**: Navigate to your Upstash Redis instance dashboard. Search for keys prefixed with `lock:` or `slot-booking:`.
- **Local Redis**: If running a local Redis instance:

```bash
redis-cli KEYS "lock:*"
redis-cli KEYS "slot-booking:*"
redis-cli TTL "lock:slot-booking:some-event-id"
```

### Inspecting Tentative Slots

Tentative slots block consultant availability. To find them:

```bash
# Open Prisma Studio
npx prisma studio
```

In Prisma Studio, navigate to the `SlotOfAppointment` table and filter by `isTentative = true`. Check the associated `Appointment` and `Payment` records to determine if the slot is from an abandoned checkout.

Alternatively, query directly:

```sql
SELECT soa.id, soa."startsAt", soa."isTentative", soa."createdAt", a."appointmentType"
FROM "SlotOfAppointment" soa
JOIN "Appointment" a ON soa."appointmentId" = a.id
WHERE soa."isTentative" = true
ORDER BY soa."createdAt" DESC;
```

### Viewing Notification Logs

The booking system sends notifications via Novu (`lib/novu.ts`). Functions like `notifyAppointmentCancelled` are called after cancellation. To verify:

- Check the **Novu dashboard** for delivery status of triggered notifications.
- In tests, Novu is mocked: `jest.mock("../../lib/novu", ...)`. Check mock call arguments to verify notification payloads.

### Checking Payment Status

- **Razorpay**: Log in to the [Razorpay Test Dashboard](https://dashboard.razorpay.com) with test credentials. Check payment status under Transactions.
- **Stripe**: Log in to the [Stripe Test Dashboard](https://dashboard.stripe.com/test). Check PaymentIntents under Payments.
- **Database**: Query the `Payment` table for `paymentStatus`, `isMockPayment`, and `paymentIntent` fields:

```sql
SELECT id, "paymentStatus", "isMockPayment", "paymentIntent", "paymentGateway", "createdAt"
FROM "Payment"
WHERE "appointmentId" = 'your-appointment-id';
```

### Common Debugging Workflow

1. **Identify the error**: Check the server console or API response for the error message.
2. **Look up the error**: Use the quick error lookup table in `docs/booking/05-troubleshooting-and-changelog.md`.
3. **Check validation**: Most booking errors originate from `SlotValidationService.validate`. Enable verbose logging or run the unit test for the specific validation rule.
4. **Check lock state**: If an operation hangs or returns a lock error, inspect Redis for stale locks. Locks have TTLs but can persist if the process crashes.
5. **Check tentative slots**: If a consultant's calendar appears to have phantom bookings, query for `isTentative = true` slots. Run the tentative slot cleanup cron to clear stale ones.
6. **Check payment state**: If a booking is stuck in `PENDING`, verify the payment status. Mock payments should be `SUCCEEDED` immediately; real payments depend on webhook delivery.

> **Cross-reference**: `docs/booking/05-troubleshooting-and-changelog.md` for error patterns and fixes. `docs/upstash/redis/locking/00_README.md` for locking architecture.
