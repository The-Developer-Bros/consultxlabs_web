# E2E Booking Algorithm Test — Agent 006: Distributed Locking, Validation Hardening & Scoped Filtering

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

You are a senior QA engineer. Your job is to run exhaustive end-to-end tests of
distributed locking, error classification, input validation hardening,
consultant-scoped slot filtering, and UI verification, using two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction + `fetch()` calls via `evaluate_script`

All test data uses the `-006` suffix to avoid collisions with existing seed data.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase. No backlogs.
2. Verify DB state after every action via `execute_sql`.
3. Test both happy path AND error paths.
4. Take snapshots before every UI interaction.
5. Never hardcode session tokens in source code; use cookie-based auth.
6. All times in SQL are UTC. The consultant's timezone is Asia/Kolkata (UTC+5:30).

---

## Background: Key Infrastructure

**Distributed locking** (`utils/appointmentlock.ts`):

- `lockAutoAllocate(consultantProfileId, ttl?, scope?)` — consultant-level lock
  for auto-allocation, key `auto-allocate:<consultantProfileId>[:<scope>]`
- `lockSlotBooking(consultantProfileId, startsAt, endsAt, ttl?)` — the booking
  lock, **interval-granular** since #1169: it delegates to `lockSlotInterval`,
  which floors the window onto the 30-minute grid and takes one
  `slot-booking:<consultantProfileId>:<atomStartISO>` key per atom, in ascending
  order, all-or-nothing. There is no single per-slot key and the retired
  `trial-slot-booking:` namespace must not come back — trials take these same
  atoms.
- `lockEventCheckout(appointmentType, eventOrPlanId)` — event-level lock for
  webinar/class checkout, key `event-checkout:<appointmentType>:<eventOrPlanId>`

**Error classification:**

- Lock contention -> 409 in most places (`EventCheckoutBusyError`
  `EVENT_CHECKOUT_BUSY`, `ConsulteeBookingBusyError` `CONSULTEE_BOOKING_BUSY`),
  but the appointment lock answers **423** (`AppointmentBusyError`,
  `APPOINTMENT_BUSY`). Assert the code, not just "4xx".
- Redis unreachable or the circuit breaker open -> **503**
  `BOOKING_LOCK_UNAVAILABLE`. Acquisition fails closed by design; a 409 here
  would be a bug, because an unlocked booking must never proceed.
- Sold out is terminal, not contention: **409** `EVENT_SOLD_OUT`, no retry.
- Validation errors (bad data) -> 400
- Not-found errors -> 400 (not 500)

**Critical source files:**

- `utils/appointmentlock.ts` — all lock functions
- `utils/errors/SlotLockError.ts` — custom error class
- `app/api/bookings/webinars/[webinarId]/allocate/route.ts`
- `app/api/bookings/classes/[classId]/allocate/route.ts`
- `app/api/checkout/route.ts`

---

## Phase 0 — Data Seeding

Run all SQL blocks via `execute_sql` in order. Use `ON CONFLICT (id) DO NOTHING` for idempotency.

### Schema Quick Reference

- `User` -> table: `"users"` (@@map)
- `Account` -> table: `"accounts"` (@@map)
- `Session` -> table: `"sessions"` (@@map)
- All others -> table name = Prisma model name
- `SlotOfAvailabilityWeekly.startTimeUtc` / `endTimeUtc` are `Int @db.SmallInt` — **minutes since midnight UTC (0-1439)**
- `priceCurrency` (not `currency`) on plan tables

### Step 0.1 — Domain + SubDomain

```sql
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES ('test-domain-006', 'Locking & Validation Testing', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES ('test-subdomain-006', 'Concurrency Tests', 'test-domain-006', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2 — Consultant A — User + Profile

```
Name  : Lock Test Consultant A 006
Email : testconsultant006a@familiarise.com
Pass  : TestPassword006!
```

**RECOMMENDED:** Use the signup UI at `http://localhost:3000/auth/signup`.

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
  'test-consultant-profile-006a',
  'Consultant A for locking and validation tests.',
  7.0, 4.6,
  'Concurrency Test Expert A',
  'WEEKLY',
  'test-domain-006',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant006a@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-006a'
