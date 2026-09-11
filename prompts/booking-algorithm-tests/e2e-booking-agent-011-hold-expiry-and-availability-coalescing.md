# E2E Booking Algorithm Test — Agent 011: Hold Expiry & Availability Coalescing

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

> **Coverage marker:** all three subjects here are wave-5 work. The dead-hold
> rule for a `DIRECT_CHECKOUT` request and its SQL twin `buildDeadHoldFilter`
> landed with **#1328**; availability coalescing on save and the published-window
> union check landed with **#1323**. Both are merged into `dev`, so this case
> runs against plain `dev`. Before #1328 a lapsed direct-checkout hold stayed
> blocked until the sweep ran, which is the defect Phase 2 pins.

You are a senior QA engineer. Your job is to prove that a slot whose payment
window has lapsed becomes bookable again **immediately and consistently on
every surface**, and that availability rows fold as they are written. Tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction and `fetch()` calls via `evaluate_script`

All test data uses the `-011` suffix.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase.
2. Verify DB state after every action via `execute_sql`.
3. **Three surfaces must agree.** Every occupancy assertion in this case must be
   made against the grid, `/validate` and auto-allocate. A slot that is free on
   one and blocked on another is the exact bug this case exists to catch.
4. You will manipulate `Payment.expiresAt` directly with SQL to simulate a
   lapsed window. Never change `paymentStatus` to `SUCCEEDED` while doing so.
5. All times in SQL are UTC.

---

## Background: when a hold is dead

The rule lives in two places asserted to agree by
`__tests__/booking-algorithm/hold-expiry-predicate.test.ts`:
`isOccupiedByLiveAppointment` (`utils/slotAllocation/SlotValidationService.ts`)
for callers that already loaded appointments, and `buildDeadHoldFilter`
(`utils/slotAllocation/occupancyPolicy.ts`) for callers that select slots —
checkout's first step and the trial route.

A payment row is **dead** when it is `EXPIRED`, `FAILED`, or still `PENDING`
past its `expiresAt`. **Never by the clock alone**: a `SUCCEEDED` row keeps its
`expiresAt` and must never free the slot it paid for. The hold is free only when
_every_ payment row on the appointment is dead and there is at least one.

Two request shapes qualify: an `APPROVED_PENDING_PAYMENT` request, and a
`PENDING` request whose `bookingSource` is `DIRECT_CHECKOUT`. A `PENDING`
request whose `bookingSource` is `REQUEST_SUBMITTED` waits on a human, not a
payment, and always occupies.

Checkout writes `expiresAt` as thirty minutes from now
(`lib/payments/operations/checkout.ts`); there is no named constant for it.

---

## Phase 0 — Data Seeding

Create with the `-011` suffix: consultant
`testconsultant011@familiarise.com` / `TestPassword011!` with profile
`test-consultant-profile-011` (`scheduleType` `WEEKLY`, Mon–Fri 09:00–17:00
UTC), consultee `testconsultee011@familiarise.com` / `TestPassword011!`, and a
consultation plan `test-consultation-plan-011` (0.5 h, ₹1,000).

Pin `D` to the coming Monday, so the `D+4` this case books is a Friday inside
the seeded Mon–Fri window rather than whatever day falls four days after the run
happens to start.

Then, as CONSULTEE, start a **real-payment** checkout (omit `isMockPayment`, or
set it false) for **4 days out at 11:00 UTC** so the payment stays `PENDING`
with a live `expiresAt` and the slot is tentative:

```sql
SELECT p.id, p."paymentStatus", p."expiresAt", c.status, c."bookingSource",
       s.id AS slot_id, s."isTentative"
FROM "Payment" p
JOIN "Appointment" a ON a.id = p."appointmentId"
JOIN "Consultation" c ON c.id = a."consultationId"
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
WHERE c."consultationPlanId" = 'test-consultation-plan-011';
-- Expected: paymentStatus PENDING, expiresAt ≈ now + 30 min,
-- Consultation.status PENDING, bookingSource DIRECT_CHECKOUT, isTentative true.
-- Save PAYMENT_ID and SLOT_ID.
```

---

## Phase 1 — A live hold blocks all three surfaces

