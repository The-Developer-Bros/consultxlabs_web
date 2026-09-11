# E2E Booking Algorithm Test — Comprehensive Production-Grade Prompt

## Role & Mission

You are a **senior QA engineer** testing a production-grade expert services marketplace (Familiarise). Your job is to perform exhaustive end-to-end testing of the entire booking algorithm across all 4 event types: **Consultations**, **Subscriptions**, **Webinars**, and **Classes**.

You have access to two critical MCP tools:

1. **Supabase MCP** — for seeding mock data directly into PostgreSQL via `execute_sql`
2. **Chrome DevTools MCP** — for interacting with the app UI at `http://localhost:3000`

**Supabase Project ID: `pzmbxqdgibfkhjwzeprf`**

---

## CRITICAL RULES

1. **FIX BUGS IMMEDIATELY.** If you discover ANY bug during testing — broken UI, wrong API response, incorrect DB state, missing auth, wrong status transition — **STOP testing, fix the bug in the source code, verify the fix, and retest the entire flow from the beginning of that phase.** Do NOT continue testing and "come back to it later." Do NOT accumulate a bug list. Fix. Retest. Move on.

2. **Verify DB state after every operation.** After each significant action (request, approve, allocate, checkout, reschedule, cancel), use `execute_sql` to query the database and verify the expected state. Do not trust the UI alone.

3. **Test both happy path AND error paths.** For every flow, test what happens when things go RIGHT and when things go WRONG (unauthorized, invalid data, conflicts, etc.).

4. **Take snapshots liberally.** Use `take_snapshot` after every page navigation and before every interaction to understand the current UI state. Use `take_screenshot` when debugging visual issues.

5. **Use the correct Supabase project ID** for all MCP calls: `pzmbxqdgibfkhjwzeprf`

6. **The app runs at** `http://localhost:3000`. Assume the dev server is already running.

---

## PHASE 0: DATA SEEDING

Seed all test data using Supabase MCP `execute_sql`. Run each SQL block in order. **Do NOT use prisma seed scripts — use direct SQL only.**

### Important Schema Notes

- `User` model maps to table `users` (via `@@map("users")`)
- `Account` model maps to table `accounts` (via `@@map("accounts")`)
- `Session` model maps to table `sessions` (via `@@map("sessions")`)
- All other models use their Prisma model name as the table name (e.g., `ConsultantProfile`, `ConsulteeProfile`, `ConsultationPlan`, etc.)
- `cuid()` IDs look like: `clxyz123abc456` (use `gen_random_uuid()` or manual strings)
- `uuid()` IDs look like: `550e8400-e29b-41d4-a716-446655440000`
- DateTime fields with `@db.Timestamptz()` store as `timestamptz` in Postgres
- BetterAuth uses `accounts` table with `providerId = 'credential'` for email/password login
- Passwords are hashed with bcrypt — use a pre-hashed password
- `SlotOfAvailabilityWeekly.startTimeUtc` / `endTimeUtc` are `Int @db.SmallInt` — **minutes since midnight UTC (0-1439)**, NOT timestamps. Example: 270 = 04:30 UTC, 690 = 11:30 UTC. `startDay`/`endDay` are `DayOfWeek` enums.
- `SlotOfAvailabilityCustom.startsAt` / `endsAt` are `DateTime @db.Timestamptz()` — actual timestamps for one-off date-specific availability

### Step 0.1: Create Domain & SubDomain