WHERE email = 'testconsultant006a@familiarise.com';

INSERT INTO "_ConsultantProfileToSubDomain" ("A", "B")
VALUES ('test-consultant-profile-006a', 'test-subdomain-006')
ON CONFLICT DO NOTHING;

SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant006a@familiarise.com';
```

### Step 0.3 — Consultant B — User + Profile

```
Name  : Lock Test Consultant B 006
Email : testconsultant006b@familiarise.com
Pass  : TestPassword006!
```

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
  'test-consultant-profile-006b',
  'Consultant B for scoping verification.',
  4.0, 4.2,
  'Concurrency Test Expert B',
  'WEEKLY',
  'test-domain-006',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant006b@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-006b'
WHERE email = 'testconsultant006b@familiarise.com';

SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant006b@familiarise.com';
```

### Step 0.4 — Consultee User + Profile

```
Name  : Lock Consultee 006
Email : testconsultee006@familiarise.com
Pass  : TestPassword006!
```

After signup, run:

```sql
UPDATE "ConsulteeProfile"
SET goals = 'Race the booking write path and survive it.',
    "aboutMe"  = 'Testing locking and validation flows.'
FROM users u
WHERE "ConsulteeProfile"."userId" = u.id
  AND u.email = 'testconsultee006@familiarise.com';

SELECT cp.id as consultee_profile_id, u.id as user_id
FROM "ConsulteeProfile" cp
JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee006@familiarise.com';
```

### Step 0.5 — Availability Slots (Both Consultants — Same Days/Times)

