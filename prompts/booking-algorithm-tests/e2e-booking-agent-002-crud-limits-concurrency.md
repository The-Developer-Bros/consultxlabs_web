# E2E Booking Algorithm Test — Agent 002

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

You are a senior QA engineer. Your job is to run exhaustive end-to-end tests of the
Familiarise booking algorithm using two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction + `fetch()` calls via `evaluate_script`

All test data uses the `-002` suffix to avoid collisions with existing `-001` seed data.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase. No backlogs.
2. Verify DB state after every action via `execute_sql`.
3. Test both happy path AND error paths.
4. Take snapshots before every UI interaction.
5. Never hardcode session tokens in source code; use cookie-based auth.
6. All times in SQL are UTC. The consultant's timezone is Asia/Kolkata (UTC+5:30).

---

## Phase 0 — Data Seeding

Run all SQL blocks via `execute_sql` in order. Use `ON CONFLICT (id) DO NOTHING` for idempotency.

### Schema Quick Reference

- `User` → table: `"users"` (@@map)
- `Account` → table: `"accounts"` (@@map)
- `Session` → table: `"sessions"` (@@map)
- All others → table name = Prisma model name (e.g. `"ConsultantProfile"`)
- Passwords → bcrypt. Use the signup UI flow at `/auth/signup` for reliability.
- Timestamps → `timestamptz` columns, stored as UTC
- `priceCurrency` (not `currency`) on `ConsultationPlan` / `SubscriptionPlan`
- `ConsulteeProfile` requires `userId` (NOT NULL) — create User first
- `SlotOfAvailabilityWeekly.startTimeUtc` / `endTimeUtc` are `Int @db.SmallInt` — **minutes since midnight UTC (0-1439)**, NOT timestamps. Example: 240 = 04:00 UTC, 690 = 11:30 UTC. `startDay`/`endDay` are `DayOfWeek` enums.
- `SlotOfAvailabilityCustom.startsAt` / `endsAt` are `DateTime @db.Timestamptz()` — actual timestamps for one-off availability

### Step 0.1 — Domain + SubDomain

```sql
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES ('test-domain-002', 'Business & Strategy', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES ('test-subdomain-002', 'Product Management', 'test-domain-002', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2 — Consultant User + Profile + Account

```
Name  : Dr. Meera Test Consultant
Email : testconsultant002@familiarise.com
Pass  : TestPassword002!
```

**RECOMMENDED:** Use the signup UI at `http://localhost:3000/auth/signup` to create the
account (avoids bcrypt hash complexity). Then run the SQL below to enrich the profile.

After signup, run:

```sql
INSERT INTO "ConsultantProfile" (
  id, description, experience, rating,
  headline, "scheduleType",
  "domainId", "userId",
  "isVerified", "verificationStatus",
  "profileCompletionPercentage",
  "createdAt", "updatedAt"
)
SELECT
  'test-consultant-profile-002',
  'Product strategist with 8 years building B2B SaaS products.',
  8.0, 4.9,
  'Product Strategy & GTM Mentor',
  'WEEKLY',
  'test-domain-002',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant002@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-002'
WHERE email = 'testconsultant002@familiarise.com';

-- Verify
SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant002@familiarise.com';
```

### Step 0.3 — Consultee User + Profile + Account

```
Name  : Rahul Test Consultee
Email : testconsultee002@familiarise.com
Pass  : TestPassword002!
```

**RECOMMENDED:** Use UI signup at `/auth/signup` as CONSULTEE role.

After signup, run:

```sql
UPDATE "ConsulteeProfile"
SET goals = 'Transition from engineering into product management.',
    "aboutMe"  = 'Transitioning from engineering to product management.'
FROM users u
WHERE "ConsulteeProfile"."userId" = u.id
  AND u.email = 'testconsultee002@familiarise.com';

-- Get the consultee profile ID for later use
SELECT cp.id as consultee_profile_id, u.id as user_id
FROM "ConsulteeProfile" cp
JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee002@familiarise.com';
```

### Step 0.4 — Consultant Availability Slots

