# E2E Booking Algorithm Test — Agent 005: Overnight Slots, Overlap Detection & Scheduling Boundaries

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

You are a senior QA engineer. Your job is to run exhaustive end-to-end tests of
overnight/cross-midnight slot lifecycle, overlap detection (all 3+5 clauses in
`buildWeeklyOverlapWhere`), and scheduling period boundaries, using two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction + `fetch()` calls via `evaluate_script`

All test data uses the `-005` suffix to avoid collisions with existing seed data.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase. No backlogs.
2. Verify DB state after every action via `execute_sql`.
3. Test both happy path AND error paths.
4. Take snapshots before every UI interaction.
5. Never hardcode session tokens in source code; use cookie-based auth.
6. All times in SQL are UTC. The consultant's timezone is Asia/Kolkata (UTC+5:30).

---

## Background: Overnight Slot Model

`SlotOfAvailabilityWeekly` supports cross-midnight slots:

- `startDay` !== `endDay` (e.g., FRIDAY -> SATURDAY)
- `startTimeUtc` > `endTimeUtc` (e.g., 1380 -> 120 = 23:00 -> 02:00)
- `endDay` must be exactly the next day of the week after `startDay`

**Critical source files:**

- `utils/slotAllocation/slotTimeUtils.ts` — `validateWeeklySlotTimeOrder()`, `buildWeeklyOverlapWhere()`, `slotsOverlap()`, `isMinuteWithinWeeklySlot()`
- `app/api/slots/availability/weekly/route.ts` — POST with overlap check
- `app/api/slots/availability/weekly/[id]/route.ts` — PUT/PATCH/DELETE with overlap check
- `app/api/user/consultants/[id]/route.ts` — bulk settings with pairwise overlap check

---

## Phase 0 — Data Seeding

Run all SQL blocks via `execute_sql` in order. Use `ON CONFLICT (id) DO NOTHING` for idempotency.

### Schema Quick Reference

- `User` -> table: `"users"` (@@map)
- `Account` -> table: `"accounts"` (@@map)
- `Session` -> table: `"sessions"` (@@map)
- All others -> table name = Prisma model name
- `SlotOfAvailabilityWeekly.startTimeUtc` / `endTimeUtc` are `Int @db.SmallInt` — **minutes since midnight UTC (0-1439)**
- `SlotOfAvailabilityCustom.startsAt` / `endsAt` are `DateTime @db.Timestamptz()`

### Step 0.1 — Domain + SubDomain

```sql
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES ('test-domain-005', 'Overnight Slot Testing', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES ('test-subdomain-005', 'Cross-Midnight Tests', 'test-domain-005', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2 — Consultant User + Profile

```
Name  : Night Owl Consultant 005
Email : testconsultant005@familiarise.com
Pass  : TestPassword005!
```

**RECOMMENDED:** Use the signup UI at `http://localhost:3000/auth/signup` to create the account.

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
  'test-consultant-profile-005',
  'Overnight slot testing consultant for cross-midnight availability.',
  6.0, 4.7,
  'Night Owl Expert',
  'WEEKLY',
  'test-domain-005',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant005@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-005'
WHERE email = 'testconsultant005@familiarise.com';

INSERT INTO "_ConsultantProfileToSubDomain" ("A", "B")
VALUES ('test-consultant-profile-005', 'test-subdomain-005')
ON CONFLICT DO NOTHING;

SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant005@familiarise.com';
```

### Step 0.3 — Consultee User + Profile

```
Name  : Night Consultee 005
Email : testconsultee005@familiarise.com
Pass  : TestPassword005!
```

After signup, run:

```sql
UPDATE "ConsulteeProfile"
SET goals = 'Book across midnight without losing a session.',
    "aboutMe"  = 'Testing overnight booking flows.'
FROM users u
WHERE "ConsulteeProfile"."userId" = u.id
  AND u.email = 'testconsultee005@familiarise.com';