```sql
-- Consultant A: Mon-Fri 04:00-11:30 UTC (9:30-17:00 IST)
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w006a-mon', 'MONDAY',    240, 'MONDAY',    690, 'test-consultant-profile-006a', NOW(), NOW()),
  ('test-w006a-tue', 'TUESDAY',   240, 'TUESDAY',   690, 'test-consultant-profile-006a', NOW(), NOW()),
  ('test-w006a-wed', 'WEDNESDAY', 240, 'WEDNESDAY', 690, 'test-consultant-profile-006a', NOW(), NOW()),
  ('test-w006a-thu', 'THURSDAY',  240, 'THURSDAY',  690, 'test-consultant-profile-006a', NOW(), NOW()),
  ('test-w006a-fri', 'FRIDAY',    240, 'FRIDAY',    690, 'test-consultant-profile-006a', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Consultant B: IDENTICAL Mon-Fri 04:00-11:30 UTC
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w006b-mon', 'MONDAY',    240, 'MONDAY',    690, 'test-consultant-profile-006b', NOW(), NOW()),
  ('test-w006b-tue', 'TUESDAY',   240, 'TUESDAY',   690, 'test-consultant-profile-006b', NOW(), NOW()),
  ('test-w006b-wed', 'WEDNESDAY', 240, 'WEDNESDAY', 690, 'test-consultant-profile-006b', NOW(), NOW()),
  ('test-w006b-thu', 'THURSDAY',  240, 'THURSDAY',  690, 'test-consultant-profile-006b', NOW(), NOW()),
  ('test-w006b-fri', 'FRIDAY',    240, 'FRIDAY',    690, 'test-consultant-profile-006b', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.6 — Plans + Instances for Consultant A

```sql
-- Consultation Plan (for scoped filtering tests)
INSERT INTO "ConsultationPlan" (
  id, title, "durationInHours", price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-consultation-plan-006a',
  'Lock Test Consultation',
  1.0, 2000, 'INR',
  'test-consultant-profile-006a',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Webinar Plan: 1.5h, 5 max participants
INSERT INTO "WebinarPlan" (
  id, title, "durationInHours", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-webinar-plan-006a',
  'Lock Test Webinar',
  1.5, 5,
  500, 'INR',
  'test-consultant-profile-006a',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Webinar" (id, "webinarPlanId", status, "createdAt", "updatedAt")
VALUES ('test-webinar-006a', 'test-webinar-plan-006a', 'SCHEDULED', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Class Plan: 2 sessions, 1/week, 1h each, 3 max
INSERT INTO "ClassPlan" (
  id, title, "sessionDurationInHours", "totalSessions",
  "sessionsPerWeek", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-class-plan-006a',
  'Lock Test Class',
  1.0, 2, 1, 3,
  4000, 'INR',
  'test-consultant-profile-006a',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Class" (
  id, "classPlanId", status,
  "schedulingPeriodStartsAt", "schedulingPeriodEndsAt",
  "createdAt", "updatedAt"
)
VALUES (
  'test-class-006a',
  'test-class-plan-006a',
  'SCHEDULED',
  NOW(),
  NOW() + INTERVAL '4 weeks',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Webinar for sold-out test: 1h, max 1 participant
INSERT INTO "WebinarPlan" (
  id, title, "durationInHours", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-webinar-plan-006a-wl',
  'Sold Out Test Webinar',
  1.0, 1,
  300, 'INR',
  'test-consultant-profile-006a',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Webinar" (id, "webinarPlanId", status, "createdAt", "updatedAt")
VALUES ('test-webinar-006a-wl', 'test-webinar-plan-006a-wl', 'SCHEDULED', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.7 — Verify All Seed Data

```sql
SELECT id, headline FROM "ConsultantProfile" WHERE id IN ('test-consultant-profile-006a', 'test-consultant-profile-006b');
SELECT COUNT(*) as slots_a FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-006a';
SELECT COUNT(*) as slots_b FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-006b';
SELECT id, title FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-006a';
SELECT id, status FROM "Webinar" WHERE id IN ('test-webinar-006a', 'test-webinar-006a-wl');
SELECT id, status FROM "Class" WHERE id = 'test-class-006a';
```

**STOP and fix any missing rows before continuing.**

---

## Phase 1 — Authentication

1. Login as CONSULTANT A: `testconsultant006a@familiarise.com` / `TestPassword006!`
2. `take_snapshot` — confirm dashboard
3. Logout
4. Login as CONSULTANT B: `testconsultant006b@familiarise.com` / `TestPassword006!`
5. `take_snapshot`
6. Logout
7. Login as CONSULTEE: `testconsultee006@familiarise.com` / `TestPassword006!`
8. `take_snapshot`
9. Logout

---

## Phase 2 — Auto-Allocate Distributed Lock

### Setup: Allocate Webinar First

Login as CONSULTANT A. Allocate the webinar:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-006a/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200, webinar allocated with 3 slots (1.5h = 3 x 30min)

### Test 2.1 — Concurrent Auto-Allocate for SAME Webinar

Fire two simultaneous auto-allocate requests:

```javascript
async () => {
  const makeRequest = () =>
    fetch("/api/bookings/webinars/test-webinar-006a/allocate", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);
  return { request1: r1, request2: r2 };
};
```

**Expected:** One returns 200, the other returns 409 (lock contention).
The order doesn't matter — exactly one succeeds.

DB verify:

```sql
SELECT COUNT(DISTINCT a.id) AS apt_count
FROM "Appointment" a
WHERE a."webinarId" = 'test-webinar-006a';
-- Expected: 1 (no double-booking)
```

### Test 2.2 — Concurrent Auto-Allocate for SAME Class

First allocate the class:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/classes/test-class-006a/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

Then fire two concurrent requests:

```javascript
async () => {
  const makeRequest = () =>
    fetch("/api/bookings/classes/test-class-006a/allocate", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);
  return { request1: r1, request2: r2 };
};
```

**Expected:** One 200, one 409

DB verify:

```sql
SELECT COUNT(DISTINCT a.id) AS apt_count
FROM "Appointment" a
WHERE a."classId" = 'test-class-006a';
-- Expected: 2 (class has 2 total sessions, no more)
```

### Test 2.3 — Sequential Auto-Allocate After First Succeeds

After lock is released from Test 2.1, a sequential call should succeed:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-006a/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — lock was released, sequential allocation works

---

## Phase 3 — Lock Error Classification

### Test 3.1 — Validation Error Returns 400 (Not 500)

As CONSULTANT A, send invalid data to allocate:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-006a/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slots: "not-an-array",
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 (not 500) — validation error, not internal server error

### Test 3.2 — Not-Found Event Returns 400 (Not 500)

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/nonexistent-webinar-xyz/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** **400** — not 404, and not 500. `AllocationNotFoundError` fixes
`httpStatus = 400` (`utils/slotAllocation/errors.ts`) and the allocate routes
mint no 404 of their own, so a 404 here is a contract change, not a pass.

---

## Phase 4 — Integer Minute Range Validation

All as CONSULTANT A.

### Test 4.1 — startTimeUtc > 1439

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 1500,
      endDay: "SATURDAY",
      endTimeUtc: 1600,
      consultantProfileId: "test-consultant-profile-006a",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Invalid time format: must be integer 0-1439"

### Test 4.2 — startTimeUtc = -1

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: -1,
      endDay: "SATURDAY",
      endTimeUtc: 120,
      consultantProfileId: "test-consultant-profile-006a",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400

### Test 4.3 — Non-Integer startTimeUtc (10.5)

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 10.5,
      endDay: "SATURDAY",
      endTimeUtc: 120,
      consultantProfileId: "test-consultant-profile-006a",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — non-integer rejected

### Test 4.4 — String startTimeUtc via PATCH

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w006a-mon",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startTimeUtc: "abc",
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — typeof check catches string

### Test 4.5 — Boundary Values (0, 1439)

```javascript
async () => {
  // Create a slot with boundary values
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SUNDAY",
      startTimeUtc: 0,
      endDay: "SUNDAY",
      endTimeUtc: 1439,
      consultantProfileId: "test-consultant-profile-006a",
    }),
  });
  const body = await response.json();

  // Clean up if created
  if (response.status === 201 && body.data?.id) {
    await fetch(`/api/slots/availability/weekly/${body.data.id}`, {
      method: "DELETE",
    });
  }

  return { status: response.status, body };
};
```

**Expected:** 201 — boundary values 0 and 1439 are valid

---

## Phase 5 — Custom Date Validation

### Test 5.1 — PUT Custom Slot with "not-a-date"

As CONSULTANT A:

```javascript
async () => {
  // First create a custom slot to test against
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 21);
  baseDate.setUTCHours(10, 0, 0, 0);

  const createResp = await fetch("/api/slots/availability/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-006a",
      startsAt: baseDate.toISOString(),
      endsAt: new Date(baseDate.getTime() + 3 * 3600000).toISOString(),
    }),
  });
  const created = await createResp.json();
  const slotId = created.data?.id;

  if (!slotId) return { error: "Failed to create custom slot", created };

  // Try PUT with invalid date
  const putResp = await fetch(`/api/slots/availability/custom/${slotId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startsAt: "not-a-date",
      endsAt: "also-not-a-date",
    }),
  });

  // Clean up
  await fetch(`/api/slots/availability/custom/${slotId}`, { method: "DELETE" });

  return {
    createStatus: createResp.status,
    putStatus: putResp.status,
    putBody: await putResp.json(),
  };
};
```

**Expected:** putStatus=400 — "Invalid date format"

### Test 5.2 — PATCH Custom Slot with Invalid ISO

```javascript
async () => {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 22);
  baseDate.setUTCHours(14, 0, 0, 0);

  const createResp = await fetch("/api/slots/availability/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-006a",
      startsAt: baseDate.toISOString(),
      endsAt: new Date(baseDate.getTime() + 2 * 3600000).toISOString(),
    }),
  });
  const created = await createResp.json();
  const slotId = created.data?.id;

  if (!slotId) return { error: "Failed to create", created };

  const patchResp = await fetch(`/api/slots/availability/custom/${slotId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startsAt: "2026-13-45T99:99:99Z",
    }),
  });

  await fetch(`/api/slots/availability/custom/${slotId}`, { method: "DELETE" });

  return { patchStatus: patchResp.status, patchBody: await patchResp.json() };
};
```

**Expected:** patchStatus=400

### Test 5.3 — PUT Custom Slot with Valid ISO Dates

```javascript
async () => {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 23);
  baseDate.setUTCHours(10, 0, 0, 0);

  const createResp = await fetch("/api/slots/availability/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-006a",
      startsAt: baseDate.toISOString(),
      endsAt: new Date(baseDate.getTime() + 2 * 3600000).toISOString(),
    }),
  });
  const created = await createResp.json();
  const slotId = created.data?.id;

  if (!slotId) return { error: "Failed to create", created };

  const putResp = await fetch(`/api/slots/availability/custom/${slotId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startsAt: new Date(baseDate.getTime() + 1 * 3600000).toISOString(),
      endsAt: new Date(baseDate.getTime() + 4 * 3600000).toISOString(),
    }),
  });

  await fetch(`/api/slots/availability/custom/${slotId}`, { method: "DELETE" });

  return { putStatus: putResp.status };
};
```

**Expected:** putStatus=200

---

## Phase 6 — Consultant-Scoped Booked Slot Filtering

### Test 6.1 — Book a Slot for Consultant A

Login as CONSULTEE. Book a consultation with consultant A on Monday 10:00 IST
(04:30 UTC — the payload below is written in UTC, so read the two together):

```javascript
async () => {
  const nextMon = new Date();
  nextMon.setDate(
    nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7) + 7,
  );
  nextMon.setUTCHours(4, 30, 0, 0); // 10:00 IST = 04:30 UTC

  const slotEnd = new Date(nextMon);
  slotEnd.setUTCHours(5, 30, 0, 0); // 11:00 IST = 05:30 UTC

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-006a",
      paymentGateway: "STRIPE",
      startsAt: nextMon.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-w006a-mon",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200