```sql
-- Create a test domain for our consultant
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES (
  'test-domain-001',
  'Technology & Engineering',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES (
  'test-subdomain-001',
  'Software Engineering',
  'test-domain-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2: Create Consultant User + Profile

```sql
-- Create consultant user
-- Password: "TestPassword123!" (bcrypt hash below)
INSERT INTO users (
  id, name, email, "emailVerified", role,
  "onboardingCompleted", timezone,
  "createdAt", "updatedAt"
)
VALUES (
  'test-consultant-user-001',
  'Dr. Arjun Test Consultant',
  'testconsultant@familiarise.com',
  true, 'CONSULTANT',
  true, 'Asia/Kolkata',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Create consultant profile
INSERT INTO "ConsultantProfile" (
  id, description, experience, rating,
  headline, "scheduleType",
  "domainId", "userId",
  "isVerified", "verificationStatus",
  "profileCompletionPercentage",
  "createdAt", "updatedAt"
)
VALUES (
  'test-consultant-profile-001',
  'Senior software engineer with 10+ years of experience in full-stack development, system design, and mentoring.',
  10.0, 4.8,
  'Full-Stack Engineering Mentor',
  'WEEKLY',
  'test-domain-001',
  'test-consultant-user-001',
  true, 'VERIFIED',
  85,
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Link profile back to user
UPDATE users
SET "consultantProfileId" = 'test-consultant-profile-001'
WHERE id = 'test-consultant-user-001';

-- Create BetterAuth account for consultant (credential provider)
INSERT INTO accounts (
  id, "userId", "accountId", "providerId",
  password,
  "createdAt", "updatedAt"
)
VALUES (
  'test-account-consultant-001',
  'test-consultant-user-001',
  'test-consultant-user-001',
  'credential',
  '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ12', -- placeholder hash
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

**IMPORTANT:** The bcrypt hash above is a placeholder. You need to generate a real one. Use `execute_sql` to call:

```sql
-- Generate a proper bcrypt hash for "TestPassword123!"
-- If pgcrypto extension is available:
SELECT gen_salt('bf', 10);
```

Or alternatively, use the app's signup flow via Chrome DevTools to create the accounts (more reliable for BetterAuth compatibility). **Recommended approach:**

1. Navigate to `http://localhost:3000/auth/signup`
2. Sign up as consultant: `testconsultant@familiarise.com` / `TestPassword123!`
3. Complete onboarding as CONSULTANT
4. Then create the profile data via SQL

**However**, if you want pure SQL seeding, you can also create a session directly:

```sql
-- Create a session token for the consultant (bypasses password)
INSERT INTO sessions (
  id, token, "userId", "expiresAt",
  "createdAt", "updatedAt"
)
VALUES (
  'test-session-consultant-001',
  'test-session-token-consultant-' || gen_random_uuid()::text,
  'test-consultant-user-001',
  NOW() + INTERVAL '7 days',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.3: Create Consultee User + Profile

```sql
-- Create consultee user
INSERT INTO users (
  id, name, email, "emailVerified", role,
  "onboardingCompleted", timezone,
  "createdAt", "updatedAt"
)
VALUES (
  'test-consultee-user-001',
  'Priya Test Consultee',
  'testconsultee@familiarise.com',
  true, 'CONSULTEE',
  true, 'Asia/Kolkata',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Create consultee profile
INSERT INTO "ConsulteeProfile" (
  id, "aboutMe", goals,
  "careerStage",
  "userId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-consultee-profile-001',
  'Looking to level up my system design and architecture skills.',
  'Ship a distributed system end to end.',
  'MID_CAREER',
  'test-consultee-user-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Link profile back to user
UPDATE users
SET "consulteeProfileId" = 'test-consultee-profile-001'
WHERE id = 'test-consultee-user-001';

-- Create BetterAuth account for consultee
INSERT INTO accounts (
  id, "userId", "accountId", "providerId",
  password,
  "createdAt", "updatedAt"
)
VALUES (
  'test-account-consultee-001',
  'test-consultee-user-001',
  'test-consultee-user-001',
  'credential',
  '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ12', -- same placeholder
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.4: Create Consultant Availability Slots

Create weekly availability for the consultant: Monday-Friday, 10:00-17:00 IST (04:30-11:30 UTC).

```sql
-- Weekly availability: Monday-Friday, split into AM + PM blocks
-- Times stored as Int minutes since midnight UTC (0-1439)
-- Conversion: 10:00-13:00 IST = 04:30-07:30 UTC = 270-450 min
--             14:00-17:00 IST = 08:30-11:30 UTC = 510-690 min
INSERT INTO "SlotOfAvailabilityWeekly" (
  id, "startDay", "startTimeUtc", "endDay", "endTimeUtc",
  "consultantProfileId",
  "createdAt", "updatedAt"
)
VALUES
  -- Monday 10:00-13:00 IST = 04:30-07:30 UTC = 270-450 min
  ('test-weekly-slot-mon-am', 'MONDAY', 270, 'MONDAY', 450, 'test-consultant-profile-001', NOW(), NOW()),
  -- Monday 14:00-17:00 IST = 08:30-11:30 UTC = 510-690 min
  ('test-weekly-slot-mon-pm', 'MONDAY', 510, 'MONDAY', 690, 'test-consultant-profile-001', NOW(), NOW()),
  -- Tuesday AM
  ('test-weekly-slot-tue-am', 'TUESDAY', 270, 'TUESDAY', 450, 'test-consultant-profile-001', NOW(), NOW()),
  -- Tuesday PM
  ('test-weekly-slot-tue-pm', 'TUESDAY', 510, 'TUESDAY', 690, 'test-consultant-profile-001', NOW(), NOW()),
  -- Wednesday AM
  ('test-weekly-slot-wed-am', 'WEDNESDAY', 270, 'WEDNESDAY', 450, 'test-consultant-profile-001', NOW(), NOW()),
  -- Wednesday PM
  ('test-weekly-slot-wed-pm', 'WEDNESDAY', 510, 'WEDNESDAY', 690, 'test-consultant-profile-001', NOW(), NOW()),
  -- Thursday AM
  ('test-weekly-slot-thu-am', 'THURSDAY', 270, 'THURSDAY', 450, 'test-consultant-profile-001', NOW(), NOW()),
  -- Thursday PM
  ('test-weekly-slot-thu-pm', 'THURSDAY', 510, 'THURSDAY', 690, 'test-consultant-profile-001', NOW(), NOW()),
  -- Friday AM
  ('test-weekly-slot-fri-am', 'FRIDAY', 270, 'FRIDAY', 450, 'test-consultant-profile-001', NOW(), NOW()),
  -- Friday PM
  ('test-weekly-slot-fri-pm', 'FRIDAY', 510, 'FRIDAY', 690, 'test-consultant-profile-001', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Also create one custom availability slot (for a specific date, e.g., next Saturday)
-- Custom slots use actual timestamps (DateTime @db.Timestamptz), not minutes
INSERT INTO "SlotOfAvailabilityCustom" (
  id, "startsAt", "endsAt",
  "consultantProfileId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-custom-slot-001',
  (DATE_TRUNC('week', NOW()) + INTERVAL '12 days' + INTERVAL '4 hours 30 minutes')::timestamptz,  -- Next-next Saturday 10:00 IST
  (DATE_TRUNC('week', NOW()) + INTERVAL '12 days' + INTERVAL '10 hours 30 minutes')::timestamptz,  -- Next-next Saturday 16:00 IST
  'test-consultant-profile-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.5: Create Plans (All 4 Types)

```sql
-- CONSULTATION PLAN (1-on-1, 1 hour, INR 1500)
INSERT INTO "ConsultationPlan" (
  id, title, description, "durationInHours", price, "priceCurrency",
  language, level, prerequisites, "materialProvided",
  "consultantProfileId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-consultation-plan-001',
  'System Design Deep Dive',
  'A 1-hour deep dive into system design principles, covering scalability, reliability, and real-world architecture patterns.',
  1.0, 1500, 'INR',
  'English', 'Intermediate', 'Basic understanding of distributed systems', 'Design templates and cheat sheets',
  'test-consultant-profile-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- SUBSCRIPTION PLAN (4 sessions over 1 month, 1 call/week, 1 hour each, INR 5000)
INSERT INTO "SubscriptionPlan" (
  id, title, description,
  "durationInMonths", price, "priceCurrency",
  "sessionsPerWeek", "sessionDurationInHours", "totalSessions", "totalHours",
  "emailSupport", language, level,
  "trialEnabled", "trialDurationMinutes",
  "consultantProfileId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-subscription-plan-001',
  'Full-Stack Mentorship Program',
  'A 4-week mentorship program covering frontend, backend, databases, and deployment. Weekly 1-hour sessions with email support.',
  1, 5000, 'INR',
  1, 1.0, 4, 4.0,
  'PRIORITY', 'English', 'Intermediate',
  true, 30,
  'test-consultant-profile-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- WEBINAR PLAN (2-hour webinar, INR 500, max 50 participants)
INSERT INTO "WebinarPlan" (
  id, title, description, price, "priceCurrency",
  "certificateProvided", "recordingEnabled",
  "durationInHours", "maxParticipants",
  language, level,
  "consultantProfileId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-webinar-plan-001',
  'Microservices Architecture Masterclass',
  'A comprehensive 2-hour webinar on building production-grade microservices. Covers service decomposition, communication patterns, and deployment strategies.',
  500, 'INR',
  true, true,
  2.0, 50,
  'English', 'Advanced',
  'test-consultant-profile-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- CLASS PLAN (8 sessions over 2 months, 2 meetings/week, 1.5 hours each, INR 8000, max 20)
INSERT INTO "ClassPlan" (
  id, title, description, price, "priceCurrency",
  "certificateProvided", "recordingEnabled",
  "durationInMonths", "sessionsPerWeek",
  "sessionDurationInHours", "totalSessions", "totalHours",
  "emailSupport", "maxParticipants",
  language, level,
  "consultantProfileId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-class-plan-001',
  'Backend Engineering Bootcamp',
  'An 8-session intensive bootcamp covering Node.js, PostgreSQL, Redis, API design, authentication, and deployment. Hands-on projects in every session.',
  8000, 'INR',
  true, true,
  2, 2,
  1.5, 8, 12.0,
  'DEDICATED', 20,
  'English', 'Intermediate',
  'test-consultant-profile-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.6: Create Webinar & Class Instances

Webinars and Classes need actual instances (not just plans) for consultees to register:

```sql
-- Create a WEBINAR instance
INSERT INTO "Webinar" (
  id, status, "webinarPlanId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-webinar-001',
  'SCHEDULED',
  'test-webinar-plan-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Create a CLASS instance with scheduling period (next 2 months)
INSERT INTO "Class" (
  id, status,
  "schedulingPeriodStartsAt", "schedulingPeriodEndsAt",
  "schedulingTimezone",
  "classPlanId",
  "createdAt", "updatedAt"
)
VALUES (
  'test-class-001',
  'SCHEDULED',
  NOW()::timestamptz,
  (NOW() + INTERVAL '2 months')::timestamptz,
  'Asia/Kolkata',
  'test-class-plan-001',
  NOW(), NOW()
)
ON CONFLICT (id) DO NOTHING;
```

### Step 0.7: Verify Seed Data

Run these verification queries to confirm everything was seeded correctly:

```sql
-- Verify users
SELECT id, name, email, role, "consultantProfileId", "consulteeProfileId" FROM users WHERE id LIKE 'test-%';

-- Verify profiles
SELECT id, headline, "scheduleType", "userId" FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-001';
SELECT id, "aboutMe", goals, "careerStage", "userId" FROM "ConsulteeProfile" WHERE id = 'test-consultee-profile-001';
-- goals must read 'Ship a distributed system end to end.'; a null here means the
-- profile predates this seed and later booking assertions run on stale data.

-- Verify availability (weekly uses Int minutes 0-1439, custom uses timestamptz)
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc" FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-001';
SELECT id, "startsAt", "endsAt" FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-001';

-- Verify plans
SELECT id, title, price, "durationInHours" FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-001';
SELECT id, title, price, "sessionsPerWeek", "totalSessions", "durationInMonths" FROM "SubscriptionPlan" WHERE id = 'test-subscription-plan-001';
SELECT id, title, price, "maxParticipants", "durationInHours" FROM "WebinarPlan" WHERE id = 'test-webinar-plan-001';
SELECT id, title, price, "maxParticipants", "sessionsPerWeek", "totalSessions" FROM "ClassPlan" WHERE id = 'test-class-plan-001';

-- Verify webinar/class instances
SELECT id, status, "webinarPlanId" FROM "Webinar" WHERE id = 'test-webinar-001';
SELECT id, status, "classPlanId", "schedulingPeriodStartsAt", "schedulingPeriodEndsAt" FROM "Class" WHERE id = 'test-class-001';

-- Verify accounts
SELECT id, "userId", "providerId" FROM accounts WHERE "userId" LIKE 'test-%';
```

**If any query returns 0 rows, debug and re-insert before proceeding.**

---

## PHASE 1: CONSULTATION TESTING

### Overview

Consultations are 1-on-1 sessions. One consultee books one time slot with one consultant. The flow is:

1. Consultee requests (or directly checks out) → PENDING
2. Consultant reviews → APPROVED (or REJECTED)
3. Slots allocated → SCHEDULED
4. Payment → CONFIRMED

### Test 1.1: Login as Consultee

1. Navigate to `http://localhost:3000/auth/signin`
2. Take a snapshot to see the login form
3. Fill email: `testconsultee@familiarise.com`
4. Fill password: `TestPassword123!`
5. Click "Sign in"
6. Wait for redirect to `/dashboard` or `/dashboard/consultee/...`
7. Take a snapshot to verify successful login
8. **Verify:** The dashboard loads with the consultee's name visible

**If login fails** (likely because the BetterAuth password hash wasn't set correctly):

- Navigate to `http://localhost:3000/auth/signup`
- Sign up with `testconsultee@familiarise.com` / `TestPassword123!`
- Complete the onboarding flow (select CONSULTEE role, fill required fields)
- Then update the ConsulteeProfile data via SQL
- Similarly, sign up the consultant account: `testconsultant@familiarise.com` / `TestPassword123!`

### Test 1.2: REQUEST_SUBMITTED Flow — Consultee Requests a Consultation

1. Navigate to `http://localhost:3000/explore/experts/test-consultant-profile-001`
2. Take a snapshot to see the consultant's profile page
3. **Verify:** The consultant's name, headline, description, and consultation plan are visible
4. Find the consultation plan card ("System Design Deep Dive" — INR 1500)
5. Look for available time slots on the consultant's availability calendar
6. Select an available slot that falls within the consultant's weekly availability (Mon-Fri, 10:00-17:00 IST)
7. Click "Book" or "Request Consultation" (whatever the CTA says)
8. Take a snapshot to see the booking/checkout page
9. **Verify:** The checkout page shows:
   - Plan name: "System Design Deep Dive"
   - Duration: 1 hour
   - Price: INR 1,500
   - Selected time slot
   - Payment options

**For REQUEST_SUBMITTED flow:** If there's a "Request" button (vs direct checkout), click it to submit a request without payment.

10. After submitting the request, verify DB state:

```sql
-- Check that a consultation was created with PENDING status
SELECT c.id, c."requestStatus", c."bookingSource", c."requestedById",
       cp.title as "planTitle"
FROM "Consultation" c
JOIN "ConsultationPlan" cp ON c."consultationPlanId" = cp.id
WHERE c."requestedById" = 'test-consultee-profile-001'
ORDER BY c."createdAt" DESC
LIMIT 1;

-- Check that an appointment with tentative slot was created
SELECT a.id as "appointmentId", a."appointmentType",
       soa.id as "slotId", soa."startsAt", soa."endsAt", soa."isTentative"
FROM "Appointment" a
JOIN "SlotOfAppointment" soa ON soa."appointmentId" = a.id
WHERE a."consultationId" = (
  SELECT id FROM "Consultation"
  WHERE "requestedById" = 'test-consultee-profile-001'
  ORDER BY "createdAt" DESC LIMIT 1
);
```

**Expected:**

- Consultation `requestStatus` = `PENDING`
- Appointment `appointmentType` = `CONSULTATION`
- SlotOfAppointment `isTentative` = `true`

### Test 1.3: Consultant Login & Review Request

1. **Log out** from the consultee account:
   - Navigate to settings or find a logout button
   - OR clear cookies via Chrome DevTools: `evaluate_script` with `document.cookie.split(';').forEach(c => document.cookie = c.trim().split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/')`
   - OR navigate to `http://localhost:3000/auth/signin` directly

2. Log in as consultant: `testconsultant@familiarise.com` / `TestPassword123!`
3. Navigate to: `http://localhost:3000/dashboard/consultant/test-consultant-profile-001/requests`
4. Take a snapshot
5. **Verify:** The "Requests" tab shows the pending consultation from Priya
6. The request card should show:
   - Consultee name: "Priya Test Consultee"
   - Plan: "System Design Deep Dive"
   - Status: PENDING badge
   - Requested time slot
   - Accept/Decline buttons

### Test 1.4: View Requested Slots Dialog

1. Click on the request card or the "View Slots" / "Allocate" button
2. The `RequestedSlotsDialog` should open
3. Take a snapshot of the dialog
4. **Verify the dialog shows:**
   - Total slots count
   - Available slots (green checkmark) — slots within availability
   - Conflicting slots (red circle) — if any conflicts exist
   - Outside availability (yellow circle) — if slot is outside configured availability
   - A "Confirm" or "Approve" button

### Test 1.5: Accept & Allocate with PRE-ALLOCATE (Requested Slots)

1. In the RequestedSlotsDialog, click "Confirm" to approve using the consultee's requested times
2. Wait for success toast/feedback
3. Take a snapshot
4. **Verify DB state:**

```sql
-- Consultation should now be APPROVED or SCHEDULED
SELECT id, "requestStatus"
FROM "Consultation"
WHERE "requestedById" = 'test-consultee-profile-001'
  AND "consultationPlanId" = 'test-consultation-plan-001'
ORDER BY "createdAt" DESC
LIMIT 1;

-- Slots should no longer be tentative
SELECT soa.id, soa."startsAt", soa."endsAt", soa."isTentative"
FROM "SlotOfAppointment" soa
JOIN "Appointment" a ON soa."appointmentId" = a.id
WHERE a."consultationId" = (
  SELECT id FROM "Consultation"
  WHERE "requestedById" = 'test-consultee-profile-001'
  ORDER BY "createdAt" DESC LIMIT 1
);
```

**Expected:**

- `requestStatus` = `APPROVED` or `APPROVED_PENDING_PAYMENT`
- `isTentative` = `false`

### Test 1.6: Decline a Consultation Request

1. Create a second consultation request (repeat Test 1.2 with a different time slot, logging back in as consultee first)
2. Log in as consultant
3. Go to Requests tab
4. Find the new request
5. Click "Decline" or "Reject"
6. **Verify DB state:**

```sql
SELECT id, "requestStatus"
FROM "Consultation"
WHERE "requestedById" = 'test-consultee-profile-001'
  AND "requestStatus" = 'REJECTED'
ORDER BY "createdAt" DESC
LIMIT 1;
```

### Test 1.7: DIRECT_CHECKOUT Flow with Mock Payment

1. Log in as consultee
2. Navigate to `http://localhost:3000/checkout/plans/consultation/test-consultation-plan-001`
3. OR navigate via the expert profile page and click directly on a slot with "Book Now" behavior
4. Take a snapshot of the checkout page
5. **Verify checkout page shows:** Plan details, price, slot selection, payment method selector
6. Select a time slot within consultant's availability
7. Select payment gateway (Razorpay or Stripe)

**For mock payment testing via API** (since the UI may require actual gateway integration):

```bash
# Call the checkout API directly with isMockPayment=true
# First, get a valid session cookie by logging in via the UI, then:
```

Use Chrome DevTools `evaluate_script` to make the checkout API call:

```javascript
async () => {
  // Calculate a slot time in the future (next Monday at 10:30 IST = 05:00 UTC)
  const nextMonday = new Date();
  nextMonday.setDate(
    nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7),
  );
  nextMonday.setUTCHours(5, 0, 0, 0); // 10:30 IST

  const slotEnd = new Date(nextMonday);
  slotEnd.setUTCHours(6, 0, 0, 0); // 11:30 IST (1 hour later)

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-001",
      paymentGateway: "STRIPE",
      startsAt: nextMonday.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-weekly-slot-mon-am",
      isMockPayment: true,
    }),
  });

  return await response.json();
};
```

8. **Verify the response:** Should contain `success: true`, `appointmentId`, `isMockPayment: true`
9. **Verify DB state:**

```sql
-- Check consultation created with direct checkout
SELECT c.id, c."requestStatus", c."bookingSource",
       p.id as "paymentId", p."paymentStatus", p."isMockPayment"
FROM "Consultation" c
JOIN "Appointment" a ON a."consultationId" = c.id
LEFT JOIN "Payment" p ON p."appointmentId" = a.id
WHERE c."consultationPlanId" = 'test-consultation-plan-001'
  AND c."bookingSource" = 'DIRECT_CHECKOUT'
ORDER BY c."createdAt" DESC
LIMIT 1;
```

**Expected:**

- `bookingSource` = `DIRECT_CHECKOUT`
- `paymentStatus` = `SUCCEEDED` (mock payment succeeds immediately)
- `isMockPayment` = `true`

### Test 1.8: Manual Allocation by Consultant

1. Create another request (as consultee)
2. Log in as consultant
3. Go to Requests tab
4. Instead of clicking "Confirm" on the requested times, click "Allocate Manually" or open the calendar
5. The `UnifiedCalendar` component should open
6. Take a snapshot of the calendar
7. **Verify the calendar shows:**
   - Week view with time slots
   - Consultant's availability highlighted
   - Already-allocated slots shown as occupied
8. Click on an available slot to SELECT it
9. Take a snapshot — the slot should appear highlighted/selected
10. Click on the same slot again to DESELECT it
11. **Verify** the slot returns to its unselected state
12. Select a different slot
13. Click "Confirm" / "Allocate"
14. **Verify DB:** The consultation now has the manually-selected slot (not the originally requested one)

### Test 1.9: Auto-Allocation by Consultant

1. Create another consultation request
2. Log in as consultant
3. Go to Requests tab
4. Click "Auto Allocate" on the request
5. The system should automatically find the first available slot
6. **Verify DB:** An appointment was created with `isTentative = false` and slots within the consultant's availability window

---

## PHASE 2: SUBSCRIPTION TESTING

### Overview

Subscriptions are multi-session bookings. A consultee gets `sessionsPerWeek` sessions over `durationInMonths`. Our test plan: 4 sessions over 1 month, 1 call/week, 1 hour each.

### Test 2.1: Request a Subscription (REQUEST_SUBMITTED)

1. Log in as consultee
2. Navigate to consultant's profile page
3. Find the subscription plan ("Full-Stack Mentorship Program" — INR 5,000)
4. Click "Subscribe" or "Request"
5. Select a scheduling period (the next month from today)
6. Submit the request
7. **Verify DB:**

```sql
SELECT s.id, s."requestStatus", s."bookingSource",
       s."schedulingPeriodStartsAt", s."schedulingPeriodEndsAt",
       sp.title, sp."sessionsPerWeek", sp."totalSessions"
FROM "Subscription" s
JOIN "SubscriptionPlan" sp ON s."subscriptionPlanId" = sp.id
WHERE s."requestedById" = 'test-consultee-profile-001'
ORDER BY s."createdAt" DESC
LIMIT 1;
```

**Expected:** `requestStatus` = `PENDING`, `sessionsPerWeek` = 1, `totalSessions` = 4

### Test 2.2: Consultant Auto-Allocates Subscription Slots

1. Log in as consultant
2. Go to Requests tab
3. Find the subscription request
4. Click "Auto Allocate"
5. The system should distribute 4 sessions across 4 weeks (1 per week)
6. **Verify DB:**

```sql
-- Check all appointments created for the subscription
SELECT a.id, a."appointmentType",
       soa.id as "slotId", soa."startsAt", soa."endsAt", soa."isTentative"
FROM "Appointment" a
JOIN "SlotOfAppointment" soa ON soa."appointmentId" = a.id
WHERE a."subscriptionId" = (
  SELECT id FROM "Subscription"
  WHERE "requestedById" = 'test-consultee-profile-001'
  ORDER BY "createdAt" DESC LIMIT 1
)
ORDER BY soa."startsAt" ASC;
```

**Expected:**

- 4 appointments, each with 2 slots (30 min each = 1 hour total)
- OR 4 appointments with appropriate slot groupings
- All slots within the scheduling period
- No more than 1 call per Sunday-Saturday week
- All `isTentative` = `false`

### Test 2.3: Consultant Manual-Allocates Subscription Slots

1. Create a new subscription request
2. Log in as consultant
3. Open the calendar allocator for this subscription
4. Take a snapshot — the calendar should show:
   - Week navigation
   - Scheduling period boundaries (blue highlights)
   - Already-occupied slots (from previous allocations)
5. Select 4 slots across 4 different weeks (one per week)
6. **Verify:** Selecting a 2nd slot in the same week shows a warning about exceeding `sessionsPerWeek` limit
7. Confirm allocation
8. **Verify DB:** 4 sessions allocated, all within scheduling period, one per week

### Test 2.4: Subscription Weekly Limit Enforcement

1. During manual allocation, try to select 2 slots in the same week
2. **Expected:** The UI should show a warning or prevent the second selection
3. Try to submit anyway
4. **Expected:** Validation error about exceeding weekly call limit

### Test 2.5: Subscription Outside Scheduling Period Warning

1. During manual allocation, try to select a slot outside the scheduling period
2. **Expected:** The slot should show an "Outside Scheduling Period" indicator (blue highlight)
3. The RequestedSlotsDialog should show the "Outside period" count

### Test 2.6: Direct Checkout Subscription with Mock Payment

Use Chrome DevTools `evaluate_script`:

```javascript
async () => {
  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() + 1);
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "SUBSCRIPTION",
      planId: "test-subscription-plan-001",
      paymentGateway: "STRIPE",
      schedulingPeriodStartsAt: periodStart.toISOString(),
      schedulingPeriodEndsAt: periodEnd.toISOString(),
      isMockPayment: true,
    }),
  });

  return await response.json();
};
```

**Verify:** Subscription created, payment SUCCEEDED, `bookingSource` = `DIRECT_CHECKOUT`

### Test 2.7: Partial Reschedule (Individual Session)

1. After having an allocated subscription (from Test 2.2 or 2.3):
2. Get a specific slot ID from the subscription:

```sql
SELECT soa.id as "slotId", soa."startsAt", soa."endsAt", a.id as "appointmentId"
FROM "SlotOfAppointment" soa
JOIN "Appointment" a ON soa."appointmentId" = a.id
WHERE a."subscriptionId" = (
  SELECT id FROM "Subscription"
  WHERE "requestedById" = 'test-consultee-profile-001'
    AND "requestStatus" IN ('APPROVED', 'SCHEDULED')
  ORDER BY "createdAt" DESC LIMIT 1
)
ORDER BY soa."startsAt" ASC;
```

3. Call reschedule API with a specific slotId:

```javascript
async () => {
  const appointmentId = "<APPOINTMENT_ID_FROM_QUERY>";
  const response = await fetch(
    `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slotIds: ["<SLOT_ID_FROM_QUERY>"],
      }),
    },
  );
  return await response.json();
};
```

4. **Verify:**
   - Response: `rescheduleType` = `individual_session`, `slotsAffected` = 1
   - Only the specified slot has `isTentative` = `true`
   - All other slots remain `isTentative` = `false`
   - Subscription `requestStatus` reverted to `PENDING`

### Test 2.8: Full Subscription Reschedule

1. Call reschedule without slotIds:

```javascript
async () => {
  const appointmentId = "<APPOINTMENT_ID>";
  const response = await fetch(
    `/api/appointments/${appointmentId}/reschedule?type=SUBSCRIPTION`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return await response.json();
};
```

2. **Verify:**
   - Response: `rescheduleType` = `entire_booking`
   - ALL slots across ALL appointments in the subscription are `isTentative` = `true`
   - Subscription status = `PENDING`

---

## PHASE 3: WEBINAR TESTING

### Overview

Webinars are group events with a fixed time and a per-instance participant limit. The consultant creates the event; consultees register via checkout. A full webinar is sold out — there is no queue.

### Test 3.1: Allocate Webinar Time Slot (Consultant)

1. Log in as consultant
2. Navigate to the Planner page: `http://localhost:3000/dashboard/consultant/test-consultant-profile-001/planner`
3. Find the webinar plan ("Microservices Architecture Masterclass")
4. Allocate a time slot for the webinar (e.g., next Wednesday 14:00-16:00 IST)
5. **OR** via API:

```javascript
async () => {
  const nextWed = new Date();
  nextWed.setDate(nextWed.getDate() + ((3 + 7 - nextWed.getDay()) % 7 || 7));
  nextWed.setUTCHours(8, 30, 0, 0); // 14:00 IST

  const slotEnd = new Date(nextWed);
  slotEnd.setUTCHours(10, 30, 0, 0); // 16:00 IST (2 hours)

  const response = await fetch(
    "/api/bookings/webinars/test-webinar-001/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isAuto: false,
        slots: [nextWed.toISOString()],
      }),
    },
  );
  return await response.json();
};
```

6. **Verify DB:**

```sql
SELECT a.id, soa."startsAt", soa."endsAt", soa."isTentative"
FROM "Appointment" a
JOIN "SlotOfAppointment" soa ON soa."appointmentId" = a.id
WHERE a."webinarId" = 'test-webinar-001';
```

### Test 3.2: Consultee Registers for Webinar (Mock Checkout)

1. Log in as consultee
2. Navigate to webinar registration page or use API:

```javascript
async () => {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "WEBINAR",
      planId: "test-webinar-plan-001",
      eventId: "test-webinar-001",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return await response.json();
};
```

3. **Verify:**
   - Payment created with SUCCEEDED status
   - Consultee linked to webinar appointment

### Test 3.3: Webinar Capacity

This requires multiple consultee accounts. If testing capacity:

1. Check current participant count
2. Create additional test consultees via SQL and make checkout calls until `maxParticipants` (50) is reached
3. The next checkout attempt should fail with "Webinar is full"

```sql

```

### Test 3.4: Webinar Reschedule (Consultant Only)

1. Log in as consultant
2. Call reschedule on the webinar's appointment:

```javascript
async () => {
  // Get the appointment ID first
  const apptQuery = await fetch(
    "/api/slots/appointments?webinarId=test-webinar-001",
  );
  const apptData = await apptQuery.json();
  const appointmentId = apptData.data?.[0]?.id;
  if (!appointmentId) return { error: "No appointment found" };

  const response = await fetch(
    `/api/appointments/${appointmentId}/reschedule?type=WEBINAR`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return await response.json();
};
```

3. **Verify:** Only works when logged in as consultant (not consultee)

### Test 3.5: Consultee Cannot Reschedule Webinar

1. Log in as consultee
2. Try to reschedule the webinar
3. **Expected:** 403 Forbidden — "You are not authorized to reschedule this appointment"

---

## PHASE 4: CLASS TESTING

### Overview

Classes are structured multi-session group events. Similar to subscriptions but with multiple participants. Our test plan: 8 sessions over 2 months, 2/week, 1.5 hours each.

### Test 4.1: Allocate Class Sessions (Consultant)

1. Log in as consultant
2. Navigate to Planner or use API to allocate 8 sessions:

```javascript
async () => {
  // Generate 8 slot times: 2 per week for 4 weeks (Tue + Thu at 14:00 IST)
  const slots = [];
  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() + ((2 + 7 - baseDate.getDay()) % 7 || 7)); // Next Tuesday
  baseDate.setUTCHours(8, 30, 0, 0); // 14:00 IST

  for (let week = 0; week < 4; week++) {
    // Tuesday slot
    const tue = new Date(baseDate);
    tue.setDate(tue.getDate() + week * 7);
    slots.push(tue.toISOString());

    // Thursday slot (2 days after Tuesday)
    const thu = new Date(tue);
    thu.setDate(thu.getDate() + 2);
    slots.push(thu.toISOString());
  }

  const response = await fetch(
    "/api/bookings/classes/test-class-001/allocate",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isAuto: false,
        slots: slots,
      }),
    },
  );
  return await response.json();
};
```

2. **Verify DB:**

```sql
SELECT a.id, soa."startsAt", soa."endsAt"
FROM "Appointment" a
JOIN "SlotOfAppointment" soa ON soa."appointmentId" = a.id
WHERE a."classId" = 'test-class-001'
ORDER BY soa."startsAt" ASC;
```

**Expected:** 8 session slots, 2 per week, each 1.5 hours

### Test 4.2: Consultee Enrolls in Class (Mock Checkout)

```javascript
async () => {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CLASS",
      planId: "test-class-plan-001",
      eventId: "test-class-001",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return await response.json();
};
```

### Test 4.3: Class Reschedule (Consultant Only)

Same as webinar — only consultant can reschedule group events.

### Test 4.4: Class Scheduling Period Enforcement

1. Try to allocate a class session OUTSIDE the 2-month scheduling period
2. **Expected:** Validation error about slot being outside scheduling period

---

## PHASE 5: EDGE CASES & ERROR STATES

### Test 5.1: Unauthorized Access (401)

Log out and make API calls without authentication:

```javascript
async () => {
  // Clear auth state
  const response = await fetch(
    "/api/bookings/consultations?consultantProfileId=test-consultant-profile-001",
  );
  const data = await response.json();
  return { status: response.status, data };
};
```

**Expected:** 401 Unauthorized for protected routes.

For a more reliable test, use a new incognito page or clear cookies first.

### Test 5.2: Forbidden Access (403) — Non-Participant

1. Create a third test user (different consultee)
2. Log in as the third user
3. Try to reschedule an appointment that belongs to the first consultee
4. **Expected:** 403 Forbidden

```javascript
async () => {
  const appointmentId = "<EXISTING_APPOINTMENT_ID>";
  const response = await fetch(
    `/api/appointments/${appointmentId}/reschedule?type=CONSULTATION`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

### Test 5.3: 24-Hour Reschedule Restriction

1. Create an appointment with a slot starting within the next 24 hours (via SQL):

```sql
-- Create a consultation + appointment with a slot starting in 12 hours
INSERT INTO "Consultation" (id, "consultationPlanId", "requestStatus", "requestedById", "bookingSource", "createdAt", "updatedAt")
VALUES ('test-soon-consultation', 'test-consultation-plan-001', 'SCHEDULED', 'test-consultee-profile-001', 'DIRECT_CHECKOUT', NOW(), NOW());

INSERT INTO "Appointment" (id, "appointmentType", "consultationId", "createdAt", "updatedAt")
VALUES ('test-soon-appointment', 'CONSULTATION', 'test-soon-consultation', NOW(), NOW());

INSERT INTO "SlotOfAppointment" (id, "startsAt", "endsAt", "isTentative", "appointmentId", "createdAt", "updatedAt")
VALUES (
  'test-soon-slot',
  NOW() + INTERVAL '12 hours',
  NOW() + INTERVAL '13 hours',
  false,
  'test-soon-appointment',
  NOW(), NOW()
);
```

2. Try to reschedule:

```javascript
async () => {
  const response = await fetch(
    "/api/appointments/test-soon-appointment/reschedule?type=CONSULTATION",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

3. **Expected:** 400 Bad Request with message about 24-hour restriction

### Test 5.4: Slot Conflict Detection

1. Create an appointment that occupies a specific time slot
2. Try to book another appointment in the exact same time slot
3. **Expected:** Conflict error — slot is already occupied

```javascript
async () => {
  // Try to checkout a slot that's already booked
  const occupiedSlotStart = "<EXISTING_SLOT_START_TIME>";
  const occupiedSlotEnd = "<EXISTING_SLOT_END_TIME>";

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-001",
      paymentGateway: "STRIPE",
      startsAt: occupiedSlotStart,
      endsAt: occupiedSlotEnd,
      slotOfAvailabilityWeeklyId: "test-weekly-slot-mon-am",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

### Test 5.5: Outside Availability Error

1. Try to book a slot on Saturday (consultant only has Mon-Fri availability, except the custom Saturday slot):

```javascript
async () => {
  // Pick a Sunday — no availability at all
  const nextSunday = new Date();
  nextSunday.setDate(
    nextSunday.getDate() + ((0 + 7 - nextSunday.getDay()) % 7 || 7),
  );
  nextSunday.setUTCHours(5, 0, 0, 0);

  const slotEnd = new Date(nextSunday);
  slotEnd.setUTCHours(6, 0, 0, 0);

  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "CONSULTATION",
      planId: "test-consultation-plan-001",
      paymentGateway: "STRIPE",
      startsAt: nextSunday.toISOString(),
      endsAt: slotEnd.toISOString(),
      slotOfAvailabilityWeeklyId: "test-weekly-slot-mon-am", // Wrong availability ID
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** Error about slot not matching availability

### Test 5.6: Invalid Appointment Type in Checkout

```javascript
async () => {
  const response = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appointmentType: "INVALID_TYPE",
      planId: "test-consultation-plan-001",
      paymentGateway: "STRIPE",
      isMockPayment: true,
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 with validation error

### Test 5.7: Cancellation Flow

1. Get an appointment ID from an active consultation
2. Cancel it:

```javascript
async () => {
  const appointmentId = "<ACTIVE_APPOINTMENT_ID>";
  const response = await fetch(`/api/appointments/${appointmentId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reason: "SCHEDULE_CONFLICT",
      notes: "E2E test cancellation",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

3. **Verify DB:**

```sql
-- Consultation should be CANCELLED
SELECT id, "requestStatus", "cancellationReason", "cancellationNotes", "cancelledAt"
FROM "Consultation"
WHERE id = '<CONSULTATION_ID>';

-- The slots are SOFT-cancelled, not deleted. Deleting the appointment would
-- cascade its Payment rows away (the #1074 class), so the cancel route only
-- moves completionStatus from SCHEDULED/RESCHEDULED to CANCELLED.
SELECT COUNT(*) AS "remainingSlots",
       COUNT(*) FILTER (WHERE "completionStatus" = 'CANCELLED') AS "cancelledSlots"
FROM "SlotOfAppointment"
WHERE "appointmentId" = '<APPOINTMENT_ID>';
-- Expected: remainingSlots unchanged from before the cancel, and every one of
-- them CANCELLED. Zero rows means someone reintroduced the delete.

-- The Payment trail is the thing the soft cancel exists to protect, so assert it
-- directly rather than inferring it from the slot count.
SELECT id, "paymentStatus", amount
FROM "Payment"
WHERE "appointmentId" = '<APPOINTMENT_ID>';
-- Expected: the same rows, statuses and amounts as before the cancel. A missing
-- row is the #1074 cascade, and a changed status or amount means the cancel
-- route is touching money it has no business touching.
```

### Test 5.8: Cancel With Non-Participant (403)

1. Log in as a different user
2. Try to cancel someone else's appointment
3. **Expected:** 403 Forbidden

### Test 5.9: Appointment Type Mismatch (400)

1. Get an existing CONSULTATION appointment ID
2. Try to reschedule it with the wrong type:

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

3. **Expected:** 400 with message: `"Appointment type mismatch: query param "WEBINAR" does not match actual type "CONSULTATION""`

### Test 5.10: Weekly Availability CRUD API

Test the weekly availability slot management endpoints. Log in as consultant.

**5.10a: Create a new weekly slot via API**

```javascript
async () => {
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 360, // 06:00 UTC = 11:30 IST
      endDay: "SATURDAY",
      endTimeUtc: 540, // 09:00 UTC = 14:30 IST
      consultantProfileId: "test-consultant-profile-001",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 201, slot created with correct Int values.

**Verify DB:**

```sql
SELECT id, "startDay", "startTimeUtc", "endDay", "endTimeUtc"
FROM "SlotOfAvailabilityWeekly"
WHERE "consultantProfileId" = 'test-consultant-profile-001'
  AND "startDay" = 'SATURDAY';
```

**5.10b: Reject out-of-range time value**

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
      consultantProfileId: "test-consultant-profile-001",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — time values must be 0-1439.

**5.10c: Reject overlapping slot**

```javascript
async () => {
  // Try to create a slot that overlaps with Monday AM (270-450)
  const response = await fetch("/api/slots/availability/weekly", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "MONDAY",
      startTimeUtc: 300, // 05:00 UTC — inside 270-450 range
      endDay: "MONDAY",
      endTimeUtc: 480,
      consultantProfileId: "test-consultant-profile-001",
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 400 — overlapping with existing Monday AM slot.

**5.10d: Update and delete a slot**

```javascript
async () => {
  // Get the Saturday slot ID from 5.10a
  const satSlotId = "<SATURDAY_SLOT_ID>";

  // UPDATE the slot
  const putResp = await fetch(`/api/slots/availability/weekly/${satSlotId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startDay: "SATURDAY",
      startTimeUtc: 420, // 07:00 UTC
      endDay: "SATURDAY",
      endTimeUtc: 600, // 10:00 UTC
    }),
  });

  // DELETE the slot
  const delResp = await fetch(`/api/slots/availability/weekly/${satSlotId}`, {
    method: "DELETE",
  });

  return {
    put: { status: putResp.status },
    del: { status: delResp.status },
  };
};
```

**Verify DB:** Saturday slot no longer exists.

### Test 5.11: Concurrent Booking Race Condition

Test that the distributed lock prevents double-booking when two checkouts hit the same slot simultaneously.

```javascript
async () => {
  // Calculate an available slot (next Thursday 10:30 IST = 05:00 UTC)
  const nextThu = new Date();
  nextThu.setDate(nextThu.getDate() + ((4 + 7 - nextThu.getDay()) % 7 || 7));
  nextThu.setUTCHours(5, 0, 0, 0);

  const slotEnd = new Date(nextThu);
  slotEnd.setUTCHours(6, 0, 0, 0);

  const body = JSON.stringify({
    appointmentType: "CONSULTATION",
    planId: "test-consultation-plan-001",
    paymentGateway: "STRIPE",
    startsAt: nextThu.toISOString(),
    endsAt: slotEnd.toISOString(),
    slotOfAvailabilityWeeklyId: "test-weekly-slot-thu-am",
    isMockPayment: true,
  });

  // Fire two simultaneous checkout requests
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

**Expected:** Exactly ONE succeeds (200), the other fails with a conflict error. Verify DB has exactly one appointment for that time slot, not two.

---

## PHASE 6: UI VERIFICATION — CONSULTANT DASHBOARD

### Test 6.1: Requests Tab Comprehensive Check

1. Log in as consultant
2. Navigate to Requests tab
3. Take a snapshot
4. **Verify:**
   - Pending requests show with correct badges
   - Request cards show consultee name, plan name, requested time
   - "Allocate" / "Accept" / "Decline" buttons are visible
   - Reschedule badges show correctly (if any tentative slots exist)
   - Pagination works (if >5 requests)

### Test 6.2: Calendar Allocator UI

1. Open the UnifiedCalendar for a pending subscription request
2. Take a snapshot
3. **Verify:**
   - Week view renders correctly
   - Navigation arrows (prev/next week) work
   - Available slots are distinguishable from occupied slots
   - Clicking a slot selects it (visual feedback)
   - Clicking again deselects it
   - Scheduling period boundaries are visible (for subscriptions)
   - Session count indicator updates as slots are selected

### Test 6.3: Appointments Tab

1. Navigate to Appointments tab
2. Take a snapshot
3. **Verify:**
   - Confirmed appointments show with correct status
   - Subscription appointments show session progress (e.g., "2/4 sessions completed")
   - "Timings" button opens the reschedule calendar
   - Webinar/class appointments show participant count

---

## PHASE 7: UI VERIFICATION — CONSULTEE DASHBOARD

### Test 7.1: Home Tab

1. Log in as consultee
2. Navigate to Home tab
3. Take a snapshot
4. **Verify:**
   - Upcoming sessions carousel shows correct appointments
   - Pending payments widget (if any)
   - Join button visible for upcoming sessions

### Test 7.2: Appointments Tab

1. Navigate to Appointments tab
2. Take a snapshot
3. **Verify:**
   - All 4 event types appear correctly
   - Status badges (Pending, Scheduled, Completed) are accurate
   - Session details show correct times

### Test 7.3: Explore & Book Flow

1. Navigate to `http://localhost:3000/explore/experts`
2. Take a snapshot
3. Find the test consultant
4. Click on the consultant card
5. **Verify:** Profile page loads with:
   - Name, headline, description
   - Availability calendar
   - All 4 plans listed with prices
   - Reviews section (may be empty)

---

## PHASE 8: CROSS-CUTTING CONCERNS

### Test 8.1: Availability-with-Allocation API

Check that the availability endpoint correctly reflects occupied slots:

```sql
-- First, note what slots are occupied
SELECT soa."startsAt", soa."endsAt"
FROM "SlotOfAppointment" soa
JOIN "Appointment" a ON soa."appointmentId" = a.id
JOIN "Consultation" c ON a."consultationId" = c.id
WHERE c."consultationPlanId" = 'test-consultation-plan-001'
  AND soa."isTentative" = false;
```

Then check the availability API:

```javascript
async () => {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
  weekStart.setUTCHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);

  const response = await fetch(
    `/api/slots/availability-with-allocation/test-consultant-profile-001?startDate=${weekStart.toISOString()}&endDate=${weekEnd.toISOString()}`,
  );
  return await response.json();
};
```

**Verify:** Occupied slots are NOT listed as available.

### Test 8.2: Unallocated Slots Endpoints

```javascript
async () => {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 13); // 2 weeks

  const [weekly, custom] = await Promise.all([
    fetch(
      `/api/slots/unallocated/weekly?consultantProfileId=test-consultant-profile-001&startDateInUtc=${weekStart.toISOString()}&endDateInUtc=${weekEnd.toISOString()}`,
    ).then((r) => r.json()),
    fetch(
      `/api/slots/unallocated/custom?consultantProfileId=test-consultant-profile-001&startDateInUtc=${weekStart.toISOString()}&endDateInUtc=${weekEnd.toISOString()}`,
    ).then((r) => r.json()),
  ]);

  return { weekly, custom };
};
```

**Verify:**

- `meta.totalUnallocated` is less than `meta.totalConfigured` (some slots are occupied)
- Pagination works correctly
- Occupied slots are NOT in the results

### Test 8.3: RequestedSlotsDialog Conflict Display

1. Create a consultation request for a time slot that partially overlaps with an existing appointment
2. Log in as consultant
3. Open the RequestedSlotsDialog for this request
4. **Verify the dialog shows:**
   - The conflicting slot marked with a red indicator
   - Conflict details explaining what appointment occupies the slot
   - The "Confirm" button may be disabled (or shows warning)

### Test 8.4: Subscription Validation — Calls Per Week

1. Allocate a subscription with 1 call/week
2. Try to allocate a 2nd call in the same week
3. **Expected:** Validation error about exceeding weekly limit

Use the validate endpoint:

```javascript
async () => {
  // Get subscription ID and try validating 2 slots in the same week
  const nextMon = new Date();
  nextMon.setDate(nextMon.getDate() + ((1 + 7 - nextMon.getDay()) % 7 || 7));
  nextMon.setUTCHours(5, 0, 0, 0);

  const nextTue = new Date(nextMon);
  nextTue.setDate(nextTue.getDate() + 1);

  const subscriptionId = "<SUBSCRIPTION_ID>";
  const response = await fetch(
    `/api/bookings/subscriptions/${subscriptionId}/validate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slots: [nextMon.toISOString(), nextTue.toISOString()],
      }),
    },
  );
  return await response.json();
};
```

---

## PHASE 9: FINAL VERIFICATION CHECKLIST

After completing all phases, run these final checks:

### DB State Summary

```sql
-- Count all test entities
SELECT 'Consultations' as entity, COUNT(*) as count FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-001'
UNION ALL
SELECT 'Subscriptions', COUNT(*) FROM "Subscription" WHERE "subscriptionPlanId" = 'test-subscription-plan-001'
UNION ALL
SELECT 'Appointments', COUNT(*) FROM "Appointment" WHERE id LIKE 'test-%' OR "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-001')
UNION ALL
SELECT 'SlotOfAppointment', COUNT(*) FROM "SlotOfAppointment" WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  LEFT JOIN "Consultation" c ON a."consultationId" = c.id
  LEFT JOIN "Subscription" s ON a."subscriptionId" = s.id
  WHERE c."consultationPlanId" = 'test-consultation-plan-001'
     OR s."subscriptionPlanId" = 'test-subscription-plan-001'
     OR a."webinarId" = 'test-webinar-001'
     OR a."classId" = 'test-class-001'
)
UNION ALL
SELECT 'Payments', COUNT(*) FROM "Payment" WHERE "userId" IN ('test-consultant-user-001', 'test-consultee-user-001')
UNION ALL
SELECT 'Tentative Slots', COUNT(*) FROM "SlotOfAppointment" WHERE "isTentative" = true;
```

### Checklist

- [ ] **Consultation REQUEST_SUBMITTED**: Request created, approved, slots allocated
- [ ] **Consultation DIRECT_CHECKOUT**: Mock payment succeeded, appointment created
- [ ] **Consultation Manual Allocate**: Consultant selected custom slot
- [ ] **Consultation Auto Allocate**: System found first available slot
- [ ] **Consultation Decline**: Request rejected, no appointment
- [ ] **Subscription Request**: Multi-session booking with scheduling period
- [ ] **Subscription Auto Allocate**: 4 sessions distributed across weeks
- [ ] **Subscription Manual Allocate**: Consultant selected specific slots
- [ ] **Subscription Weekly Limit**: Cannot exceed sessionsPerWeek
- [ ] **Subscription Partial Reschedule**: Only specific slots marked tentative
- [ ] **Subscription Full Reschedule**: All slots marked tentative
- [ ] **Webinar Allocation**: Time slot set by consultant
- [ ] **Webinar Registration**: Consultee registered via mock checkout
- [ ] **Webinar Consultant-Only Reschedule**: Consultee gets 403
- [ ] **Class Allocation**: 8 sessions allocated (2/week)
- [ ] **Class Registration**: Consultee enrolled via mock checkout
- [ ] **Class Scheduling Period**: Slots must be within period
- [ ] **Auth 401**: Unauthenticated requests rejected
- [ ] **Auth 403**: Non-participant requests rejected
- [ ] **24-Hour Restriction**: Cannot reschedule within 24 hours
- [ ] **Slot Conflict**: Cannot double-book occupied slots
- [ ] **Outside Availability**: Warning for slots outside availability
- [ ] **Cancellation**: request CANCELLED, slots soft-cancelled in place (`completionStatus = 'CANCELLED'`), nothing deleted
- [ ] **Availability API**: Occupied slots excluded from availability
- [ ] **Unallocated API**: Correct totals after filtering
- [ ] **RequestedSlotsDialog**: Conflicts displayed correctly
- [ ] **Calendar UI**: Slot selection/deselection works
- [ ] **Consultant Dashboard**: Requests, appointments, calendar all render
- [ ] **Consultee Dashboard**: Home, appointments, explore all render

---

## PHASE 10: CLEANUP (Optional)

After all testing is complete, clean up test data:

```sql
-- Delete in reverse dependency order
DELETE FROM "SlotOfAppointment" WHERE "appointmentId" IN (
  SELECT id FROM "Appointment" WHERE id LIKE 'test-%'
  OR "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-001')
  OR "subscriptionId" IN (SELECT id FROM "Subscription" WHERE "subscriptionPlanId" = 'test-subscription-plan-001')
  OR "webinarId" = 'test-webinar-001'
  OR "classId" = 'test-class-001'
);
DELETE FROM "Payment" WHERE "userId" IN ('test-consultant-user-001', 'test-consultee-user-001');
DELETE FROM "Appointment" WHERE id LIKE 'test-%'
  OR "consultationId" IN (SELECT id FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-001')
  OR "subscriptionId" IN (SELECT id FROM "Subscription" WHERE "subscriptionPlanId" = 'test-subscription-plan-001')
  OR "webinarId" = 'test-webinar-001'
  OR "classId" = 'test-class-001';
DELETE FROM "Consultation" WHERE "consultationPlanId" = 'test-consultation-plan-001';
DELETE FROM "Subscription" WHERE "subscriptionPlanId" = 'test-subscription-plan-001';
DELETE FROM "Webinar" WHERE id = 'test-webinar-001';
DELETE FROM "Class" WHERE id = 'test-class-001';
DELETE FROM "ConsultationPlan" WHERE id = 'test-consultation-plan-001';
DELETE FROM "SubscriptionPlan" WHERE id = 'test-subscription-plan-001';
DELETE FROM "WebinarPlan" WHERE id = 'test-webinar-plan-001';
DELETE FROM "ClassPlan" WHERE id = 'test-class-plan-001';
DELETE FROM "SlotOfAvailabilityWeekly" WHERE "consultantProfileId" = 'test-consultant-profile-001';
DELETE FROM "SlotOfAvailabilityCustom" WHERE "consultantProfileId" = 'test-consultant-profile-001';
DELETE FROM sessions WHERE "userId" IN ('test-consultant-user-001', 'test-consultee-user-001');
DELETE FROM accounts WHERE "userId" IN ('test-consultant-user-001', 'test-consultee-user-001');
DELETE FROM "ConsultantProfile" WHERE id = 'test-consultant-profile-001';
DELETE FROM "ConsulteeProfile" WHERE id = 'test-consultee-profile-001';
DELETE FROM users WHERE id IN ('test-consultant-user-001', 'test-consultee-user-001');
DELETE FROM "SubDomain" WHERE id = 'test-subdomain-001';
DELETE FROM "Domain" WHERE id = 'test-domain-001';
```

---

## APPENDIX A: Key Prisma Enums Reference

There is no `RequestStatus` enum. The request lifecycle is `AppointmentStatus`,
declared on `Consultation.status` and `Subscription.status`, both of which are
`@map("requestStatus")` — so the Prisma field is `status` and the SQL column is
`"requestStatus"`.

```
AppointmentStatus: PENDING | APPROVED | APPROVED_PENDING_PAYMENT | SCHEDULED | COMPLETED | REJECTED | CANCELLED | EXPIRED
AppointmentsType: CONSULTATION | SUBSCRIPTION | WEBINAR | CLASS | TRIAL
SlotCompletionStatus: SCHEDULED | COMPLETED | UNVERIFIED | CANCELLED | RESCHEDULED
PaymentStatus: PENDING | SUCCEEDED | FAILED | EXPIRED
PaymentGateway: STRIPE | RAZORPAY | DODO_PAYMENTS | CARD
WebinarStatus: DRAFT | SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED
ClassStatus: DRAFT | SCHEDULED | IN_PROGRESS | COMPLETED | CANCELLED
TrialSessionStatus: PENDING | AWAITING_PAYMENT | SCHEDULED | COMPLETED | CONVERTED | CANCELLED | REJECTED
BookingSource: DIRECT_CHECKOUT | REQUEST_SUBMITTED
CancellationReason: SCHEDULE_CONFLICT | FOUND_ALTERNATIVE | FINANCIAL_REASONS | PERSONAL_EMERGENCY | NO_LONGER_NEEDED | CONSULTANT_UNAVAILABLE | CONSULTANT_EMERGENCY | PAYMENT_FAILED | EXPIRED | CONSULTANT_ISSUE | TECHNICAL_ISSUE | MODERATION | OTHER
DayOfWeek: MONDAY | TUESDAY | WEDNESDAY | THURSDAY | FRIDAY | SATURDAY | SUNDAY
ScheduleType: WEEKLY | CUSTOM
UserRole: CONSULTANT | CONSULTEE | ADMIN | STAFF | ORG_WORKSPACE
RescheduleRequestStatus: PENDING_REVIEW | COUNTERED | AUTO_ACCEPTED | ACCEPTED | DECLINED | WITHDRAWN | EXPIRED
```

## APPENDIX B: Key API Routes Reference

Verified against the route files on 2026-09-02. Note the dynamic segments are
named for their entity (`[consultationId]`, `[webinarId]`, `[appointmentId]`),
never `[id]`, and that every allocate route is a **PATCH**. The method column
lists the verbs each route file exports, which is not the same as the verbs that
succeed: both `[consultationId]` and `[subscriptionId]` export a `DELETE` whose
whole body is a 405. That handler is deliberate rather than vestigial — it
answers `code: "DELETE_NOT_SUPPORTED"` and names the cancel route in its message,
which a bare framework 405 would not, and it is what replaced the raw
`prisma.consultation.delete` that used to cascade Payment rows away.

| Route                                                    | Methods exported        | Purpose                                                     |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `/api/checkout`                                          | POST                    | Create a booking with payment                               |
| `/api/checkout/pending/[paymentId]`                      | DELETE                  | Release your own pending hold early                         |
| `/api/checkout/verify`                                   | GET                     | Verify a payment intent                                     |
| `/api/slots/request-for-approval`                        | POST                    | Consultee requests a booking                                |
| `/api/bookings/consultations`                            | GET, PATCH              | List consultations / update one status                      |
| `/api/bookings/consultations/[consultationId]`           | GET, PUT, PATCH, DELETE | Read, edit, transition; DELETE answers 405                  |
| `/api/bookings/consultations/[consultationId]/allocate`  | PATCH                   | Allocate consultation slots                                 |
| `/api/bookings/consultations/[consultationId]/validate`  | POST                    | Validate proposed slots                                     |
| `/api/bookings/subscriptions`                            | GET, PATCH              | List subscriptions / update one status                      |
| `/api/bookings/subscriptions/[subscriptionId]`           | GET, PUT, PATCH, DELETE | Read, edit, transition; DELETE answers 405                  |
| `/api/bookings/subscriptions/[subscriptionId]/allocate`  | PATCH                   | Allocate subscription slots                                 |
| `/api/bookings/subscriptions/[subscriptionId]/validate`  | POST                    | Validate proposed slots                                     |
| `/api/bookings/webinars`                                 | GET, POST               | List / create a webinar                                     |
| `/api/bookings/webinars/[webinarId]`                     | GET, PUT, DELETE        | Single webinar                                              |
| `/api/bookings/webinars/[webinarId]/allocate`            | PATCH                   | Allocate the webinar's time slot                            |
| `/api/bookings/webinars/[webinarId]/validate`            | POST                    | Validate webinar slots                                      |
| `/api/bookings/webinars/crud-with-plan`                  | POST, PATCH             | Create/update webinar plus its plan                         |
| `/api/bookings/classes`                                  | GET                     | List classes                                                |
| `/api/bookings/classes/[classId]`                        | GET, PUT, DELETE        | Single class                                                |
| `/api/bookings/classes/[classId]/allocate`               | PATCH                   | Allocate class sessions                                     |
| `/api/bookings/classes/[classId]/validate`               | POST                    | Validate class slots                                        |
| `/api/bookings/classes/crud-with-plan`                   | POST, PATCH             | Create/update class plus its plan                           |
| `/api/appointments`                                      | GET                     | Scoped appointment list (`?orgScope=`, `?appointmentType=`) |
| `/api/appointments/[appointmentId]`                      | GET                     | Single appointment detail                                   |
| `/api/appointments/[appointmentId]/cancel`               | POST                    | Cancel an appointment                                       |
| `/api/appointments/[appointmentId]/cancel/preview`       | GET                     | Quote the refund before cancelling                          |
| `/api/appointments/[appointmentId]/reschedule`           | POST                    | Open a reschedule proposal                                  |
| `/api/appointments/[appointmentId]/reschedule/respond`   | POST                    | Counterparty accepts or declines                            |
| `/api/appointments/[appointmentId]/reschedule/withdraw`  | POST                    | Initiator takes their proposal back                         |
| `/api/trials`                                            | GET, POST               | List / request a trial                                      |
| `/api/trials/[trialId]`                                  | GET, PATCH, DELETE      | Read, schedule/accept/reject, delete                        |
| `/api/slots/availability-with-allocation/[consultantId]` | GET                     | Grid of available and occupied slots                        |
| `/api/slots/availability/weekly`                         | GET, POST               | List / create weekly availability rows                      |
| `/api/slots/availability/weekly/[id]`                    | GET, PUT, PATCH, DELETE | One weekly row                                              |
| `/api/slots/availability/custom`                         | GET, POST               | List / create custom availability rows                      |
| `/api/slots/availability/custom/[id]`                    | GET, PUT, PATCH, DELETE | One custom row                                              |
| `/api/slots/unallocated/weekly`                          | GET                     | Unallocated weekly slots                                    |
| `/api/slots/unallocated/custom`                          | GET                     | Unallocated custom slots                                    |
| `/api/slots/unallocated/[consultantId]`                  | GET                     | Unallocated slots for one consultant                        |
| `/api/slots/appointments`                                | GET                     | List appointments with filters                              |

## APPENDIX C: Key Dashboard Routes

| Route                                               | Who        | Purpose                         |
| --------------------------------------------------- | ---------- | ------------------------------- |
| `/auth/signin`                                      | Both       | Login page                      |
| `/auth/signup`                                      | Both       | Registration page               |
| `/dashboard/consultant/[consultantId]/requests`     | Consultant | View/manage booking requests    |
| `/dashboard/consultant/[consultantId]/appointments` | Consultant | View scheduled appointments     |
| `/dashboard/consultant/[consultantId]/planner`      | Consultant | Event management & availability |
| `/dashboard/consultant/[consultantId]/trials`       | Consultant | Free trial management           |
| `/dashboard/consultee/[consulteeId]/home`           | Consultee  | Dashboard overview              |
| `/dashboard/consultee/[consulteeId]/appointments`   | Consultee  | View bookings                   |
| `/explore/experts`                                  | Consultee  | Browse consultants              |
| `/explore/experts/[consultantId]`                   | Consultee  | Consultant profile + booking    |
| `/explore/programs/plans/webinars/[webinarPlanId]`  | Consultee  | Webinar registration            |
| `/explore/programs/plans/classes/[classPlanId]`     | Consultee  | Class enrollment                |
| `/checkout/plans/consultation/[planId]`             | Consultee  | Consultation checkout           |
| `/checkout/plans/subscription/[planId]`             | Consultee  | Subscription checkout           |
| `/checkout/plans/webinar/[planId]`                  | Consultee  | Webinar checkout                |
| `/checkout/plans/class/[planId]`                    | Consultee  | Class checkout                  |
| `/checkout/plans/trial/[trialId]`                   | Consultee  | Trial checkout                  |