SELECT cp.id as consultee_profile_id, u.id as user_id
FROM "ConsulteeProfile" cp
JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee005@familiarise.com';
```

### Step 0.4 — Initial Availability Slots

```sql
-- Overnight weekly slot: Mon 23:00 -> Tue 01:00 UTC
-- startTimeUtc=1380 (23*60), endTimeUtc=60 (1*60)
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w005-mon-night', 'MONDAY', 1380, 'TUESDAY', 60, 'test-consultant-profile-005', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Same-day weekly slot: Wed 09:00-17:00 UTC
-- startTimeUtc=540, endTimeUtc=1020
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w005-wed-day', 'WEDNESDAY', 540, 'WEDNESDAY', 1020, 'test-consultant-profile-005', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Custom overnight slot: next Friday 23:00 -> Saturday 02:00
INSERT INTO "SlotOfAvailabilityCustom" (
  id, "startsAt", "endsAt",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-c005-fri-night',
  (date_trunc('week', NOW()) + INTERVAL '11 days' + INTERVAL '23 hours')::timestamptz,
  (date_trunc('week', NOW()) + INTERVAL '12 days' + INTERVAL '2 hours')::timestamptz,
  'test-consultant-profile-005',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.5 — Consultation Plan

```sql
INSERT INTO "ConsultationPlan" (
  id, title, "durationInHours", price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-consultation-plan-005',
  'Overnight Consultation',
  0.5, 1000, 'INR',
  'test-consultant-profile-005',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.6 — Class Plan + Instance (for scheduling period boundary tests)

```sql
INSERT INTO "ClassPlan" (
  id, title, "sessionDurationInHours", "totalSessions",
  "sessionsPerWeek", "maxParticipants",
  price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-class-plan-005',
  'Boundary Test Class',
  1.0, 2, 1, 10,
  3000, 'INR',
  'test-consultant-profile-005',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Class" (
  id, "classPlanId", status,
  "schedulingPeriodStartsAt", "schedulingPeriodEndsAt",
  "createdAt", "updatedAt"
)
VALUES (
  'test-class-005',
  'test-class-plan-005',
  'SCHEDULED',
  NOW(),
  NOW() + INTERVAL '14 days',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.7 — Verify All Seed Data

```sql
SELECT id, headline FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-005';
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc"
  FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-005';
SELECT id, "startsAt", "endsAt"
  FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-005';
SELECT id, title FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-005';
SELECT id, status, "schedulingPeriodEndsAt" FROM "Class" WHERE id = 'test-class-005';
```

**STOP and fix any missing rows before continuing.**

---

## Phase 1 — Authentication

1. Navigate to `http://localhost:3000/auth/signin`
2. Login as CONSULTANT: `testconsultant005@familiarise.com` / `TestPassword005!`
3. `take_snapshot` — confirm dashboard
4. Logout
5. Login as CONSULTEE: `testconsultee005@familiarise.com` / `TestPassword005!`
6. `take_snapshot` — confirm dashboard
7. Logout
8. Re-login as CONSULTANT for Phase 2

---

## Phase 2 — Overnight Weekly Slot CRUD

### Test 2.1 — Create Overnight Slot (Happy Path)

As CONSULTANT:

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "FRIDAY",
      endDay: "SATURDAY",
      startTimeUtc: 1380, // 23:00
      endTimeUtc: 120, // 02:00
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 201

DB verify:

```sql
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc"
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-005'
  AND "startDay" = 'FRIDAY';
-- Expected: startDay=FRIDAY, endDay=SATURDAY, startTimeUtc=1380, endTimeUtc=120
```

Save the returned slot ID for later tests as `FRIDAY_OVERNIGHT_ID`.

### Test 2.2 — Reject Invalid Overnight (endDay not next day)

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "MONDAY",
      endDay: "WEDNESDAY", // Not next day!
      startTimeUtc: 1380,
      endTimeUtc: 120,
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "For overnight slots, endDay must be the day after startDay"

### Test 2.3 — Reject Overnight Where startTimeUtc <= endTimeUtc

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "THURSDAY",
      endDay: "FRIDAY",
      startTimeUtc: 120, // 02:00
      endTimeUtc: 1320, // 22:00 — NOT crossing midnight
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Overnight slots must cross midnight"

### Test 2.4 — Update Overnight Slot Times via PUT

Use `FRIDAY_OVERNIGHT_ID` from Test 2.1:

```javascript
async () => {
  const slotId = "<FRIDAY_OVERNIGHT_ID>";
  const response = await fetch(`/api/slots/availability/weekly/${slotId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "FRIDAY",
      endDay: "SATURDAY",
      startTimeUtc: 1320, // 22:00 (shifted earlier)
      endTimeUtc: 90, // 01:30
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200

DB verify:

```sql
SELECT "startTimeUtc", "endTimeUtc" FROM "SlotOfAvailabilityWeekly"
WHERE id = '<FRIDAY_OVERNIGHT_ID>';
-- Expected: startTimeUtc=1320, endTimeUtc=90
```

### Test 2.5 — DB Verification: startDay !== endDay

```sql
SELECT id, "startDay", "endDay", "startTimeUtc", "endTimeUtc",
       ("startDay" != "endDay") AS is_overnight,
       ("startTimeUtc" > "endTimeUtc") AS crosses_midnight
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-005'
  AND "startDay" != "endDay";
-- Expected: all overnight rows have is_overnight=true AND crosses_midnight=true
```

---

## Phase 3 — Overnight Overlap Detection (All Clauses)

All tests in this phase are as CONSULTANT. Each test creates a slot that should
conflict with existing slots, or verifies non-overlapping slots succeed.

### Test 3.1 — Same-Day Basic Overlap

Two overlapping same-day Wednesday slots:

```javascript
async () => {
  // Existing: Wed 09:00-17:00 UTC (540-1020)
  // New: Wed 10:00-12:00 UTC (600-720) — entirely inside existing
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "WEDNESDAY",
      endDay: "WEDNESDAY",
      startTimeUtc: 600,
      endTimeUtc: 720,
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 409 — overlap detected

### Test 3.2 — Carry-Over Overlap (overnight into same-day)

Existing overnight: Mon 23:00 -> Tue 01:00 (1380 -> 60).
New same-day: Tue 00:30-02:00 (30-120) — overlaps the carry-over portion.

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "TUESDAY",
      endDay: "TUESDAY",
      startTimeUtc: 30, // 00:30
      endTimeUtc: 120, // 02:00
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 409 — carry-over overlap detected (Mon night spills into Tue 01:00, new starts at 00:30)

### Test 3.3 — Starting-Day Overlap (same-day overlaps overnight start)

Existing overnight: Mon 23:00 -> Tue 01:00 (1380 -> 60).
New same-day: Mon 22:30-23:30 (1350-1410) — overlaps the starting portion.

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "MONDAY",
      endDay: "MONDAY",
      startTimeUtc: 1350, // 22:30
      endTimeUtc: 1410, // 23:30
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 409 — starting-day overlap detected

### Test 3.4 — Two Overnights on Same Start Day

Existing overnight: Mon 23:00 -> Tue 01:00 (1380 -> 60).
New overnight: Mon 22:00 -> Tue 03:00 (1320 -> 180) — wider overnight on same start day.

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "MONDAY",
      endDay: "TUESDAY",
      startTimeUtc: 1320, // 22:00
      endTimeUtc: 180, // 03:00
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 409 — two overnights on same start day

### Test 3.5 — Non-Overlapping on Different Days (success)

Existing overnight: Mon 23:00 -> Tue 01:00 + Fri 22:00 -> Sat 01:30.
New overnight: Wed 23:00 -> Thu 01:00 — completely different days.

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "WEDNESDAY",
      endDay: "THURSDAY",
      startTimeUtc: 1380, // 23:00
      endTimeUtc: 60, // 01:00
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 201 — no overlap, created successfully

Save the returned ID as `WED_OVERNIGHT_ID` and clean it up after:

```sql
DELETE FROM "SlotOfAvailabilityWeekly" WHERE id = '<WED_OVERNIGHT_ID>';
```

### Test 3.6 — Midnight Boundary: slot ending at endTimeUtc=0

Test an overnight slot that ends exactly at midnight (endTimeUtc=0):

```javascript
async () => {
  // Sat 23:00 -> Sun 00:00 (1380 -> 0)
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      endDay: "SUNDAY",
      startTimeUtc: 1380,
      endTimeUtc: 0,
      consultantProfileId: "test-consultant-profile-005",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** This should either succeed (endTimeUtc=0 is valid boundary) or fail with a specific validation error. Document the actual behavior.

If it succeeds, clean up:

```sql
DELETE FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-005'
  AND "startDay" = 'SATURDAY' AND "endDay" = 'SUNDAY';
```

---

## Phase 4 — Bulk Settings Overnight Overlap

> **Body shape, verified against `app/api/user/consultants/[id]/route.ts`.** The
> weekly rows take `dayOfWeekforStartTimeInUTC` / `dayOfWeekforEndTimeInUTC` plus
> `startsAt` / `endsAt` (both ISO datetimes with an offset); custom rows take
> `startsAt` / `endsAt` alone. `domainId`, `subDomainIds` and `tagIds` are all
> validated with `z.string().uuid()`, so the readable `test-domain-0NN` ids this
> case seeds will 400 the happy-path arms. Read the real UUIDs out of the
> database first — `SELECT id FROM "Domain" WHERE name = '<seeded name>'` and the
> matching `SubDomain` row — and substitute them into every bulk-PUT body below.
> The authorization arms (403 / 401) short-circuit before validation, so they
> pass either way.

### Test 4.1 — Two Overlapping Overnight Slots in Bulk

Login as CONSULTANT:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-005",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Night Owl Expert.",
        experience: 6,
        scheduleType: "WEEKLY",
        domainId: "test-domain-005",
        subDomainIds: ["test-subdomain-005"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-05T23:00:00.000Z",
            endsAt: "2026-01-06T01:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-05T22:00:00.000Z",
            endsAt: "2026-01-06T03:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Submitted weekly slots contain overlapping time ranges"

### Test 4.2 — One Overnight + One Same-Day Overlapping in Bulk

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-005",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Night Owl Expert.",
        experience: 6,
        scheduleType: "WEEKLY",
        domainId: "test-domain-005",
        subDomainIds: ["test-subdomain-005"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-05T23:00:00.000Z",
            endsAt: "2026-01-06T01:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "TUESDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-06T00:30:00.000Z",
            endsAt: "2026-01-06T02:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — carry-over overlap (Mon night 23:00->Tue 01:00 overlaps Tue 00:30-02:00)

### Test 4.3 — Valid Non-Overlapping Overnight + Same-Day in Bulk

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-005",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Night Owl Expert.",
        experience: 6,
        scheduleType: "WEEKLY",
        domainId: "test-domain-005",
        subDomainIds: ["test-subdomain-005"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-05T23:00:00.000Z",
            endsAt: "2026-01-06T01:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "WEDNESDAY",
            dayOfWeekforEndTimeInUTC: "WEDNESDAY",
            startsAt: "2026-01-07T09:00:00.000Z",
            endsAt: "2026-01-07T17:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200

DB verify:

```sql
SELECT id, "startDay", "endDay", "startTimeUtc", "endTimeUtc"
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-005'
ORDER BY "startDay";
-- Expected: 2 rows (Mon->Tue overnight + Wed same-day)
```

Then restore original seed slots:

```sql
DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-005';
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w005-mon-night', 'MONDAY', 1380, 'TUESDAY', 60, 'test-consultant-profile-005', NOW(), NOW()),
  ('test-w005-wed-day', 'WEDNESDAY', 540, 'WEDNESDAY', 1020, 'test-consultant-profile-005', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

---

## Phase 5 — Overnight Checkout Guard

### Test 5.1 — Book at Mon 23:30 UTC Inside Overnight Window

Login as CONSULTEE:

```javascript
async () => {
  // Monday 23:30 UTC — inside Mon 23:00 -> Tue 01:00
  const nextMon = new Date();
  nextMon.setDate(
    nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7) + 7,
  );
  nextMon.setUTCHours(23, 30, 0, 0);

  const slotEnd = new Date(nextMon);
  slotEnd.setTime(slotEnd.getTime() + 30 * 60000); // +30 min

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-005",
      paymentGateway: "STRIPE",
      startsAt: nextMon.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-w005-mon-night",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — success (Mon 23:30 is inside the Mon 23:00 -> Tue 01:00 window)

### Test 5.2 — Book at Tue 00:30 UTC (Carry-Over Portion)

```javascript
async () => {
  // Tuesday 00:30 UTC — inside carry-over portion of Mon 23:00 -> Tue 01:00
  const nextMon = new Date();
  nextMon.setDate(
    nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7) + 7,
  );
  const nextTue = new Date(nextMon);
  nextTue.setDate(nextTue.getDate() + 1);
  nextTue.setUTCHours(0, 30, 0, 0);

  const slotEnd = new Date(nextTue);
  slotEnd.setTime(slotEnd.getTime() + 30 * 60000);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-005",
      paymentGateway: "STRIPE",
      startsAt: nextTue.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-w005-mon-night",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — success (Tue 00:30 is within the carry-over of Mon night)

### Test 5.3 — Book at Mon 22:00 UTC (Outside Window)

```javascript
async () => {
  // Monday 22:00 UTC — BEFORE Mon 23:00 -> Tue 01:00 window
  const nextMon = new Date();
  nextMon.setDate(
    nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7) + 7,
  );
  nextMon.setUTCHours(22, 0, 0, 0);

  const slotEnd = new Date(nextMon);
  slotEnd.setUTCHours(22, 30, 0, 0);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-005",
      paymentGateway: "STRIPE",
      startsAt: nextMon.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-w005-mon-night",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** Rejection (400 or similar) — Mon 22:00 is outside any availability window

---

## Phase 6 — Unallocated Overnight

### Test 6.1 — Query Unallocated Weekly After Overnight Booking

After the successful bookings in Phase 5:

```javascript
async () => {
  const response = await fetch(
    "/api/slots/unallocated/weekly?consultantProfileId=test-consultant-profile-005",
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — overnight availability properly reduces count

### Test 6.2 — Query Unallocated by Consultant

```javascript
async () => {
  const response = await fetch(
    "/api/slots/unallocated/test-consultant-profile-005",
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — overnight slots handled correctly (not negative counts, no errors)

---

## Phase 7 — Custom Slot Overlap Pairwise

### Test 7.1 — Two Overlapping Custom Slots via Bulk PUT

Login as CONSULTANT:

```javascript
async () => {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 21);
  baseDate.setUTCHours(10, 0, 0, 0);

  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-005",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Night Owl Expert.",
        experience: 6,
        scheduleType: "CUSTOM",
        domainId: "test-domain-005",
        subDomainIds: ["test-subdomain-005"],
        tagIds: [],
        slotsOfAvailabilityCustom: [
          {
            startsAt: baseDate.toISOString(),
            endsAt: new Date(
              baseDate.getTime() + 4 * 3600000,
            ).toISOString(),
          },
          {
            startsAt: new Date(
              baseDate.getTime() + 3 * 3600000,
            ).toISOString(),
            endsAt: new Date(
              baseDate.getTime() + 6 * 3600000,
            ).toISOString(),
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Submitted custom slots contain overlapping time ranges"

### Test 7.2 — Two Non-Overlapping Custom Slots

```javascript
async () => {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 21);
  baseDate.setUTCHours(10, 0, 0, 0);

  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-005",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Night Owl Expert.",
        experience: 6,
        scheduleType: "CUSTOM",
        domainId: "test-domain-005",
        subDomainIds: ["test-subdomain-005"],
        tagIds: [],
        slotsOfAvailabilityCustom: [
          {
            startsAt: baseDate.toISOString(),
            endsAt: new Date(
              baseDate.getTime() + 3 * 3600000,
            ).toISOString(),
          },
          {
            startsAt: new Date(
              baseDate.getTime() + 4 * 3600000,
            ).toISOString(),
            endsAt: new Date(
              baseDate.getTime() + 7 * 3600000,
            ).toISOString(),
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200

Restore to WEEKLY schedule after custom tests:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-005",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Night Owl Expert.",
        experience: 6,
        scheduleType: "WEEKLY",
        domainId: "test-domain-005",
        subDomainIds: ["test-subdomain-005"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-05T23:00:00.000Z",
            endsAt: "2026-01-06T01:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "WEDNESDAY",
            dayOfWeekforEndTimeInUTC: "WEDNESDAY",
            startsAt: "2026-01-07T09:00:00.000Z",
            endsAt: "2026-01-07T17:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status };
};
```

### Test 7.3 — Update Custom Slot to Overlap Existing

First create two non-overlapping custom slots individually:

```javascript
async () => {
  // Create slot 1
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 21);
  baseDate.setUTCHours(10, 0, 0, 0);

  const r1 = await fetch("/api/slots/availability/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-005",
      startsAt: baseDate.toISOString(),
      endsAt: new Date(baseDate.getTime() + 3 * 3600000).toISOString(),
    }),
  });
  const slot1 = await r1.json();

  // Create slot 2 (non-overlapping)
  const r2 = await fetch("/api/slots/availability/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-005",
      startsAt: new Date(baseDate.getTime() + 4 * 3600000).toISOString(),
      endsAt: new Date(baseDate.getTime() + 7 * 3600000).toISOString(),
    }),
  });
  const slot2 = await r2.json();

  // Now update slot 2 to overlap slot 1
  const slotId = slot2.data?.id;
  if (!slotId) return { error: "Failed to create slot 2", slot2 };

  const r3 = await fetch(`/api/slots/availability/custom/${slotId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startsAt: new Date(baseDate.getTime() + 2 * 3600000).toISOString(),
      endsAt: new Date(baseDate.getTime() + 5 * 3600000).toISOString(),
    }),
  });

  return {
    create1: r1.status,
    create2: r2.status,
    updateToOverlap: r3.status,
    updateBody: await r3.json(),
  };
};
```

**Expected:** create1=201, create2=201, updateToOverlap=409

Clean up custom slots created:

```sql
DELETE FROM "SlotOfAvailabilityCustom"
WHERE "consultantProfileId" = 'test-consultant-profile-005'
  AND id != 'test-c005-fri-night';
```

---

## Phase 8 — Scheduling Period Boundary

### Test 8.1 — Class Session Ending After schedulingPeriodEndsAt

As CONSULTANT, try to manually allocate a class session that starts within the period but ends after it:

```javascript
async () => {
  // Get the class scheduling period
  const classResp = await fetch("/api/bookings/classes/test-class-005");
  const classData = await classResp.json();
  const periodEnd = new Date(
    classData.data?.schedulingPeriodEndsAt || classData.schedulingPeriodEndsAt,
  );

  // Create a slot that starts 30 min before period end and ends 30 min after
  const slotStart = new Date(periodEnd.getTime() - 30 * 60000);
  const slotEnd = new Date(periodEnd.getTime() + 30 * 60000);

  const response = await fetch(
    "/api/bookings/classes/test-class-005/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slots: [
          {
            startsAt: slotStart.toISOString(),
            endsAt: slotEnd.toISOString(),
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** Rejection — last slot ends after `schedulingPeriodEndsAt`

### Test 8.2 — Class Session Fitting Entirely Within Period

```javascript
async () => {
  // Slot well within the 14-day period: 3 days from now, during Wed availability
  const slotStart = new Date();
  // Find next Wednesday
  const day = slotStart.getUTCDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  slotStart.setDate(slotStart.getDate() + daysUntilWed);
  slotStart.setUTCHours(10, 0, 0, 0);

  const slotEnd = new Date(slotStart);
  slotEnd.setUTCHours(11, 0, 0, 0); // 1h session

  const response = await fetch(
    "/api/bookings/classes/test-class-005/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slots: [
          {
            startsAt: slotStart.toISOString(),
            endsAt: slotEnd.toISOString(),
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — slot fits entirely within scheduling period and availability

---

## Phase 9 — Final Summary Query

```sql
SELECT
  'Overnight Weekly Slots' AS label,
  COUNT(*) AS count
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-005' AND "startDay" != "endDay"
UNION ALL
SELECT 'Same-Day Weekly Slots', COUNT(*)
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-005' AND "startDay" = "endDay"
UNION ALL
SELECT 'Custom Slots', COUNT(*)
FROM "SlotOfAvailabilityCustom"
WHERE "consultantProfileId" = 'test-consultant-profile-005'
UNION ALL
SELECT 'Consultations Booked', COUNT(*)
FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-005'
UNION ALL
SELECT 'Class Appointments', COUNT(*)
FROM "Appointment" WHERE "classId" = 'test-class-005';
```

---

## Phase 10 — Cleanup

Run cleanup in dependency order ONLY after all tests pass:

```sql
-- Appointment slots
DELETE FROM "_SlotOfAppointmentToUser"
WHERE "A" IN (
  SELECT s.id FROM "SlotOfAppointment" s
  JOIN "Appointment" a ON a.id = s."appointmentId"
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-005')
     OR a."classId" = 'test-class-005'
);

DELETE FROM "SlotOfAppointment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-005')
     OR a."classId" = 'test-class-005'
);

DELETE FROM "Payment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-005')
     OR a."classId" = 'test-class-005'
);

DELETE FROM "Appointment"
WHERE "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-005')
   OR "classId" = 'test-class-005';

DELETE FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-005';
DELETE FROM "Class" WHERE id = 'test-class-005';

DELETE FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-005';
DELETE FROM "ClassPlan" WHERE id = 'test-class-plan-005';

DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-005';
DELETE FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-005';

UPDATE users SET "consultantProfileId" = NULL WHERE email = 'testconsultant005@familiarise.com';

DELETE FROM "_ConsultantProfileToSubDomain" WHERE "A" = 'test-consultant-profile-005';
DELETE FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-005';

DELETE FROM "ConsulteeProfile" WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant005@familiarise.com', 'testconsultee005@familiarise.com')
);
DELETE FROM accounts WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant005@familiarise.com', 'testconsultee005@familiarise.com')
);
DELETE FROM users WHERE email IN ('testconsultant005@familiarise.com', 'testconsultee005@familiarise.com');

DELETE FROM "SubDomain" WHERE id = 'test-subdomain-005';
DELETE FROM "Domain" WHERE id = 'test-domain-005';

-- Verify
SELECT
  (SELECT COUNT(*) FROM users WHERE email LIKE 'test%005%@familiarise.com') AS users,
  (SELECT COUNT(*) FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-005') AS profiles,
  (SELECT COUNT(*) FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-005') AS weekly;
-- Expected: all zeros
```

---

## Verification Checklist (End-to-End)

| #   | Check                                                       | Expected       |
| --- | ----------------------------------------------------------- | -------------- |
| 1   | Create overnight slot (Fri->Sat) -> 201                     | 201            |
| 2   | Invalid overnight (non-adjacent days) -> 400                | 400            |
| 3   | Overnight with startTimeUtc <= endTimeUtc -> 400            | 400            |
| 4   | Update overnight slot times -> 200                          | 200            |
| 5   | Same-day basic overlap -> 409                               | 409            |
| 6   | Carry-over overlap (overnight into same-day) -> 409         | 409            |
| 7   | Starting-day overlap (same-day into overnight start) -> 409 | 409            |
| 8   | Two overnights on same start day -> 409                     | 409            |
| 9   | Non-overlapping different days -> 201                       | 201            |
| 10  | Bulk two overlapping overnights -> 400                      | 400            |
| 11  | Bulk overnight + overlapping same-day -> 400                | 400            |
| 12  | Bulk valid overnight + same-day -> 200                      | 200            |
| 13  | Book inside overnight start portion -> 200                  | 200            |
| 14  | Book inside overnight carry-over -> 200                     | 200            |
| 15  | Book outside overnight window -> rejection                  | non-200        |
| 16  | Custom overlapping bulk -> 400                              | 400            |
| 17  | Custom non-overlapping bulk -> 200                          | 200            |
| 18  | Update custom to overlap -> 409                             | 409            |
| 19  | Class session ending after period -> rejection              | non-200        |
| 20  | Class session within period -> 200                          | 200            |
| 21  | Cleanup complete                                            | All counts = 0 |

---

## Key Differences From Agents 001-004

- **IDs:** all use `-005` suffix (no collisions)
- **Focus:** exclusively **overnight/cross-midnight slots** and **overlap detection**
- **Overnight slots:** tests the 3-clause same-day and 5-clause overnight overlap WHERE builders
- **Carry-over overlap:** the most subtle bug — Mon 23:00->Tue 01:00 conflicting with Tue 00:30
- **Checkout guard:** verifies `isMinuteWithinWeeklySlot()` handles overnight correctly
- **Scheduling period boundary:** tests full interval validation (session ends after period)
- **Bulk pairwise overlap:** tests `slotsOverlap()` for in-memory overlap detection