### Test 6.2 — Consultant B's Availability at Same Time Is Still Free

Verify consultant B's availability at the same Monday slot is not affected:

```javascript
async () => {
  const nextMon = new Date();
  nextMon.setDate(
    nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7) + 7,
  );
  const nextSat = new Date(nextMon);
  nextSat.setDate(nextSat.getDate() + 5);

  const response = await fetch(
    `/api/slots/availability-with-allocation/test-consultant-profile-006b?startDate=${nextMon.toISOString().split("T")[0]}&endDate=${nextSat.toISOString().split("T")[0]}`,
  );
  const body = await response.json();

  // Monday slot should still show as available for consultant B
  return { status: response.status, body };
};
```

**Expected:** 200 — consultant B's Monday slots are all available (not affected by A's booking)

### Test 6.3 — Consultant A's Availability at Booked Time Is Excluded

```javascript
async () => {
  const nextMon = new Date();
  nextMon.setDate(
    nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7) + 7,
  );
  const nextSat = new Date(nextMon);
  nextSat.setDate(nextSat.getDate() + 5);

  const response = await fetch(
    `/api/slots/availability-with-allocation/test-consultant-profile-006a?startDate=${nextMon.toISOString().split("T")[0]}&endDate=${nextSat.toISOString().split("T")[0]}`,
  );
  const body = await response.json();

  // The booked Monday 04:30-05:30 slot should NOT appear as available
  return { status: response.status, body };
};
```