While `expiresAt` is still in the future, assert 11:00–11:30 on D+4 is blocked:

1. **Grid.** `GET /api/slots/availability-with-allocation/test-consultant-profile-011?startDateInUtc=<D+4T00:00Z>&endDateInUtc=<D+5T00:00Z>&timezone=UTC`
   → the 11:00 slot is present but marked allocated/occupied.
2. **Validate.** `POST /api/bookings/consultations/<OTHER_CONSULTATION_ID>/validate`
   with `{ "slots": ["<D+4T11:00Z>"] }` → 200, and the slot appears under
   `conflicts`, not `validSlots`.
3. **Auto-allocate.** An auto allocation for the same consultant must not place
   a session at 11:00.

## Phase 2 — Lapse the window; all three surfaces free the slot

Age the payment out **without** touching its status:

```sql
UPDATE "Payment" SET "expiresAt" = now() - interval '1 minute'
WHERE id = '<PAYMENT_ID>';
```

Re-run all three probes from Phase 1.

**Expected:** the 11:00 slot is now free on **all three**. Specifically the grid
no longer marks it allocated, `/validate` returns it under `validSlots`, and
auto-allocate is willing to place there. The row itself has not moved:

```sql
SELECT "isTentative", "deletedAt", "completionStatus"
FROM "SlotOfAppointment" WHERE id = '<SLOT_ID>';
-- Expected: unchanged — the slot is freed by the payment rule, not by a write.
```

This is the wave-5 change. Before #1328 the `PENDING` + `DIRECT_CHECKOUT` shape
stayed blocked until the sweep ran, because only `APPROVED_PENDING_PAYMENT` was
recognised.

Then undo the third probe before going on. Auto-allocation is a write, so the
probe that just proved 11:00 is placeable has placed something there, and that
replacement booking would block 11:00 in Phase 3 on its own — a rule that wrongly
freed an expired `SUCCEEDED` hold would still look correct, because the slot is
occupied either way. Record the appointment the probe created, delete it and its
slots, and re-run the grid probe to confirm 11:00 reads free again before
touching the payment:

```sql
SELECT a.id AS appointment_id, s.id AS slot_id, s."startsAt"
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
JOIN "Consultation" c ON c.id = a."consultationId"
WHERE c."consultationPlanId" = 'test-consultation-plan-011'
  AND a.id <> (SELECT "appointmentId" FROM "SlotOfAppointment"
                WHERE id = '<SLOT_ID>');
-- Expected: the replacement the auto-allocate probe wrote. Delete these rows
-- (slots first), then re-probe the grid: 11:00 must still read free.
```

## Phase 3 — The clock alone must not free a paid slot

Restore a live window, then capture the payment and age it out again:

```sql
UPDATE "Payment"
SET "paymentStatus" = 'SUCCEEDED', "expiresAt" = now() - interval '1 hour'
WHERE id = '<PAYMENT_ID>';
```

**Expected:** the slot is **blocked** on all three surfaces. A `SUCCEEDED` row
keeps its `expiresAt`, and treating that timestamp as death would free a slot
somebody paid for. If any surface offers 11:00 here, stop and fix it — this is
a double-booking of a paid session.

## Phase 4 — A retry row keeps the hold alive

Restore `paymentStatus = 'PENDING'` with a past `expiresAt`, then insert a
**second** payment row on the same appointment that is `PENDING` with a future
`expiresAt` (a live retry).