```sql
-- Weekly availability: Mon–Fri, 09:30–12:30 IST + 14:00–17:00 IST
-- Times stored as Int minutes since midnight UTC (0-1439)
-- Conversion: 09:30-12:30 IST = 04:00-07:00 UTC = 240-420 min
--             14:00-17:00 IST = 08:30-11:30 UTC = 510-690 min

INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  -- Monday AM: 09:30-12:30 IST = 04:00-07:00 UTC = 240-420 min
  ('test-w002-mon-am', 'MONDAY',    240, 'MONDAY',    420, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-tue-am', 'TUESDAY',   240, 'TUESDAY',   420, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-wed-am', 'WEDNESDAY', 240, 'WEDNESDAY', 420, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-thu-am', 'THURSDAY',  240, 'THURSDAY',  420, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-fri-am', 'FRIDAY',    240, 'FRIDAY',    420, 'test-consultant-profile-002', NOW(), NOW()),
  -- Monday PM: 14:00-17:00 IST = 08:30-11:30 UTC = 510-690 min
  ('test-w002-mon-pm', 'MONDAY',    510, 'MONDAY',    690, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-tue-pm', 'TUESDAY',   510, 'TUESDAY',   690, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-wed-pm', 'WEDNESDAY', 510, 'WEDNESDAY', 690, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-thu-pm', 'THURSDAY',  510, 'THURSDAY',  690, 'test-consultant-profile-002', NOW(), NOW()),
  ('test-w002-fri-pm', 'FRIDAY',    510, 'FRIDAY',    690, 'test-consultant-profile-002', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Custom slot: next Saturday 10:00–16:00 IST (04:30–10:30 UTC)
-- Custom slots use actual timestamps (DateTime @db.Timestamptz), not minutes
INSERT INTO "SlotOfAvailabilityCustom" (
  id, "startsAt", "endsAt",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-c002-sat-001',
  (date_trunc('week', NOW()) + INTERVAL '13 days' + INTERVAL '4 hours 30 minutes')::timestamptz,
  (date_trunc('week', NOW()) + INTERVAL '13 days' + INTERVAL '10 hours 30 minutes')::timestamptz,
  'test-consultant-profile-002',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.5 — Plans (All 4 Types)

```sql
-- Consultation Plan: 1.5h, INR 2500
INSERT INTO "ConsultationPlan" (
  id, title, "durationInHours", price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-consultation-plan-002',
  'Product Strategy Deep Dive',
  1.5, 2500, 'INR',
  'test-consultant-profile-002',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Subscription Plan: 2 calls/week, 6 sessions, 1 month, 1h each, INR 6000
INSERT INTO "SubscriptionPlan" (
  id, title, "sessionsPerWeek", "durationInMonths",
  "sessionDurationInHours", "totalSessions",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-subscription-plan-002',
  'PM Accelerator Program',
  2, 1, 1.0, 6,
  6000, 'INR',
  'test-consultant-profile-002',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Webinar Plan: 2.5h, 40 max participants, INR 750
INSERT INTO "WebinarPlan" (
  id, title, "durationInHours", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-webinar-plan-002',
  'GTM Strategy Workshop',
  2.5, 40,
  750, 'INR',
  'test-consultant-profile-002',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Class Plan: 3 meetings/week, 6 sessions, 1h each, 15 max, INR 9000
INSERT INTO "ClassPlan" (
  id, title, "sessionDurationInHours", "totalSessions",
  "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-class-plan-002',
  'Product Thinking Bootcamp',
  1.0, 6, 15,
  9000, 'INR',
  'test-consultant-profile-002',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.6 — Webinar + Class Instances

```sql
INSERT INTO "Webinar" (
  id, "webinarPlanId", status,
  "createdAt", "updatedAt"
)
VALUES (
  'test-webinar-002',
  'test-webinar-plan-002',
  'SCHEDULED',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Class" (
  id, "classPlanId", status,
  "schedulingPeriodStartsAt", "schedulingPeriodEndsAt",
  "createdAt", "updatedAt"
)
VALUES (
  'test-class-002',
  'test-class-plan-002',
  'SCHEDULED',
  NOW(),
  NOW() + INTERVAL '2 months',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.7 — Verify All Seed Data

Run these SELECT queries and confirm all rows exist before proceeding:

```sql
SELECT id, headline FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-002';
SELECT id, title FROM "ConsultationPlan"  WHERE id = 'test-consultation-plan-002';
SELECT id, title FROM "SubscriptionPlan"  WHERE id = 'test-subscription-plan-002';
SELECT id, title FROM "WebinarPlan"       WHERE id = 'test-webinar-plan-002';
SELECT id, title FROM "ClassPlan"         WHERE id = 'test-class-plan-002';
SELECT id, status FROM "Webinar"          WHERE id = 'test-webinar-002';
SELECT id, status FROM "Class"            WHERE id = 'test-class-002';
SELECT COUNT(*) as slot_count FROM "SlotOfAvailabilityWeekly"
  WHERE "consultantProfileId" = 'test-consultant-profile-002';
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc"
  FROM "SlotOfAvailabilityWeekly"
  WHERE "consultantProfileId" = 'test-consultant-profile-002';
SELECT id, "startsAt", "endsAt"
  FROM "SlotOfAvailabilityCustom"
  WHERE "consultantProfileId" = 'test-consultant-profile-002';
```

**STOP and fix any missing rows before continuing.**

---

## Phase 1 — Authentication

1. Navigate to `http://localhost:3000/auth/signin`
2. Login as CONSULTANT: `testconsultant002@familiarise.com` / `TestPassword002!`
3. `take_snapshot` — confirm you land on `/dashboard/consultant/...`
4. Capture the consultant profile ID from the URL

**Expected URL:** `/dashboard/consultant/test-consultant-profile-002/home`
If the URL has a different ID, update your SQL references accordingly.

5. Logout
6. Login as CONSULTEE: `testconsultee002@familiarise.com` / `TestPassword002!`
7. `take_snapshot` — confirm you land on `/dashboard/consultee/...`
8. Logout
9. Re-login as CONSULTANT for the main test flow

---

## Phase 2 — Consultation Testing

### Test 2.1 — Request Submitted Flow (UI)

As CONSULTEE:

1. Navigate to `/explore/experts/test-consultant-profile-002`
2. `take_snapshot` — verify profile shows "Product Strategy Deep Dive" plan
3. Click "Book" on the consultation plan
4. Select a slot (Mon–Fri, 09:30–12:30 or 14:00–17:00 IST, >3 days out)
5. Submit booking request
6. DB verify:

```sql
SELECT c."requestStatus", c."bookingSource", a.id as apt_id
FROM "Consultation" c
JOIN "Appointment" a ON a."consultationId" = c.id
WHERE c."consultationPlanId" = 'test-consultation-plan-002'
ORDER BY c."createdAt" DESC LIMIT 1;
```

Expected: `requestStatus=PENDING`, `bookingSource=REQUEST_SUBMITTED`

### Test 2.2 — Consultant Approves via Calendar

As CONSULTANT:

1. Navigate to `/dashboard/consultant/test-consultant-profile-002/requests`
2. `take_snapshot` — pending request visible
3. Open the request → click "Confirm" (use requested slots)
4. DB verify: `requestStatus=SCHEDULED`, `isTentative=false` on all slots

### Test 2.3 — Direct Checkout (Mock Payment)

As CONSULTEE, use `evaluate_script` to POST:

`checkoutSchema` names the plan `planId`, takes the window as `startsAt` /
`endsAt`, and for a CONSULTATION additionally **requires** exactly one of
`slotOfAvailabilityWeeklyId` / `slotOfAvailabilityCustomId`. There is no `slots`
array on this endpoint and no `consultationPlanId` field.

```javascript
async () => {
  // next Tuesday 10:00–11:30 IST = 04:30–06:00 UTC
  const nextTue = new Date();
  nextTue.setDate(nextTue.getDate() + ((2 + 7 - nextTue.getDay()) % 7 || 7));
  nextTue.setUTCHours(4, 30, 0, 0);
  const slotEnd = new Date(nextTue);
  slotEnd.setUTCHours(6, 0, 0, 0);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-002",
      startsAt: nextTue.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-w002-tue-am",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

DB verify:

```sql
SELECT c."requestStatus", c."bookingSource", p."paymentStatus", p."isMockPayment"
FROM "Consultation" c
JOIN "Appointment" a ON a."consultationId" = c.id
JOIN "Payment" p ON p."appointmentId" = a.id
WHERE c."bookingSource" = 'DIRECT_CHECKOUT'
  AND c."consultationPlanId" = 'test-consultation-plan-002'
ORDER BY c."createdAt" DESC LIMIT 1;
```

Expected: `requestStatus=SCHEDULED`, `paymentStatus=SUCCEEDED`, `isMockPayment=true`

### Test 2.4 — Decline a Request

As CONSULTEE: submit a new consultation request.
As CONSULTANT: decline it from `/requests` page.
DB verify: `requestStatus=REJECTED`

---

## Phase 3 — Subscription Testing (PM Accelerator: 2/week, 6 sessions, 1h each)

### Test 3.1 — Request + Auto-Allocate 6 Sessions

As CONSULTEE: subscribe to "PM Accelerator Program" on the consultant profile page.
As CONSULTANT: auto-allocate via the Timings calendar.

DB verify:

```sql
SELECT COUNT(*) as session_count,
       COUNT(DISTINCT s."appointmentId") as appointment_count,
       MIN(s."startsAt") as first_session,
       MAX(s."startsAt") as last_session
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
JOIN "Subscription" sub ON sub.id = a."subscriptionId"
WHERE sub."subscriptionPlanId" = 'test-subscription-plan-002';
```

Expected: 6 distinct appointments, all within scheduling period, `isTentative=false`

### Test 3.2 — Weekly Limit Enforcement (UI)

Open the Timings calendar for another subscription instance.
Try to manually select 3 sessions in the same calendar week.
Expected: "Weekly limit reached" toast after the 2nd session (max 2/week).

### Test 3.3 — Partial Reschedule (Individual Session)

After 3.1, get a slot ID from an appointment >24h away:

```sql
SELECT a.id as apt_id, s.id as slot_id, s."startsAt"
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
JOIN "Subscription" sub ON sub.id = a."subscriptionId"
WHERE sub."subscriptionPlanId" = 'test-subscription-plan-002'
  AND s."startsAt" > NOW() + INTERVAL '2 days'
  AND s."isTentative" = false
LIMIT 2;
```

```
POST /api/appointments/<apt_id>/reschedule?type=SUBSCRIPTION
Body: { "slotIds": ["<slot_id>"] }
Expected: 200, rescheduleType=individual_session, slotsAffected=1
```

DB verify:

```sql
-- ALL slots of that appointment → isTentative=true
-- Slots of OTHER appointments in the same subscription → isTentative=false
SELECT s."isTentative", a.id, s."startsAt"
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
JOIN "Subscription" sub ON sub.id = a."subscriptionId"
WHERE sub."subscriptionPlanId" = 'test-subscription-plan-002'
ORDER BY s."startsAt";
```

### Test 3.4 — Full Subscription Reschedule

```
POST /api/appointments/<any_apt_id_in_sub>/reschedule?type=SUBSCRIPTION
Body: {} (no slotIds)
Expected: 200, rescheduleType=entire_booking
```

DB verify: ALL slots across ALL appointments in the subscription → `isTentative=true`

---

## Phase 4 — Webinar Testing (GTM Strategy Workshop: 2.5h, 40 seats)

### Test 4.1 — Allocate Webinar Time (Consultant)

As CONSULTANT, use `evaluate_script` to PATCH:

```javascript
fetch("/api/bookings/webinars/test-webinar-002/allocate", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    slots: [
      // Next Wednesday 15:00–17:30 IST = 09:30–12:00 UTC
      // 5 × 30-min slots: 09:30, 10:00, 10:30, 11:00, 11:30
      // Compute next Wednesday's date dynamically
    ],
  }),
});
```

DB verify:

```sql
SELECT a.id, COUNT(s.id) as slot_count, MIN(s."isTentative") as any_tentative
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
WHERE a."webinarId" = 'test-webinar-002'
GROUP BY a.id;
```

Expected: 5 slots, all `isTentative=false`

### Test 4.2 — Register for Webinar (Mock Checkout)

As CONSULTEE:

```javascript
fetch("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    appointmentType: "WEBINAR",
    eventId: "test-webinar-002",
    isMockPayment: true,
  }),
});
```

Expected: 200, payment SUCCEEDED

### Test 4.3 — Consultee Cannot Reschedule Webinar

As CONSULTEE (logged in):

```javascript
fetch("/api/appointments/<webinar_apt_id>/reschedule?type=WEBINAR", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
```

Expected: `403 "You are not authorized to reschedule this appointment"`

---

## Phase 5 — Class Testing (Product Thinking Bootcamp: 3/week, 6 sessions, 1h each)

### Test 5.1 — Open Class Timings Dialog

As CONSULTANT, navigate to `/dashboard/consultant/test-consultant-profile-002/appointments`
Find "Product Thinking Bootcamp" in the Classes section.
Click "Timings" button.
`take_screenshot`

Verify dialog shows:

- "Manage Class Timings" title
- "Schedule 3 meetings per week. Each session is 1 hour."
- Scheduling period banner (NOW to NOW+2 months)
- Pre-period cells are blank (disabled) or "Outside Period"
- After period start: Available slots in green

### Test 5.2 — Scheduling Period Enforcement Toast

Click an "Outside Period" slot (before scheduling period start).
Expected: "Outside scheduling window" toast with exact period dates.

### Test 5.3 — Manual Allocate 6 Sessions (3/week × 2 weeks)

Navigate to first week inside the scheduling period.

- Select Mon 09:30 (2 × 30-min slots auto-selected for 1h session) → "Session added — 1 of 6"
- Select Wed 09:30 → "Session added — 2 of 6"
- Select Fri 09:30 → "Weekly limit reached" toast (max 3/week)
- Actually: max 3/week, so Fri should SUCCEED → "Session added — 3 of 6"
- Next week: Mon, Wed, Fri → "All 6 sessions scheduled!"
- Click "Allocate Manual Slots" → 200 response

DB verify: 6 appointments, each with 2 slots, all `isTentative=false`

### Test 5.4 — Enroll in Class (Mock Checkout)

As CONSULTEE:

```javascript
fetch("/api/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    appointmentType: "CLASS",
    eventId: "test-class-002",
    isMockPayment: true,
  }),
});
```

Expected: 200, payment SUCCEEDED

---

## Phase 6 — Edge Cases & Error States

Run all via `evaluate_script`. Log status + body for each.

### 6.1 — 401 Unauthenticated

```javascript
fetch("/api/appointments/fake-id/reschedule", {
  method: "POST",
  credentials: "omit",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
```

Expected: `401 { error: "Unauthorized" }`

### 6.2 — 404 Appointment Not Found

```javascript
fetch("/api/appointments/does-not-exist-abc/reschedule", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
```

Expected: `404 { error: "Appointment not found" }`

### 6.3 — 403 Non-Participant Reschedule

Create an appointment owned by a DIFFERENT consultant via SQL:

```sql
INSERT INTO "ConsultationPlan"
  (id, title, "durationInHours", price, "priceCurrency", "consultantProfileId", "createdAt", "updatedAt")
SELECT 'test-403-plan-002', 'Unrelated Plan', 1, 500, 'INR', id, NOW(), NOW()
FROM "ConsultantProfile"
WHERE id != 'test-consultant-profile-002' LIMIT 1
ON CONFLICT (id) DO NOTHING;

-- Get the consultee profile ID for our consultee
-- (use the ID retrieved in Step 0.3)
INSERT INTO "Consultation"
  (id, "consultationPlanId", "requestedById", "requestStatus", "createdAt", "updatedAt")
SELECT 'test-403-cons-002', 'test-403-plan-002', cp.id, 'PENDING', NOW(), NOW()
FROM "ConsulteeProfile" cp
JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee002@familiarise.com'
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Appointment" (id, "appointmentType", "consultationId", "createdAt", "updatedAt")
VALUES ('test-403-apt-002', 'CONSULTATION', 'test-403-cons-002', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

As CONSULTANT (`test-consultant-profile-002`), try to reschedule `test-403-apt-002`.
Expected: `403`

### 6.4 — 400 Type Mismatch

Use one of your own consultation appointments but pass `type=WEBINAR`.
Expected: `400 "Appointment type mismatch: query param "WEBINAR" does not match actual type "CONSULTATION""`

### 6.5 — 400 24-Hour Restriction

Create a consultation with a slot 10 hours from now:

```sql
INSERT INTO "Consultation"
  (id, "consultationPlanId", "requestedById", "requestStatus", "createdAt", "updatedAt")
SELECT 'test-24h-cons-002', 'test-consultation-plan-002', cp.id, 'SCHEDULED', NOW(), NOW()
FROM "ConsulteeProfile" cp JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee002@familiarise.com'
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Appointment" (id, "appointmentType", "consultationId", "createdAt", "updatedAt")
VALUES ('test-24h-apt-002', 'CONSULTATION', 'test-24h-cons-002', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SlotOfAppointment"
  (id, "appointmentId", "startsAt", "endsAt", "isTentative", "createdAt", "updatedAt")
VALUES (
  'test-24h-slot-002', 'test-24h-apt-002',
  NOW() + INTERVAL '10 hours', NOW() + INTERVAL '11 hours',
  false, NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

```
POST /api/appointments/test-24h-apt-002/reschedule?type=CONSULTATION
Expected: 400 "Cannot reschedule within 24 hours... starts in 9 hours" (approx)
```

### 6.6 — Cancellation Soft-Cancels; Nothing Is Deleted

```
POST /api/appointments/test-24h-apt-002/cancel
Body: { "reason": "CONSULTANT_UNAVAILABLE" }
Expected: 200 { success: true, cancellationReason: "CONSULTANT_UNAVAILABLE" }
```

DB verify. Cancelling **never** deletes a row: `Payment.appointment` cascades on
delete, so removing the Appointment would take the payment, refund and dispute
trail with it (the #1074 class). The cancel route moves
`SlotOfAppointment.completionStatus` from `SLOT_RESCHEDULABLE_FROM`
(`SCHEDULED`, `RESCHEDULED`) to `CANCELLED` and leaves the rows in place.

```sql
SELECT c."requestStatus", c."cancellationReason",
       (SELECT COUNT(*) FROM "SlotOfAppointment"
         WHERE "appointmentId" = 'test-24h-apt-002') AS slots,
       (SELECT COUNT(*) FROM "SlotOfAppointment"
         WHERE "appointmentId" = 'test-24h-apt-002'
           AND "completionStatus" = 'CANCELLED') AS cancelled_slots,
       (SELECT COUNT(*) FROM "Appointment" WHERE id = 'test-24h-apt-002') AS apts
FROM "Consultation" c WHERE id = 'test-24h-cons-002';
```

Expected: `CANCELLED`, `CONSULTANT_UNAVAILABLE`, `slots=1`, `cancelled_slots=1`,
`apts=1`. A `slots=0` or `apts=0` here means someone reintroduced the delete.
This fixture is seeded straight through SQL and carries no `Payment` row of its
own, so it proves the rows survive but not that the money trail does; the
payment-preservation assertion for a cancel lives in Agent 001 Test 5.7, against
an appointment that came from a real checkout.

### 6.7 — 403 Cancel as Non-Participant

```
POST /api/appointments/test-403-apt-002/cancel (as CONSULTANT 002, who doesn't own it)
Expected: 403
```

### 6.8 — Appointment Type Mismatch (400)

Get an existing CONSULTATION appointment and reschedule with wrong type:

```javascript
async () => {
  const appointmentId = "<CONSULTATION_APPOINTMENT_ID>";
  const response = await fetch(
    `/api/appointments/${appointmentId}/reschedule?type=WEBINAR`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

Expected: 400 with message: `"Appointment type mismatch: query param "WEBINAR" does not match actual type "CONSULTATION""`

### 6.9 — Weekly Availability CRUD API

Test the weekly availability slot management endpoints. Log in as consultant.

**6.9a: Create a new weekly slot**

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 360, // 06:00 UTC
      endDay: "SATURDAY",
      endTimeUtc: 540, // 09:00 UTC
      consultantProfileId: "test-consultant-profile-002",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

Expected: 201, slot created. Verify via DB:

```sql
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc"
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-002'
  AND "startDay" = 'SATURDAY';
```

**6.9b: Reject out-of-range time (startTimeUtc > 1439)**

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SUNDAY",
      startTimeUtc: 1500, // > 1439 — invalid
      endDay: "SUNDAY",
      endTimeUtc: 1600,
      consultantProfileId: "test-consultant-profile-002",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

Expected: 400

**6.9c: Reject overlapping slot**

```javascript
async () => {
  // Overlaps with Monday AM (240-420)
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "MONDAY",
      startTimeUtc: 300, // inside 240-420 range
      endDay: "MONDAY",
      endTimeUtc: 480,
      consultantProfileId: "test-consultant-profile-002",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

Expected: 400 — overlap detected

**6.9d: Update then delete the Saturday slot**

```javascript
async () => {
  const satSlotId = "<SATURDAY_SLOT_ID_FROM_6.9a>";

  const putResp = await fetch(`/api/slots/availability/weekly/${satSlotId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 420,
      endDay: "SATURDAY",
      endTimeUtc: 600,
    }),
  });

  const delResp = await fetch(`/api/slots/availability/weekly/${satSlotId}`, {
    method: "DELETE",
  });

  return { put: putResp.status, del: delResp.status };
};
```

Verify DB: Saturday slot removed.

### 6.10 — Concurrent Booking Race Condition

Fire two simultaneous checkouts for the same slot to verify distributed lock prevents double-booking:

```javascript
async () => {
  const nextThu = new Date();
  nextThu.setDate(nextThu.getDate() + ((4 + 7 - nextThu.getDay()) % 7 || 7));
  nextThu.setUTCHours(5, 0, 0, 0);

  const slotEnd = new Date(nextThu);
  slotEnd.setUTCHours(6, 0, 0, 0);

  const body = JSON.stringify({
    appointmentType: "CONSULTATION",
    planId: "test-consultation-plan-002",
    paymentGateway: "STRIPE",
    startsAt: nextThu.toISOString(),
    endsAt: slotEnd.toISOString(),
    slotOfAvailabilityWeeklyId: "test-w002-thu-am",
    isMockPayment: true,
  });

  const [r1, r2] = await Promise.all([
    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  ]);

  return {
    req1: { status: r1.status, body: await r1.json() },
    req2: { status: r2.status, body: await r2.json() },
  };
};
```

Expected: Exactly ONE succeeds, the other fails with conflict. Verify DB has only one appointment for that slot.

---

## Phase 7 — UI Verification Checklist

As CONSULTANT at `/dashboard/consultant/test-consultant-profile-002/appointments`:
`take_screenshot`

- [ ] Consultations section: allocated sessions show correct dates + "Join (Dev)" button
- [ ] Subscriptions section: shows "X of 6 sessions" (not more, not less)
- [ ] Session counter: if each session = 2 × 30-min slots → still shows 6 sessions (not 12)
- [ ] Classes section: shows "0 of 6 sessions" initially, "X of 6" after allocation
- [ ] Webinars section: correct date, "In X days/weeks" badge
- [ ] Status badges: correct (Not Started / In Progress / Completed)

As CONSULTANT at `/dashboard/consultant/test-consultant-profile-002/requests`:

- [ ] Pending requests visible with correct plan name and consultee name
- [ ] Accept / Decline buttons present
- [ ] Requested slot time displayed correctly in IST

Navigate to `/explore/experts/test-consultant-profile-002`:

- [ ] Profile page loads: headline, domain, ratings
- [ ] All 4 service types listed (Consultation, Subscription, Webinar, Class)
- [ ] Availability calendar shows Mon–Fri green slots

---

## Phase 8 — Availability API Verification

Use `evaluate_script` for these GET calls:

### 8.1 — Availability With Allocation (occupied slots excluded)

```javascript
const nextMon = /* compute next Monday's ISO date */;
const nextSat = /* compute next Saturday's ISO date */;
fetch(`/api/slots/availability-with-allocation/test-consultant-profile-002?startDate=${nextMon}&endDate=${nextSat}`)
```

Verify: slots that are already "Booked" (`isTentative=false`) do NOT appear in the response.

### 8.2 — Unallocated Weekly Slots

```javascript
fetch(
  "/api/slots/unallocated/weekly?consultantProfileId=test-consultant-profile-002",
);
```

Verify: `totalUnallocated < totalConfigured` after some slots are occupied.

### 8.3 — Subscription Validation — Weekly Limit

After allocating a subscription, POST:

```javascript
fetch("/api/bookings/subscriptions/<sub_id>/validate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    slots: [
      // 3 slots all in the same calendar week
    ],
  }),
});
```

Expected: validation error about weekly limit (plan allows max 2/week)

---

## Phase 9 — Final Summary Query

Run this to confirm overall test data health:

```sql
SELECT
  'Consultations' as type,
  COUNT(*) as count,
  COUNT(CASE WHEN "requestStatus" = 'SCHEDULED' THEN 1 END) as scheduled,
  COUNT(CASE WHEN "requestStatus" = 'CANCELLED' THEN 1 END) as cancelled
FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-002'
UNION ALL
SELECT
  'Subscriptions',
  COUNT(*), 0, 0
FROM "Subscription" WHERE "subscriptionPlanId" = 'test-subscription-plan-002'
UNION ALL
SELECT
  'Webinars',
  COUNT(*), 0, 0
FROM "Appointment" WHERE "webinarId" = 'test-webinar-002'
UNION ALL
SELECT
  'Class Appointments',
  COUNT(*), 0, 0
FROM "Appointment" WHERE "classId" = 'test-class-002'
UNION ALL
SELECT
  'Total Slots',
  COUNT(*), 0, 0
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-002')
   OR a."subscriptionId" IN (SELECT id FROM "Subscription"  WHERE "subscriptionPlanId" = 'test-subscription-plan-002')
   OR a."webinarId" = 'test-webinar-002'
   OR a."classId"   = 'test-class-002';
```

---

## Phase 10 — Cleanup

Run cleanup in dependency order ONLY after all tests pass:

```sql
-- Slots
DELETE FROM "SlotOfAppointment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" IN ('test-consultation-plan-002','test-403-plan-002'))
     OR a."subscriptionId" IN (SELECT id FROM "Subscription"  WHERE "subscriptionPlanId" = 'test-subscription-plan-002')
     OR a."webinarId" = 'test-webinar-002'
     OR a."classId"   = 'test-class-002'
);

-- Payments
DELETE FROM "Payment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."webinarId" = 'test-webinar-002' OR a."classId" = 'test-class-002'
);

-- Appointments
DELETE FROM "Appointment"
WHERE "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" IN ('test-consultation-plan-002','test-403-plan-002'))
   OR "subscriptionId" IN (SELECT id FROM "Subscription"  WHERE "subscriptionPlanId" = 'test-subscription-plan-002')
   OR "webinarId" = 'test-webinar-002'
   OR "classId"   = 'test-class-002';

-- Edge-case test rows
DELETE FROM "Appointment"  WHERE id IN ('test-24h-apt-002','test-403-apt-002');
DELETE FROM "Consultation" WHERE id IN ('test-24h-cons-002','test-403-cons-002');

-- Services
DELETE FROM "Consultation" WHERE "consultationPlanId" IN ('test-consultation-plan-002','test-403-plan-002');
DELETE FROM "Subscription"  WHERE "subscriptionPlanId" = 'test-subscription-plan-002';
DELETE FROM "Webinar"       WHERE id = 'test-webinar-002';
DELETE FROM "Class"         WHERE id = 'test-class-002';

-- Plans
DELETE FROM "ConsultationPlan" WHERE id IN ('test-consultation-plan-002','test-403-plan-002');
DELETE FROM "SubscriptionPlan" WHERE id = 'test-subscription-plan-002';
DELETE FROM "WebinarPlan"      WHERE id = 'test-webinar-plan-002';
DELETE FROM "ClassPlan"        WHERE id = 'test-class-plan-002';

-- Availability
DELETE FROM "SlotOfAvailabilityWeekly"  WHERE "consultantProfileId" = 'test-consultant-profile-002';
DELETE FROM "SlotOfAvailabilityCustom"  WHERE "consultantProfileId" = 'test-consultant-profile-002';

-- Profiles + Users
UPDATE users SET "consultantProfileId" = NULL WHERE email = 'testconsultant002@familiarise.com';
DELETE FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-002';

DELETE FROM "ConsulteeProfile" WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant002@familiarise.com','testconsultee002@familiarise.com')
);
DELETE FROM accounts WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant002@familiarise.com','testconsultee002@familiarise.com')
);
DELETE FROM users WHERE email IN ('testconsultant002@familiarise.com','testconsultee002@familiarise.com');

-- Domain
DELETE FROM "SubDomain" WHERE id = 'test-subdomain-002';
DELETE FROM "Domain"    WHERE id = 'test-domain-002';
```

---

## Key Differences From Agent 001 Run

- **IDs:** all use `-002` suffix (no collisions with existing test data)
- **Consultant:** Dr. Meera (business/product domain, not tech)
- **Plans:** 1.5h consultation, 6-session subscription (2/week), 2.5h webinar, 3/week class
- **Timezone:** same (Asia/Kolkata) — tests IST↔UTC conversion
- **Focus areas:**
  - Session counter accuracy for 1.5h consultation (3 slots = 1 session)
  - Weekly limit of 3 for classes (vs 2 in Agent 001)
  - 2-session/week subscription (vs 1 in Agent 001)
  - `CONSULTANT_UNAVAILABLE` cancellation reason (vs `SCHEDULE_CONFLICT`)
  - Verify slot atomic marking: partial reschedule marks ALL slots of appointment
