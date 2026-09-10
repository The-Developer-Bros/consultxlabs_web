# E2E Booking Algorithm Test — Agent 003

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

You are a senior QA engineer. Your job is to run exhaustive end-to-end tests of the
Familiarise booking algorithm — specifically the **Auto Allocate** code path for **Webinar**
and **Class** event types — using two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction + `fetch()` calls via `evaluate_script`

All test data uses the `-003` suffix to avoid collisions with existing `-001` / `-002` seed data.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase. No backlogs.
2. Verify DB state after every action via `execute_sql`.
3. Test both happy path AND error paths.
4. Take snapshots before every UI interaction.
5. Never hardcode session tokens in source code; use cookie-based auth.
6. All times in SQL are UTC. The consultant's timezone is Asia/Kolkata (UTC+5:30).

---

## Background: What Auto Allocate Does

`SlotAllocationService.autoAllocate()` picks slots on behalf of the consultant without
them manually choosing times.

| Behaviour                    | Webinar                                                                                                             | Class                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Search window**            | 4 weeks from now                                                                                                    | Full `schedulingPeriodStartsAt → EndsAt`                   |
| **Slot grouping**            | One appointment containing all consecutive slots (entire duration)                                                  | One appointment per session, distributed across the period |
| **Weekly limits**            | None                                                                                                                | `sessionsPerWeek` on `ClassPlan`                           |
| **Re-allocate**              | Replaces in a transaction; the appointment is only deleted when `payment: { none: {} }` still matches at write time | Same                                                       |
| **Request body**             | `{ "isAuto": true }`                                                                                                | `{ "isAuto": true }`                                       |
| **API endpoint**             | `PATCH /api/bookings/webinars/[webinarId]/allocate`                                                                 | `PATCH /api/bookings/classes/[classId]/allocate`           |
| **isAuto + slots both sent** | `isAuto` wins, `slots` ignored                                                                                      | `isAuto` wins, `slots` ignored                             |

**Critical source files:**

- `utils/slotAllocation/SlotAllocationService.ts` — `autoAllocate()`, reached through the public `allocate()` entry point via `dispatch`
- `app/api/bookings/webinars/[webinarId]/allocate/route.ts`
- `app/api/bookings/classes/[classId]/allocate/route.ts`
- `schemas/slotAllocation/validationSchemas.ts`

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
- `priceCurrency` (not `currency`) on `WebinarPlan` / `ClassPlan`
- `ConsulteeProfile` requires `userId` (NOT NULL) — create User first
- `SlotOfAvailabilityWeekly.startTimeUtc` / `endTimeUtc` are `Int @db.SmallInt` — **minutes since midnight UTC (0-1439)**, NOT timestamps. Example: 240 = 04:00 UTC, 690 = 11:30 UTC. `startDay`/`endDay` are `DayOfWeek` enums.

### Step 0.1 — Domain + SubDomain

```sql
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES ('test-domain-003', 'Auto Allocate Testing', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES ('test-subdomain-003', 'Booking Tests', 'test-domain-003', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2 — Consultant User + Profile

```
Name  : Test Consultant 003
Email : testconsultant003@familiarise.com
Pass  : TestPassword003!
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
  'test-consultant-profile-003',
  'Auto-allocate specialist for testing webinar and class scheduling.',
  5.0, 4.8,
  'Auto-Allocate Test Expert',
  'WEEKLY',
  'test-domain-003',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant003@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-003'
WHERE email = 'testconsultant003@familiarise.com';

-- Link profile to subdomain
INSERT INTO "_ConsultantProfileToSubDomain" ("A", "B")
VALUES ('test-consultant-profile-003', 'test-subdomain-003')
ON CONFLICT DO NOTHING;

-- Verify
SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant003@familiarise.com';
```

### Step 0.3 — Consultee User + Profile

```
Name  : Test Consultee 003
Email : testconsultee003@familiarise.com
Pass  : TestPassword003!
```

**RECOMMENDED:** Use UI signup at `/auth/signup` as CONSULTEE role.

After signup, run:

```sql
UPDATE "ConsulteeProfile"
SET goals = 'Exercise the auto-allocate paths end to end.',
    "aboutMe"  = 'Testing auto-allocate booking flows.'