**Expected:** 200 — the booked slot (Mon 04:30-05:30 UTC) is excluded from consultant A's availability

---

## Phase 7 — Frontend UI Verification

### Test 7.1 — Appointments Page: Unscheduled Classes

Login as CONSULTANT A. Navigate to appointments page:

Navigate to `/dashboard/consultant/test-consultant-profile-006a/appointments`
`take_screenshot`

Verify:

- Classes section shows "Lock Test Class"
- If class was auto-allocated in Phase 2, it should show as scheduled (not in unscheduled section)
- If not yet allocated, it should show in the unscheduled section with "Timings" button

### Test 7.2 — Appointments Page: Unscheduled Webinars

On the same page, verify:

- Webinars section shows "Lock Test Webinar"
- If webinar was allocated in Phase 2, it should show as scheduled
- If not yet allocated, it should show in unscheduled section

### Test 7.3 — Class Session Counter

Verify the class session counter shows the correct count:

- "Lock Test Class" should show "0 of 2 sessions" or "2 of 2 sessions" depending on allocation
- The count should use `totalSessions` from the class plan (2), not raw slot count

---

## Phase 8 — Sold-Out Edge Case

### Setup: Allocate Single-Seat Webinar

Login as CONSULTANT A. Allocate the 1-participant webinar:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-006a-wl/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200

