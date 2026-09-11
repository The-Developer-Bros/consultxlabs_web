# E2E Booking Algorithm Test — Agent 004: Auth, Ownership & Validation Hardening

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

You are a senior QA engineer. Your job is to run exhaustive end-to-end tests of
authorization, ownership verification, and cross-consultant rejection across all
write endpoints in the Familiarise booking system, using two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction + `fetch()` calls via `evaluate_script`

All test data uses the `-004` suffix to avoid collisions with existing `-001` / `-002` / `-003` seed data.

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

- `User` -> table: `"users"` (@@map)
- `Account` -> table: `"accounts"` (@@map)
- `Session` -> table: `"sessions"` (@@map)
- All others -> table name = Prisma model name (e.g. `"ConsultantProfile"`)
- Passwords -> bcrypt. Use the signup UI flow at `/auth/signup` for reliability.
- Timestamps -> `timestamptz` columns, stored as UTC
- `priceCurrency` (not `currency`) on `ConsultationPlan` / `SubscriptionPlan`
- `ConsulteeProfile` requires `userId` (NOT NULL) — create User first
- `SlotOfAvailabilityWeekly.startTimeUtc` / `endTimeUtc` are `Int @db.SmallInt` — **minutes since midnight UTC (0-1439)**, NOT timestamps. Example: 240 = 04:00 UTC, 690 = 11:30 UTC. `startDay`/`endDay` are `DayOfWeek` enums.
- `SlotOfAvailabilityCustom.startsAt` / `endsAt` are `DateTime @db.Timestamptz()` — actual timestamps for one-off availability

### Step 0.1 — Domain + SubDomain

```sql
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES ('test-domain-004', 'Auth & Ownership Testing', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES ('test-subdomain-004', 'Security Tests', 'test-domain-004', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2 — Consultant A (primary) — User + Profile

```
Name  : Consultant Alpha 004
Email : testconsultant004a@familiarise.com
Pass  : TestPassword004!
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
  'test-consultant-profile-004a',
  'Auth hardening test consultant A.',
  5.0, 4.5,
  'Auth Test Expert A',
  'WEEKLY',
  'test-domain-004',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant004a@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-004a'
WHERE email = 'testconsultant004a@familiarise.com';

-- Link profile to subdomain
INSERT INTO "_ConsultantProfileToSubDomain" ("A", "B")
VALUES ('test-consultant-profile-004a', 'test-subdomain-004')
ON CONFLICT DO NOTHING;

-- Verify
SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant004a@familiarise.com';
```

### Step 0.3 — Consultant B (adversary) — User + Profile

```
Name  : Consultant Beta 004
Email : testconsultant004b@familiarise.com
Pass  : TestPassword004!
```

**RECOMMENDED:** Use UI signup at `/auth/signup` as CONSULTANT role.

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
  'test-consultant-profile-004b',
  'Auth hardening test consultant B (adversary).',
  3.0, 4.0,
  'Auth Test Expert B',
  'WEEKLY',
  'test-domain-004',
  u.id,
  true, 'VERIFIED',
  90,
  NOW(), NOW()
FROM users u WHERE u.email = 'testconsultant004b@familiarise.com'
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-004b'
WHERE email = 'testconsultant004b@familiarise.com';

-- Verify
SELECT id, name, email, role, "consultantProfileId"
FROM users WHERE email = 'testconsultant004b@familiarise.com';
```

### Step 0.4 — Consultee User + Profile

```
Name  : Consultee Test 004
Email : testconsultee004@familiarise.com
Pass  : TestPassword004!
```

**RECOMMENDED:** Use UI signup at `/auth/signup` as CONSULTEE role.

After signup, run:

```sql
UPDATE "ConsulteeProfile"
SET goals = 'Probe auth and ownership boundaries.',
    "aboutMe"  = 'Testing auth and ownership hardening.'
FROM users u
WHERE "ConsulteeProfile"."userId" = u.id
  AND u.email = 'testconsultee004@familiarise.com';

SELECT cp.id as consultee_profile_id, u.id as user_id
FROM "ConsulteeProfile" cp
JOIN users u ON u.id = cp."userId"
WHERE u.email = 'testconsultee004@familiarise.com';
```