**Expected:** the slot is **blocked** again. The hold is free only when _every_
payment row is dead; a later active retry keeps it alive (#873).

Now expire the retry too.

**Expected:** free again on all three surfaces.

## Phase 5 — `REQUEST_SUBMITTED` is a different animal

Create a second consultation through `POST /api/slots/request-for-approval` so
it lands `PENDING` with `bookingSource = 'REQUEST_SUBMITTED'`, on D+4 at 14:00
UTC. Give it a payment row and expire it.

**Expected:** 14:00 stays **blocked**. That request waits on a consultant's
decision, not on a payment window, so the dead-hold rule must not reach it.

## Phase 6 — Custom availability rows coalesce on save

As the CONSULTANT, add a custom availability row, then add an exactly adjacent
one:

```javascript
async () => {
  const post = (startsAt, endsAt) =>
    fetch("/api/slots/availability/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consultantProfileId: "test-consultant-profile-011",
        startsAt,
        endsAt,
      }),
    });
  const a = await post("<D+8T09:00Z>", "<D+8T11:00Z>");
  const bodyA = await a.json();
  const b = await post("<D+8T11:00Z>", "<D+8T13:00Z>");
  return { first: a.status, second: b.status, bodyA, bodyB: await b.json() };
};
```

**Expected:** both return **201**, and the second response's `data` is the
**folded** row covering 09:00–13:00, not a second 11:00–13:00 row. Assert the
fold in SQL:

```sql
SELECT id, "startsAt", "endsAt" FROM "SlotOfAvailabilityCustom"
WHERE "consultantProfileId" = 'test-consultant-profile-011'
ORDER BY "startsAt";
-- Expected: ONE row spanning 09:00–13:00 on D+8, not two.
```

Critically, the surviving row must keep the **id of the first row**, because a
booking names a custom row and recreating them all would orphan ids still in
flight. Compare against `bodyA.data.id`.

Then post an **overlapping** row (10:00–12:00 on D+8).

**Expected:** **409** — the overlap guard rejects it. Adjacency is folded;
overlap is refused.

Finally, post two adjacent **weekly** rows and confirm they fold too — but note
the asymmetry: `coalesceConsultantWeeklyRows` deletes and recreates, so the
weekly row ids **do** change. That is expected, not a bug.

## Phase 7 — A trial cannot be scheduled outside the published window

Create a trial for this consultant, then as the CONSULTANT try to schedule it at
a time no availability row covers — 03:00 UTC on D+4:

```javascript
async () => {
  const response = await fetch("/api/trials/<TRIAL_ID>", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "SCHEDULED",
      slotData: {
        startsAt: "<D+4T03:00Z>",
        endsAt: "<D+4T03:30Z>",
        slotOfAvailabilityId: "<ANY_ROW_ID>",
        slotType: "WEEKLY",
      },
    }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** **400** with
`The selected time is outside the expert's published availability`. Note this is
deliberately a 400 and not a 409: the slot is not taken, it was never on offer.
It must fail **even though the consultant is the one scheduling** — a trial is a
booking. Assert no slot row was created.

Now retry inside the published window but on a time another confirmed booking
already holds.

**Expected:** **409**, `Selected slot is no longer available` — that one _is_ a
lost race.

There is a second, distinct 409 on this route, so do not conflate them when
triaging. Scheduling claims the trial through
`transitionTrialSession(tx, { …, fromIn: [existingTrial.status] })`; if the CAS
matches no row because a sibling request already moved the trial, the route
throws `TrialStateChangedError` and answers 409 with "This trial was already
updated by another request." That is the trial state having moved, not the slot
having gone.

---

## Verification Checklist (End-to-End)

| #   | Assertion                                            | Expected                      |
| --- | ---------------------------------------------------- | ----------------------------- |
| 1   | Live hold, three surfaces                            | blocked on all three          |
| 2   | Lapsed `PENDING` + `DIRECT_CHECKOUT`, three surfaces | free on all three             |
| 3   | Slot row after the lapse                             | unchanged in the database     |
| 4   | `SUCCEEDED` with a past `expiresAt`                  | still blocked                 |
| 5   | Live retry row alongside a dead one                  | still blocked                 |
| 6   | Both rows dead                                       | free                          |
| 7   | Lapsed `PENDING` + `REQUEST_SUBMITTED`               | still blocked                 |
| 8   | Adjacent custom rows                                 | folded into one, id preserved |
| 9   | Overlapping custom row                               | 409                           |
| 10  | Adjacent weekly rows                                 | folded; ids change            |
| 11  | Trial outside the published window                   | 400, no slot written          |
| 12  | Trial on a taken in-window time                      | 409                           |

---

## Cleanup

Restore every `Payment` row you edited to its original `paymentStatus` and
`expiresAt` before deleting anything, then delete only the `-011` rows, newest
first. Leave every seed row untouched.