### Test 8.1 — First Checkout Fills Webinar

Login as CONSULTEE:

```javascript
async () => {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "WEBINAR",
      planId: "test-webinar-plan-006a-wl",
      eventId: "test-webinar-006a-wl",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — first participant fills the single seat

### Test 8.2 — Second Checkout Is Rejected As Full

Create a second consultee or use an existing one. The key point: the next checkout
should fail cleanly as full rather than causing a transaction rollback error.

```javascript
async () => {
  // As same consultee, try to checkout again (or a different user)
  // The system should detect that capacity is full
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "WEBINAR",
      planId: "test-webinar-plan-006a-wl",
      eventId: "test-webinar-006a-wl",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** A 4xx carrying "Webinar is full" — NOT a 500 transaction error

DB verify:

```sql
SELECT COUNT(*) as total_appointments
FROM "Appointment" WHERE "webinarId" = 'test-webinar-006a-wl';
```

---

## Phase 9 — Final Summary Query

```sql
SELECT
  'Consultant A Weekly Slots' AS label,
  COUNT(*) AS count
FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-006a'
UNION ALL
SELECT 'Consultant B Weekly Slots', COUNT(*)
FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-006b'
UNION ALL
SELECT 'Webinar Appointments', COUNT(*)
FROM "Appointment" WHERE "webinarId" IN ('test-webinar-006a', 'test-webinar-006a-wl')
UNION ALL
SELECT 'Class Appointments', COUNT(*)
FROM "Appointment" WHERE "classId" = 'test-class-006a'
UNION ALL
SELECT 'Consultations', COUNT(*)
FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-006a';
```

---

## Phase 10 — Cleanup

Run cleanup in dependency order ONLY after all tests pass:

```sql
-- M2M links
DELETE FROM "_SlotOfAppointmentToUser"
WHERE "A" IN (
  SELECT s.id FROM "SlotOfAppointment" s
  JOIN "Appointment" a ON a.id = s."appointmentId"
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-006a')
     OR a."webinarId" IN ('test-webinar-006a', 'test-webinar-006a-wl')
     OR a."classId" = 'test-class-006a'
);

-- Slots
DELETE FROM "SlotOfAppointment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-006a')
     OR a."webinarId" IN ('test-webinar-006a', 'test-webinar-006a-wl')
     OR a."classId" = 'test-class-006a'
);

-- Payments
DELETE FROM "Payment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-006a')
     OR a."webinarId" IN ('test-webinar-006a', 'test-webinar-006a-wl')
     OR a."classId" = 'test-class-006a'
);

-- Appointments
DELETE FROM "Appointment"
WHERE "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-006a')
   OR "webinarId" IN ('test-webinar-006a', 'test-webinar-006a-wl')
   OR "classId" = 'test-class-006a';


-- Services
DELETE FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-006a';
DELETE FROM "Webinar" WHERE id IN ('test-webinar-006a', 'test-webinar-006a-wl');
DELETE FROM "Class" WHERE id = 'test-class-006a';

-- Plans
DELETE FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-006a';
DELETE FROM "WebinarPlan" WHERE id IN ('test-webinar-plan-006a', 'test-webinar-plan-006a-wl');
DELETE FROM "ClassPlan" WHERE id = 'test-class-plan-006a';

-- Availability
DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" IN ('test-consultant-profile-006a', 'test-consultant-profile-006b');

-- Profiles + Users
UPDATE users SET "consultantProfileId" = NULL
WHERE email IN ('testconsultant006a@familiarise.com', 'testconsultant006b@familiarise.com');

DELETE FROM "_ConsultantProfileToSubDomain" WHERE "A" IN ('test-consultant-profile-006a', 'test-consultant-profile-006b');
DELETE FROM "ConsultantProfile" WHERE id IN ('test-consultant-profile-006a', 'test-consultant-profile-006b');

DELETE FROM "ConsulteeProfile" WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant006a@familiarise.com', 'testconsultant006b@familiarise.com', 'testconsultee006@familiarise.com')
);
DELETE FROM accounts WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant006a@familiarise.com', 'testconsultant006b@familiarise.com', 'testconsultee006@familiarise.com')
);
DELETE FROM users WHERE email IN ('testconsultant006a@familiarise.com', 'testconsultant006b@familiarise.com', 'testconsultee006@familiarise.com');

-- Domain
DELETE FROM "SubDomain" WHERE id = 'test-subdomain-006';
DELETE FROM "Domain" WHERE id = 'test-domain-006';

-- Verify
SELECT
  (SELECT COUNT(*) FROM users WHERE email LIKE 'test%006%@familiarise.com') AS users,
  (SELECT COUNT(*) FROM "ConsultantProfile" WHERE id LIKE 'test-consultant-profile-006%') AS profiles,
  (SELECT COUNT(*) FROM "Appointment" WHERE "webinarId" IN ('test-webinar-006a', 'test-webinar-006a-wl') OR "classId" = 'test-class-006a') AS appointments;
-- Expected: all zeros
```

---

## Verification Checklist (End-to-End)

| #   | Check                                                     | Expected              |
| --- | --------------------------------------------------------- | --------------------- |
| 1   | Concurrent webinar auto-allocate -> one 200, one 409      | Exactly one succeeds  |
| 2   | Concurrent class auto-allocate -> one 200, one 409        | Exactly one succeeds  |
| 3   | Sequential auto-allocate after lock release -> 200        | 200                   |
| 4   | No double-booking in DB after concurrent requests         | Verified via COUNT    |
| 5   | Validation error -> 400 (not 500)                         | 400                   |
| 6   | Not-found event -> 400 (not 404, not 500)                 | 400                   |
| 7   | startTimeUtc > 1439 -> 400                                | 400                   |
| 8   | startTimeUtc = -1 -> 400                                  | 400                   |
| 9   | startTimeUtc = 10.5 -> 400                                | 400                   |
| 10  | startTimeUtc = "abc" via PATCH -> 400                     | 400                   |
| 11  | Boundary values (0, 1439) -> 201                          | 201                   |
| 12  | Custom slot "not-a-date" -> 400                           | 400                   |
| 13  | Custom slot invalid ISO -> 400                            | 400                   |
| 14  | Custom slot valid ISO -> 200                              | 200                   |
| 15  | Consultant A booking does NOT affect B's availability     | B's slots all free    |
| 16  | Consultant A's booked slot excluded from own availability | Slot not in response  |
| 17  | Unscheduled classes NOT in scheduled section              | UI verified           |
| 18  | Session counter uses totalSessions                        | Correct count         |
| 19  | Webinar fills to capacity -> first checkout succeeds      | 200                   |
| 20  | Next checkout -> rejected as full (not 500)               | 4xx "Webinar is full" |
| 21  | Cleanup complete                                          | All counts = 0        |

---

## Key Differences From Agents 001-005

- **IDs:** all use `-006` suffix (no collisions)
- **Two consultants with IDENTICAL availability** — critical for scoped filtering tests
- **Focus:** distributed locking (`lockAutoAllocate`), error classification, input validation, consultant-scoped filtering
- **Concurrent requests via `Promise.all`** — tests the Redis distributed lock under contention
- **Integer minute validation** — comprehensive edge cases (negative, float, string, boundary)
- **Sold-out edge case** — webinar with max 1 participant, verifies graceful overflow
- **Cross-consultant scoping** — verifies booking for A doesn't affect B's availability