### Step 0.5 — Consultant A Availability Slots

```sql
-- Weekly: Mon-Fri 04:00-07:00 UTC (09:30-12:30 IST)
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w004a-mon', 'MONDAY',    240, 'MONDAY',    420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-tue', 'TUESDAY',   240, 'TUESDAY',   420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-wed', 'WEDNESDAY', 240, 'WEDNESDAY', 420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-thu', 'THURSDAY',  240, 'THURSDAY',  420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-fri', 'FRIDAY',    240, 'FRIDAY',    420, 'test-consultant-profile-004a', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Custom slot: next Saturday 04:30-10:30 UTC
INSERT INTO "SlotOfAvailabilityCustom" (
  id, "startsAt", "endsAt",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-c004a-sat',
  (date_trunc('week', NOW()) + INTERVAL '13 days' + INTERVAL '4 hours 30 minutes')::timestamptz,
  (date_trunc('week', NOW()) + INTERVAL '13 days' + INTERVAL '10 hours 30 minutes')::timestamptz,
  'test-consultant-profile-004a',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.6 — Consultant B Availability Slots

```sql
-- Weekly: Mon-Wed 08:30-11:30 UTC (14:00-17:00 IST)
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w004b-mon', 'MONDAY',    510, 'MONDAY',    690, 'test-consultant-profile-004b', NOW(), NOW()),
  ('test-w004b-tue', 'TUESDAY',   510, 'TUESDAY',   690, 'test-consultant-profile-004b', NOW(), NOW()),
  ('test-w004b-wed', 'WEDNESDAY', 510, 'WEDNESDAY', 690, 'test-consultant-profile-004b', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.7 — Plans for Consultant A Only

```sql
INSERT INTO "ConsultationPlan" (
  id, title, "durationInHours", price, "priceCurrency",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES (
  'test-consultation-plan-004a',
  'Auth Test Consultation',
  1.0, 1500, 'INR',
  'test-consultant-profile-004a',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.8 — Verify All Seed Data

```sql
SELECT id, headline FROM "ConsultantProfile" WHERE id IN ('test-consultant-profile-004a', 'test-consultant-profile-004b');
SELECT id, title FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-004a';
SELECT COUNT(*) as slot_count_a FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-004a';
SELECT COUNT(*) as slot_count_b FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-004b';
SELECT id, "startsAt", "endsAt" FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-004a';
```

**STOP and fix any missing rows before continuing.**

---

## Phase 1 — Authentication Setup

1. Navigate to `http://localhost:3000/auth/signin`
2. Login as CONSULTANT A: `testconsultant004a@familiarise.com` / `TestPassword004!`
3. `take_snapshot` — confirm you land on `/dashboard/consultant/test-consultant-profile-004a/home`
4. Logout
5. Login as CONSULTANT B: `testconsultant004b@familiarise.com` / `TestPassword004!`
6. `take_snapshot` — confirm you land on `/dashboard/consultant/test-consultant-profile-004b/home`
7. Logout
8. Login as CONSULTEE: `testconsultee004@familiarise.com` / `TestPassword004!`
9. `take_snapshot` — confirm you land on `/dashboard/consultee/...`
10. Logout

---

## Phase 2 — Weekly Availability CRUD Auth

### Test 2.1 — Unauthenticated POST to Weekly Slot

Log out first (ensure no session). Use `evaluate_script`:

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 360,
      endDay: "SATURDAY",
      endTimeUtc: 540,
      consultantProfileId: "test-consultant-profile-004a",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 401

### Test 2.2 — Unauthenticated PUT to Weekly Slot

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-mon",
    {
      method: "PUT",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDay: "MONDAY",
        startTimeUtc: 300,
        endDay: "MONDAY",
        endTimeUtc: 480,
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 401

### Test 2.3 — Unauthenticated PATCH to Weekly Slot

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-mon",
    {
      method: "PATCH",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startTimeUtc: 300 }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 401

### Test 2.4 — Unauthenticated DELETE to Weekly Slot

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-mon",
    {
      method: "DELETE",
      credentials: "omit",
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 401

### Test 2.5 — Cross-Consultant PUT (B modifies A's slot)

Login as CONSULTANT B. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-mon",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDay: "MONDAY",
        startTimeUtc: 300,
        endDay: "MONDAY",
        endTimeUtc: 480,
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403 — "Forbidden: you do not own this slot"

### Test 2.6 — Cross-Consultant PATCH (B patches A's slot)

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-mon",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startTimeUtc: 300 }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 2.7 — Cross-Consultant DELETE (B deletes A's slot)

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-mon",
    {
      method: "DELETE",
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 2.8 — Happy Path: Consultant A modifies own weekly slot

Login as CONSULTANT A. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-fri",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDay: "FRIDAY",
        startTimeUtc: 300,
        endDay: "FRIDAY",
        endTimeUtc: 480,
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200

DB verify:

```sql
SELECT "startTimeUtc", "endTimeUtc" FROM "SlotOfAvailabilityWeekly"
WHERE id = 'test-w004a-fri';
-- Expected: startTimeUtc=300, endTimeUtc=480
```

Restore original values:

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/weekly/test-w004a-fri",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startDay: "FRIDAY",
        startTimeUtc: 240,
        endDay: "FRIDAY",
        endTimeUtc: 420,
      }),
    },
  );
  return { status: response.status };
};
```

---

## Phase 3 — Custom Availability CRUD Auth

### Test 3.1 — Unauthenticated POST to Custom Slot

Log out. Then:

```javascript
async () => {
  const response = await fetch("/api/slots/availability/custom", {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      consultantProfileId: "test-consultant-profile-004a",
      startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86400000 + 3600000).toISOString(),
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 401

### Test 3.2 — Cross-Consultant PUT on Custom Slot (B modifies A's)

Login as CONSULTANT B. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/custom/test-c004a-sat",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        endsAt: new Date(Date.now() + 7 * 86400000 + 7200000).toISOString(),
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 3.3 — Cross-Consultant DELETE on Custom Slot (B deletes A's)

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/custom/test-c004a-sat",
    {
      method: "DELETE",
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 3.4 — PUT with Malformed Date String

Login as CONSULTANT A. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/custom/test-c004a-sat",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: "not-a-date",
        endsAt: "also-not-a-date",
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Invalid date format"

### Test 3.5 — PATCH with Invalid Date

```javascript
async () => {
  const response = await fetch(
    "/api/slots/availability/custom/test-c004a-sat",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsAt: "2026-13-45T99:99:99Z",
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Invalid date format"

---

## Phase 4 — Bulk Consultant Settings Auth Bypass

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

### Test 4.1 — Consultant B PUTs on Consultant A's Settings

Login as CONSULTANT B. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Hijacked by consultant B",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T04:00:00.000Z",
            endsAt: "2026-01-05T07:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 4.2 — Consultant B DELETEs Consultant A's Profile

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "DELETE",
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 4.3 — Consultee PUTs on Consultant A's Settings

Login as CONSULTEE. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Hijacked by consultee",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T04:00:00.000Z",
            endsAt: "2026-01-05T07:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 403

### Test 4.4 — Happy Path: Consultant A PUTs own Settings

Login as CONSULTANT A. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Updated by rightful owner",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T04:00:00.000Z",
            endsAt: "2026-01-05T07:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "WEDNESDAY",
            dayOfWeekforEndTimeInUTC: "WEDNESDAY",
            startsAt: "2026-01-07T04:00:00.000Z",
            endsAt: "2026-01-07T07:00:00.000Z",
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
SELECT description FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-004a';
-- Expected: 'Updated by rightful owner'
SELECT COUNT(*) as slot_count FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-004a';
-- Expected: 2 (bulk PUT replaces all slots)
```

Then restore original slots:

```sql
DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-004a';
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w004a-mon', 'MONDAY',    240, 'MONDAY',    420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-tue', 'TUESDAY',   240, 'TUESDAY',   420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-wed', 'WEDNESDAY', 240, 'WEDNESDAY', 420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-thu', 'THURSDAY',  240, 'THURSDAY',  420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-fri', 'FRIDAY',    240, 'FRIDAY',    420, 'test-consultant-profile-004a', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

UPDATE "ConsultantProfile" SET description = 'Auth hardening test consultant A.'
WHERE id = 'test-consultant-profile-004a';
```

---

## Phase 5 — Checkout Availability Ownership

### Test 5.1 — Checkout with Consultant A's Plan + Consultant B's Availability

Login as CONSULTEE. Try to book consultant A's plan at a time that only consultant B is available:

```javascript
async () => {
  // Tuesday 08:30 UTC — only in consultant B's window (510-690 = 08:30-11:30)
  // NOT in consultant A's window (240-420 = 04:00-07:00)
  const nextTue = new Date();
  nextTue.setDate(
    nextTue.getDate() + ((2 + 7 - nextTue.getDay()) % 7 || 7) + 7,
  );
  nextTue.setUTCHours(8, 30, 0, 0);

  const slotEnd = new Date(nextTue);
  slotEnd.setUTCHours(9, 30, 0, 0);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-004a",
      paymentGateway: "STRIPE",
      startsAt: nextTue.toISOString(),
      endsAt: slotEnd.toISOString(),
      // Consultant B's row, deliberately: the plan is A's.
      slotOfAvailabilityWeeklyId: "test-w004b-tue",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** Rejection (400 or similar) — the chosen slot is outside consultant A's availability window.

### Test 5.2 — Checkout with Consultant A's Plan + Consultant A's Availability

```javascript
async () => {
  // Tuesday 04:30 UTC — inside consultant A's window (240-420 = 04:00-07:00)
  const nextTue = new Date();
  nextTue.setDate(
    nextTue.getDate() + ((2 + 7 - nextTue.getDay()) % 7 || 7) + 7,
  );
  nextTue.setUTCHours(4, 30, 0, 0);

  const slotEnd = new Date(nextTue);
  slotEnd.setUTCHours(5, 30, 0, 0);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-004a",
      paymentGateway: "STRIPE",
      startsAt: nextTue.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-w004a-tue",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 — successful checkout

DB verify:

```sql
SELECT c."requestStatus", c."bookingSource"
FROM "Consultation" c
WHERE c."consultationPlanId" = 'test-consultation-plan-004a'
ORDER BY c."createdAt" DESC LIMIT 1;
-- Expected: requestStatus=SCHEDULED, bookingSource=DIRECT_CHECKOUT
```

---

## Phase 6 — Onboarding Validation

These tests verify the bulk settings endpoint validates slot overlaps and time ordering.

### Test 6.1 — Overlapping Weekly Slots via Bulk PUT

Login as CONSULTANT A. Then:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Auth hardening test consultant A.",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T04:00:00.000Z",
            endsAt: "2026-01-05T07:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T05:00:00.000Z",
            endsAt: "2026-01-05T08:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Submitted weekly slots contain overlapping time ranges"

### Test 6.2 — Invalid Time Ordering (startTimeUtc >= endTimeUtc same-day)

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Auth hardening test consultant A.",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T10:00:00.000Z",
            endsAt: "2026-01-05T08:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — "Start time must be before end time for same-day slots"

### Test 6.3 — Overlapping Custom Slots via Bulk PUT

```javascript
async () => {
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + 14);
  baseDate.setUTCHours(10, 0, 0, 0);

  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Auth hardening test consultant A.",
        experience: 5,
        scheduleType: "CUSTOM",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
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
              baseDate.getTime() + 2 * 3600000,
            ).toISOString(),
            endsAt: new Date(
              baseDate.getTime() + 5 * 3600000,
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

---

## Phase 7 — Bulk Settings Validation Bypass

### Test 7.1 — Bulk PUT Weekly with Overlapping Entries

This tests the same-set overlap check in the bulk route:

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Auth hardening test consultant A.",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "TUESDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-06T04:00:00.000Z",
            endsAt: "2026-01-06T07:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "TUESDAY",
            dayOfWeekforEndTimeInUTC: "TUESDAY",
            startsAt: "2026-01-06T06:00:00.000Z",
            endsAt: "2026-01-06T09:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400

### Test 7.2 — Bulk PUT Weekly with Invalid Time Ordering

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Auth hardening test consultant A.",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "WEDNESDAY",
            dayOfWeekforEndTimeInUTC: "WEDNESDAY",
            startsAt: "2026-01-07T10:00:00.000Z",
            endsAt: "2026-01-07T08:00:00.000Z",
          },
        ],
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400

### Test 7.3 — Bulk PUT Weekly with Valid Non-Overlapping Entries

```javascript
async () => {
  const response = await fetch(
    "/api/user/consultants/test-consultant-profile-004a",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Auth hardening test consultant A.",
        experience: 5,
        scheduleType: "WEEKLY",
        domainId: "test-domain-004",
        subDomainIds: ["test-subdomain-004"],
        tagIds: [],
        slotsOfAvailabilityWeekly: [
          {
            dayOfWeekforStartTimeInUTC: "MONDAY",
            dayOfWeekforEndTimeInUTC: "MONDAY",
            startsAt: "2026-01-05T04:00:00.000Z",
            endsAt: "2026-01-05T07:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "WEDNESDAY",
            dayOfWeekforEndTimeInUTC: "WEDNESDAY",
            startsAt: "2026-01-07T04:00:00.000Z",
            endsAt: "2026-01-07T07:00:00.000Z",
          },
          {
            dayOfWeekforStartTimeInUTC: "FRIDAY",
            dayOfWeekforEndTimeInUTC: "FRIDAY",
            startsAt: "2026-01-09T08:00:00.000Z",
            endsAt: "2026-01-09T11:00:00.000Z",
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
SELECT COUNT(*) as slot_count FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-004a';
-- Expected: 3
```

Restore original slots after this test:

```sql
DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-004a';
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId", "createdAt", "updatedAt"
)
VALUES
  ('test-w004a-mon', 'MONDAY',    240, 'MONDAY',    420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-tue', 'TUESDAY',   240, 'TUESDAY',   420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-wed', 'WEDNESDAY', 240, 'WEDNESDAY', 420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-thu', 'THURSDAY',  240, 'THURSDAY',  420, 'test-consultant-profile-004a', NOW(), NOW()),
  ('test-w004a-fri', 'FRIDAY',    240, 'FRIDAY',    420, 'test-consultant-profile-004a', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

---

## Phase 8 — Final Summary Query

```sql
SELECT
  'Consultant A Weekly Slots' AS label,
  COUNT(*) AS count
FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-004a'
UNION ALL
SELECT 'Consultant B Weekly Slots', COUNT(*)
FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-004b'
UNION ALL
SELECT 'Consultant A Custom Slots', COUNT(*)
FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-004a'
UNION ALL
SELECT 'Consultations Booked', COUNT(*)
FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-004a';
```

---

## Phase 9 — Cleanup

Run cleanup in dependency order ONLY after all tests pass:

```sql
-- Slots of appointments
DELETE FROM "_SlotOfAppointmentToUser"
WHERE "A" IN (
  SELECT s.id FROM "SlotOfAppointment" s
  JOIN "Appointment" a ON a.id = s."appointmentId"
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-004a')
);

DELETE FROM "SlotOfAppointment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-004a')
);

DELETE FROM "Payment"
WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  WHERE a."consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-004a')
);

DELETE FROM "Appointment"
WHERE "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-004a');

DELETE FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-004a';
DELETE FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-004a';

-- Availability
DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" IN ('test-consultant-profile-004a', 'test-consultant-profile-004b');
DELETE FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-004a';

-- Profiles + Users
UPDATE users SET "consultantProfileId" = NULL
WHERE email IN ('testconsultant004a@familiarise.com', 'testconsultant004b@familiarise.com');

DELETE FROM "_ConsultantProfileToSubDomain" WHERE "A" IN ('test-consultant-profile-004a', 'test-consultant-profile-004b');
DELETE FROM "ConsultantProfile" WHERE id IN ('test-consultant-profile-004a', 'test-consultant-profile-004b');

DELETE FROM "ConsulteeProfile" WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant004a@familiarise.com', 'testconsultant004b@familiarise.com', 'testconsultee004@familiarise.com')
);
DELETE FROM accounts WHERE "userId" IN (
  SELECT id FROM users WHERE email IN ('testconsultant004a@familiarise.com', 'testconsultant004b@familiarise.com', 'testconsultee004@familiarise.com')
);
DELETE FROM users WHERE email IN ('testconsultant004a@familiarise.com', 'testconsultant004b@familiarise.com', 'testconsultee004@familiarise.com');

-- Domain
DELETE FROM "SubDomain" WHERE id = 'test-subdomain-004';
DELETE FROM "Domain" WHERE id = 'test-domain-004';

-- Verify
SELECT
  (SELECT COUNT(*) FROM users WHERE email LIKE 'test%004%@familiarise.com') AS users,
  (SELECT COUNT(*) FROM "ConsultantProfile" WHERE id LIKE 'test-consultant-profile-004%') AS profiles,
  (SELECT COUNT(*) FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" LIKE 'test-consultant-profile-004%') AS weekly_slots;
-- Expected: all zeros
```

---

## Verification Checklist (End-to-End)

| #   | Check                                                  | Expected       |
| --- | ------------------------------------------------------ | -------------- |
| 1   | Unauthenticated POST/PUT/PATCH/DELETE to weekly -> 401 | 401 for all 4  |
| 2   | Cross-consultant PUT/PATCH/DELETE on weekly -> 403     | 403 for all 3  |
| 3   | Owner modifies own weekly slot -> 200                  | 200            |
| 4   | Unauthenticated POST to custom -> 401                  | 401            |
| 5   | Cross-consultant PUT/DELETE on custom -> 403           | 403 for both   |
| 6   | Malformed date in PUT/PATCH custom -> 400              | 400 for both   |
| 7   | Cross-consultant PUT/DELETE on bulk settings -> 403    | 403 for both   |
| 8   | Consultee PUT on bulk settings -> 403                  | 403            |
| 9   | Owner bulk PUT settings -> 200                         | 200            |
| 10  | Checkout outside owner's availability -> rejection     | non-200        |
| 11  | Checkout inside owner's availability -> success        | 200            |
| 12  | Overlapping weekly slots in bulk PUT -> 400            | 400            |
| 13  | Invalid time ordering in bulk PUT -> 400               | 400            |
| 14  | Overlapping custom slots in bulk PUT -> 400            | 400            |
| 15  | Valid non-overlapping bulk PUT -> 200                  | 200            |
| 16  | Cleanup complete                                       | All counts = 0 |

---

## Key Differences From Agents 001-003

- **IDs:** all use `-004` suffix (no collisions)
- **Two consultants:** A (primary) + B (adversary) for cross-ownership tests
- **Focus:** exclusively **authorization, ownership verification, cross-consultant rejection**
- **No Subscription/Webinar/Class tests** — single consultation plan to keep scope focused
- **Tests auth on EVERY HTTP method** for both weekly and custom slot CRUD
- **Tests bulk settings route** (onboarding equivalent) for auth bypass and validation bypass
- **Tests checkout ownership scoping** — wrong consultant's availability rejected