FROM users u
WHERE "ConsulteeProfile"."userId" = u.id
  AND u.email = 'testconsultee003@familiarise.com';

-- Get the consultee profile ID for later use
SELECT cp.id as consultee_profile_id, u.id as user_id
FROM "ConsulteeProfile" cp
JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee003@familiarise.com';
```

### Step 0.4 — Consultant Availability Slots

```sql
-- Weekly availability: Mon–Fri, 09:30–17:00 IST
-- Conversion: 09:30 IST = 04:00 UTC = 240 min
--             17:00 IST = 11:30 UTC = 690 min
-- This gives a 7.5h window = 15 × 30-min slots per day

INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w003-mon', 'MONDAY',    240, 'MONDAY',    690, 'test-consultant-profile-003', NOW(), NOW()),
  ('test-w003-tue', 'TUESDAY',   240, 'TUESDAY',   690, 'test-consultant-profile-003', NOW(), NOW()),
  ('test-w003-wed', 'WEDNESDAY', 240, 'WEDNESDAY', 690, 'test-consultant-profile-003', NOW(), NOW()),
  ('test-w003-thu', 'THURSDAY',  240, 'THURSDAY',  690, 'test-consultant-profile-003', NOW(), NOW()),
  ('test-w003-fri', 'FRIDAY',    240, 'FRIDAY',    690, 'test-consultant-profile-003', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Verify: should return 5 rows, each with startTimeUtc=240, endTimeUtc=690
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc"
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-003'
ORDER BY "startDay";
```

### Step 0.5 — Webinar Plans

Two webinars:

- **Webinar A** (`test-webinar-003`): 2h duration (4 × 30-min slots) — fits within 7.5h daily window → **should succeed**
- **Webinar B** (`test-webinar-003b`): 10h duration (20 × 30-min slots) — exceeds 7.5h daily window (15 slots max) → **should fail**

```sql
INSERT INTO "WebinarPlan" (
  id, title, "durationInHours", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  (
    'test-webinar-plan-003',
    'Auto-Allocate Webinar (2h)',
    2.0, 30,
    500, 'INR',
    'test-consultant-profile-003',
    NOW(), NOW()
  ),
  (
    'test-webinar-plan-003b',
    'Impossible 10h Webinar',
    10.0, 10,
    100, 'INR',
    'test-consultant-profile-003',
    NOW(), NOW()
  )
ON CONFLICT (id) DO NOTHING;
```

### Step 0.6 — Webinar Instances

```sql
INSERT INTO "Webinar" (id, "webinarPlanId", status, "createdAt", "updatedAt")
VALUES
  ('test-webinar-003',  'test-webinar-plan-003',  'SCHEDULED', NOW(), NOW()),
  ('test-webinar-003b', 'test-webinar-plan-003b', 'SCHEDULED', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.7 — Class Plans

Two classes:

- **Class A** (`test-class-003`): 4 sessions, 2/week, 4-week period → all 4 sessions can be distributed → **should succeed**
- **Class B** (`test-class-003b`): 4 sessions, 2/week, 5-day period → only ~2 sessions can fit → **should fail**

```sql
INSERT INTO "ClassPlan" (
  id, title, "sessionDurationInHours", "totalSessions",
  "sessionsPerWeek", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  (
    'test-class-plan-003',
    'Auto-Allocate Class (4 sessions, 2/week)',
    1.0, 4, 2, 25,
    4000, 'INR',
    'test-consultant-profile-003',
    NOW(), NOW()
  ),
  (
    'test-class-plan-003b',
    'Tight-Period Class (4 sessions, 2/week, 5 days)',
    1.0, 4, 2, 25,
    4000, 'INR',
    'test-consultant-profile-003',
    NOW(), NOW()
  )
ON CONFLICT (id) DO NOTHING;
```

### Step 0.8 — Class Instances

```sql
INSERT INTO "Class" (
  id, "classPlanId", status,
  "schedulingPeriodStartsAt", "schedulingPeriodEndsAt",
  "createdAt", "updatedAt"
)
VALUES
  (
    'test-class-003',
    'test-class-plan-003',
    'SCHEDULED',
    NOW(),
    NOW() + INTERVAL '4 weeks',
    NOW(), NOW()
  ),
  (
    'test-class-003b',
    'test-class-plan-003b',
    'SCHEDULED',
    NOW(),
    NOW() + INTERVAL '5 days',
    NOW(), NOW()
  )
ON CONFLICT (id) DO NOTHING;
```

### Step 0.9 — Verify All Seed Data

Run these SELECT queries and confirm all rows exist before proceeding:

```sql
SELECT
  (SELECT COUNT(*) FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-003') AS weekly_avail,
  (SELECT COUNT(*) FROM "Webinar" WHERE id IN ('test-webinar-003', 'test-webinar-003b'))                        AS webinars,
  (SELECT COUNT(*) FROM "Class"   WHERE id IN ('test-class-003', 'test-class-003b'))                            AS classes;
-- Expected: weekly_avail=5, webinars=2, classes=2
```

**STOP and fix any missing rows before continuing.**

---

## Phase 1 — Authentication

1. Navigate to `http://localhost:3000/auth/signin`
2. Login as CONSULTANT: `testconsultant003@familiarise.com` / `TestPassword003!`
   - If account does not exist yet (first run): sign up at `/auth/signup` as CONSULTANT, then re-run the SQL from Step 0.2
3. `take_snapshot` — confirm you land on `/dashboard/consultant/...`
4. Capture the consultant profile ID from the URL

**Expected URL:** `/dashboard/consultant/test-consultant-profile-003/home`
If the URL has a different ID, update your SQL references accordingly.

5. Logout
6. Login as CONSULTEE: `testconsultee003@familiarise.com` / `TestPassword003!`
   - If account does not exist: sign up at `/auth/signup` as CONSULTEE, then re-run the SQL from Step 0.3
7. `take_snapshot` — confirm you land on `/dashboard/consultee/...`
8. Logout
9. Re-login as CONSULTANT for Phase 2

---

## Phase 2 — Webinar Auto-Allocate (as Consultant)

### Test 2.1 — Happy Path: Auto-Allocate 2h Webinar

As CONSULTANT, use `evaluate_script` to PATCH:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-003/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 200, response body has `data` array with exactly 1 appointment,
`data[0].slotsOfAppointment.length === 4`, all slots have `isTentative: false`.

**Verify consecutiveness in response:** For i = 0, 1, 2:
`data[0].slotsOfAppointment[i].endsAt === data[0].slotsOfAppointment[i+1].startsAt`

**DB verify:**

```sql
SELECT a.id, COUNT(s.id) AS slot_count, BOOL_AND(NOT s."isTentative") AS all_confirmed
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
WHERE a."webinarId" = 'test-webinar-003'
GROUP BY a.id;
-- Expected: 1 row, slot_count=4, all_confirmed=true
```

Also verify the slots are contiguous:

```sql
SELECT
  s."startsAt",
  s."endsAt",
  LEAD(s."startsAt") OVER (ORDER BY s."startsAt") AS next_slot_starts,
  s."endsAt" = LEAD(s."startsAt") OVER (ORDER BY s."startsAt") AS is_consecutive
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."webinarId" = 'test-webinar-003'
ORDER BY s."startsAt";
-- Expected: is_consecutive=true for the first 3 rows, NULL for the last
```

### Test 2.2 — Idempotency: Re-Auto-Allocate (replace existing)

Call the exact same PATCH again:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-003/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 200. The old appointment is replaced, but only because it
carries no Payment: the allocator's delete is
`tx.appointment.deleteMany({ where: { id, payment: { none: {} } } })`, and a
count of zero means a payment committed between the read and the write, in
which case it keeps the appointment and strips only its sessionless slots.
Total appointment count should still be exactly 1 with 4 slots.

**DB verify:**

```sql
SELECT COUNT(DISTINCT a.id) AS apt_count, SUM(slot_count) AS total_slots
FROM (
  SELECT a.id, COUNT(s.id) AS slot_count
  FROM "Appointment" a
  JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
  WHERE a."webinarId" = 'test-webinar-003'
  GROUP BY a.id
) sub;
-- Expected: apt_count=1, total_slots=4
```

### Test 2.3 — Consultee Enrolls After Auto-Alloc (as Consultee)

Switch to consultee session (logout consultant, login consultee).

```javascript
async () => {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "WEBINAR",
      planId: "test-webinar-plan-003",
      eventId: "test-webinar-003",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 200, `payment.status === "SUCCEEDED"`, `isMockPayment: true`

**DB verify — two appointments now exist (consultant's + consultee's):**

```sql
SELECT COUNT(DISTINCT a.id) AS apt_count
FROM "Appointment" a
WHERE a."webinarId" = 'test-webinar-003';
-- Expected: 2
```

**DB verify — user-slot M2M links for the consultee's appointment:**

```sql
SELECT a.id AS apt_id, COUNT(DISTINCT sou."B") AS linked_users
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
JOIN "_SlotOfAppointmentToUser" sou ON sou."A" = s.id
JOIN users u ON u.id = sou."B"
WHERE a."webinarId" = 'test-webinar-003'
  AND u.email = 'testconsultee003@familiarise.com'
GROUP BY a.id;
-- Expected: 1 row (consultee's appointment), linked_users=1
```

---

## Phase 3 — Class Auto-Allocate (as Consultant)

Re-login as CONSULTANT before starting this phase.

### Test 3.1 — Happy Path: Auto-Allocate 4-Session Class (2/week)

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/classes/test-class-003/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 200, `data.length === 4`, each appointment has 2 slots (1h = 2 × 30-min),
all slots `isTentative: false`.

**DB verify — 4 appointments each with 2 slots:**

```sql
SELECT a.id, COUNT(s.id) AS slot_count, BOOL_AND(NOT s."isTentative") AS all_confirmed
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
WHERE a."classId" = 'test-class-003'
GROUP BY a.id
ORDER BY MIN(s."startsAt");
-- Expected: 4 rows, each slot_count=2, all all_confirmed=true
```

### Test 3.2 — Weekly Distribution Check (≤2 sessions/week)

```sql
SELECT
  date_trunc('week', s."startsAt") AS week_start,
  COUNT(DISTINCT a.id)              AS sessions_this_week
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."classId" = 'test-class-003'
  AND s."startsAt" = (
    SELECT MIN(s2."startsAt")
    FROM "SlotOfAppointment" s2
    WHERE s2."appointmentId" = a.id
  )
GROUP BY 1
ORDER BY 1;
-- Expected: all sessions_this_week values ≤ 2
```

**If any week shows > 2 sessions, this is a bug — fix `autoAllocate()` in `SlotAllocationService.ts` immediately.**

### Test 3.3 — UI Verify (Appointments Page)

Navigate to `/dashboard/consultant/test-consultant-profile-003/appointments`.
`take_screenshot`

Verify the UI shows:

- [ ] Classes section contains a card for "Auto-Allocate Class (4 sessions, 2/week)"
- [ ] A "Timings" button is present
- [ ] Session counter shows "0 of 4 sessions" (the consultant's own sessions are not yet joined)

### Test 3.4 — Consultee Enrolls After Auto-Alloc (as Consultee)

Switch to consultee session.

```javascript
async () => {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CLASS",
      planId: "test-class-plan-003",
      eventId: "test-class-003",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 200, payment SUCCEEDED

**DB verify — each of the 4 class appointments links both consultant + consultee across its slots:**

```sql
SELECT a.id, COUNT(DISTINCT sou."B") AS linked_users
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
JOIN "_SlotOfAppointmentToUser" sou ON sou."A" = s.id
WHERE a."classId" = 'test-class-003'
GROUP BY a.id
ORDER BY a.id;
-- Expected: 4 rows, each linked_users=2 (consultant + consultee)
```

---

## Phase 4 — Edge Cases

### Test 4.1 — No Consecutive Block Available (Webinar B: 10h)

Webinar B requires 20 consecutive 30-min slots (10h), but the daily window is only
09:30–17:00 IST = 7.5h = 15 slots. No single day can contain a 20-slot consecutive block.

As CONSULTANT:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-003b/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 400 or 500, error body containing one of: `"no"`, `"consecutive"`,
`"available"`, `"slots"`, `"block"`, `"not found"`.

**If the API returns 200, this is a bug — the consecutive-block search algorithm in
`autoAllocate()` is not enforcing the daily boundary correctly. Fix immediately.**

### Test 4.2 — Scheduling Period Too Tight (Class B: 5-day period)

Class B needs 4 sessions at 2/week, but the scheduling period is only 5 days. A 5-day
window covers at most 1 calendar week, allowing a maximum of 2 sessions. The system
should detect that 4 sessions cannot be scheduled and return an error.

As CONSULTANT:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/classes/test-class-003b/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 400 or 500 — scheduling period too short to fit all required sessions.

**If the API returns 200 with fewer than 4 appointments, that is also a bug — the
service must either succeed with all sessions or fail explicitly, never partially allocate.**

### Test 4.3 — isAuto + slots Both Provided (isAuto Wins)

Provide both `isAuto: true` AND an explicit `slots` array with a deliberately stale /
invalid timestamp. `isAuto` should take priority and the `slots` field should be ignored.

As CONSULTANT:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-003/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isAuto: true,
        slots: ["2020-01-01T04:00:00.000Z"], // intentionally in the past / wrong
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** HTTP 200 — `isAuto` takes priority. The stale `slots` array is silently
disregarded. The system finds its own consecutive block and returns valid allocation data.

**Confirm the returned slots are NOT `2020-01-01T04:00:00.000Z`:**
Check `data[0].slotsOfAppointment[0].startsAt > "2026-01-01T00:00:00.000Z"` in the response.

**DB verify — still only 1 appointment (re-allocation replaced the previous one):**

```sql
SELECT COUNT(DISTINCT a.id) AS apt_count
FROM "Appointment" a WHERE a."webinarId" = 'test-webinar-003';
-- Expected: 1 (consultant's appointment; consultee's from Phase 2 may have been replaced)
```

---

## Phase 5 — Final Summary Query

Run this before cleanup to confirm overall test data health:

```sql
SELECT
  'Webinar A appointments'  AS label,
  COUNT(*)                  AS count
FROM "Appointment" WHERE "webinarId" = 'test-webinar-003'
UNION ALL
SELECT 'Webinar A slots',   COUNT(*)
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."webinarId" = 'test-webinar-003'
UNION ALL
SELECT 'Webinar B appointments', COUNT(*)
FROM "Appointment" WHERE "webinarId" = 'test-webinar-003b'
UNION ALL
SELECT 'Class A appointments', COUNT(*)
FROM "Appointment" WHERE "classId" = 'test-class-003'
UNION ALL
SELECT 'Class A slots',     COUNT(*)
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."classId" = 'test-class-003'
UNION ALL
SELECT 'Class B appointments', COUNT(*)
FROM "Appointment" WHERE "classId" = 'test-class-003b';
```

---

## Phase 6 — Cleanup

Run cleanup in strict reverse-dependency order ONLY after all tests pass.

```sql
-- 1. User-slot M2M links
DELETE FROM "_SlotOfAppointmentToUser"
WHERE "A" IN (
  SELECT s.id FROM "SlotOfAppointment" s
  JOIN "Appointment" a ON a.id = s."appointmentId"
  WHERE a."webinarId" IN ('test-webinar-003','test-webinar-003b')
     OR a."classId"   IN ('test-class-003','test-class-003b')
);

-- 2. Slots
DELETE FROM "SlotOfAppointment"
WHERE "appointmentId" IN (
  SELECT id FROM "Appointment"
  WHERE "webinarId" IN ('test-webinar-003','test-webinar-003b')
     OR "classId"   IN ('test-class-003','test-class-003b')
);

-- 3. Payments
DELETE FROM "Payment"
WHERE "appointmentId" IN (
  SELECT id FROM "Appointment"
  WHERE "webinarId" IN ('test-webinar-003','test-webinar-003b')
     OR "classId"   IN ('test-class-003','test-class-003b')
);

-- 4. Appointments
DELETE FROM "Appointment"
WHERE "webinarId" IN ('test-webinar-003','test-webinar-003b')
   OR "classId"   IN ('test-class-003','test-class-003b');

-- 5. Events
DELETE FROM "Webinar" WHERE id IN ('test-webinar-003','test-webinar-003b');
DELETE FROM "Class"   WHERE id IN ('test-class-003','test-class-003b');

-- 6. Plans
DELETE FROM "WebinarPlan" WHERE id IN ('test-webinar-plan-003','test-webinar-plan-003b');
DELETE FROM "ClassPlan"   WHERE id IN ('test-class-plan-003','test-class-plan-003b');

-- 7. Availability
DELETE FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-003';

-- 8. Profiles + Users
UPDATE users SET "consultantProfileId" = NULL
WHERE email = 'testconsultant003@familiarise.com';

DELETE FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-003';

DELETE FROM "ConsulteeProfile"
WHERE "userId" IN (
  SELECT id FROM users
  WHERE email IN ('testconsultant003@familiarise.com','testconsultee003@familiarise.com')
);

DELETE FROM accounts
WHERE "userId" IN (
  SELECT id FROM users
  WHERE email IN ('testconsultant003@familiarise.com','testconsultee003@familiarise.com')
);

DELETE FROM users
WHERE email IN ('testconsultant003@familiarise.com','testconsultee003@familiarise.com');

-- 9. Domain
DELETE FROM "_ConsultantProfileToSubDomain" WHERE "B" = 'test-subdomain-003';
DELETE FROM "SubDomain" WHERE id = 'test-subdomain-003';
DELETE FROM "Domain"    WHERE id = 'test-domain-003';

-- 10. All-zeros verify
SELECT
  (SELECT COUNT(*) FROM "Webinar"
   WHERE id IN ('test-webinar-003','test-webinar-003b'))                                                          AS webinars,
  (SELECT COUNT(*) FROM "Class"
   WHERE id IN ('test-class-003','test-class-003b'))                                                              AS classes,
  (SELECT COUNT(*) FROM "Appointment"
   WHERE "webinarId" IN ('test-webinar-003','test-webinar-003b')
      OR "classId"   IN ('test-class-003','test-class-003b'))                                                     AS apts,
  (SELECT COUNT(*) FROM users
   WHERE email IN ('testconsultant003@familiarise.com','testconsultee003@familiarise.com'))                       AS users;
-- Expected: all zeros
```

---

## Verification Checklist (End-to-End)

| #   | Check                                              | Assertion                                                      | Expected          |
| --- | -------------------------------------------------- | -------------------------------------------------------------- | ----------------- |
| 1   | Webinar auto-alloc creates exactly 1 appointment   | `COUNT(*) FROM Appointment WHERE webinarId='test-webinar-003'` | 1                 |
| 2   | Webinar slots are consecutive                      | `slot[i].endsAt === slot[i+1].startsAt` for all i in response  | True for all i    |
| 3   | Webinar slot count matches 2h ÷ 30min              | `COUNT(*) of slotsOfAppointment` in response                   | 4                 |
| 4   | Re-auto-allocate doesn't double appointments       | Count after 2nd call                                           | Still 1           |
| 5   | Class auto-alloc creates correct appointment count | `COUNT(*) FROM Appointment WHERE classId='test-class-003'`     | 4                 |
| 6   | Each class appointment has 2 slots (1h)            | Per-appointment slot count in DB                               | 2 for each        |
| 7   | Weekly session limit enforced                      | `GROUP BY date_trunc('week', ...)` — max sessions per week     | ≤ 2               |
| 8   | Consultee checkout on webinar succeeds             | HTTP status + payment status                                   | 200, SUCCEEDED    |
| 9   | Consultee checkout on class succeeds               | HTTP status + payment status                                   | 200, SUCCEEDED    |
| 10  | Impossible webinar (10h) errors out                | HTTP status                                                    | 400 or 500        |
| 11  | Tight-period class (5 days) errors out             | HTTP status                                                    | 400 or 500        |
| 12  | `isAuto` overrides `slots` field                   | HTTP status + response slot dates                              | 200, dates > 2026 |
| 13  | Cleanup is complete                                | All-zeros verify query                                         | 0, 0, 0, 0        |

---

## Key Differences From Agent 001 / Agent 002

- **IDs:** all use `-003` suffix (no collisions)
- **Consultant:** generic test consultant, tech domain
- **Availability:** contiguous Mon–Fri 09:30–17:00 IST (one wide block per day, not split AM/PM like 002)
- **Focus:** exclusively **Auto Allocate** (`isAuto: true`) for Webinar + Class — the first test agent to exercise this code path
- **No Consultation or Subscription tests** — those were covered exhaustively by agents 001 and 002
- **Edge cases target the auto-alloc algorithm specifically:**
  - Impossible consecutive block (webinar too long for daily window)
  - Scheduling period too tight for all sessions (class)
  - `isAuto` + `slots` conflict resolution (mode precedence)
