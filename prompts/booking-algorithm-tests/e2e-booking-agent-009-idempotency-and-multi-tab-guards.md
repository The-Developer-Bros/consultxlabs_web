# E2E Booking Algorithm Test — Agent 009: Idempotency & Multi-Tab Guards

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

> **Coverage marker:** this case pins the two dedupe mechanisms that stop a
> double-click, a network retry or a second browser tab from producing two
> bookings. They are **different mechanisms with different transports**, and
> conflating them is the mistake this case exists to catch. Checkout dedupes on
> a **body field**, `clientIdempotencyKey`. The allocate routes dedupe on an
> **`Idempotency-Key` header**. `/api/checkout` does not read that header at
> all.

You are a senior QA engineer. Your job is to prove that the same logical action
submitted twice produces one booking and one payment, using two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction and `fetch()` calls via `evaluate_script`

All test data uses the `-009` suffix to avoid collisions with existing seed data.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase.
2. Verify DB state after every action via `execute_sql`. The database is the
   arbiter; a 200 that wrote two rows is a failure, not a pass.
3. Test both happy path AND error paths.
4. All times in SQL are UTC. Book slots **at least 3 days out**.
5. Mock payments only work when the server runs with `NODE_ENV=development`.

---

## Background: the two mechanisms

**Checkout** (`app/api/checkout/route.ts`, `schemas/checkout.ts`). The schema
field is `clientIdempotencyKey: z.string().min(8).max(128).optional()`. When the
client omits it the route mints a UUID server-side, so the column is never null
in practice. Before doing any work the route calls `replayByIdempotencyKey`
(`lib/payments/operations/checkout-replay.ts`) and, on a hit, returns the
original response. Two genuinely concurrent requests can both miss that lookup;
the loser's `Payment.create` then dies on the unique key, and the route catches
Prisma **P2002** whose `meta.target` includes `clientIdempotencyKey` and replays
the winner's response instead of surfacing a 500.

**Allocation** (`app/api/bookings/<type>/[<type>Id]/allocate/route.ts`). The
route reads `request.headers.get("Idempotency-Key")` and passes it to
`SlotAllocationService.allocate` as `idempotencyKey`, persisted as the unique
`Appointment.allocationIdempotencyKey` (#837). A repeat with the same key
replays the original batch.

**The multi-tab guards** are separate from both and live in
`utils/slotAllocation/SlotAllocationService.ts`. `initialAllocation: true` makes
`assertNoConfirmedSlots` reject when the event already holds any confirmed
(non-tentative, non-tombstoned) slot, and `expectedTentativeSlotCount` rejects
when the live tentative count differs from what the client's page captured
(#1012). Both throw `AllocationConflictError` → **HTTP 409** with
`errorCode: "LOCK_CONTENTION"`. The guard runs once under the Redis locks and
again inside the write transaction behind a `pg_advisory_xact_lock`, and inside
that lock a same-key double submit **replays** rather than 409s — only a
different-key submit gets the conflict. That distinction is the subtlest thing
in this case; test it explicitly in Phase 4.

---

## Phase 0 — Data Seeding

Create, with the `-009` suffix: consultant `testconsultant009@familiarise.com` /
`TestPassword009!` with profile `test-consultant-profile-009` (`scheduleType`
`WEEKLY`, availability Mon–Fri 09:00–17:00 UTC), consultee
`testconsultee009@familiarise.com` / `TestPassword009!`, a consultation plan
`test-consultation-plan-009` (0.5 h, ₹1,000) and a webinar
`test-webinar-009` on plan `test-webinar-plan-009` in `PENDING` with no
confirmed slots. Create the accounts through the signup UI, then attach the
profiles via SQL as in Agent 005 Phase 0.

Pin `D` to the coming Monday before anything else, so the `D+3` this case books
is a Thursday and lands inside the seeded Mon–Fri window.

---

## Phase 1 — Checkout replays on a repeated `clientIdempotencyKey`

As CONSULTEE, send the same body twice, sequentially:

```javascript
async () => {
  const body = {
    appointmentType: "CONSULTATION",
    planId: "test-consultation-plan-009",
    startsAt: "<D+3T10:00Z>",
    endsAt: "<D+3T10:30Z>",
    slotOfAvailabilityWeeklyId: "<WEEKLY_ROW_ID>",
    clientIdempotencyKey: "agent-009-checkout-key-0001",
    isMockPayment: true,
  };
  const first = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const firstBody = await first.json();
  const second = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    first: first.status,
    second: second.status,
    firstBody,
    secondBody: await second.json(),
  };
};
```

**Expected:** both calls succeed and return the **same** payment identity. The
side-effect to check is that exactly one row exists:

```sql
SELECT COUNT(*) AS payments
FROM "Payment"
WHERE "clientIdempotencyKey" = 'agent-009-checkout-key-0001';
-- Expected: 1

SELECT COUNT(*) AS slots
FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
JOIN "Consultation" c ON c.id = a."consultationId"
WHERE c."consultationPlanId" = 'test-consultation-plan-009'
  AND s."deletedAt" IS NULL;
-- Expected: 1 (one 30-minute atom), NOT 2.
```

## Phase 2 — Checkout mints a key when the client omits one

Repeat Phase 1's first call with `clientIdempotencyKey` **absent** and a
different slot time (`<D+4T10:00Z>`).

**Expected:** 200, and the persisted row still carries a key:

```sql
SELECT "clientIdempotencyKey" IS NOT NULL AS key_minted
FROM "Payment"
WHERE "userId" = '<CONSULTEE_USER_ID>'
ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: key_minted = true
```

A null here means the nullable unique deduplicates nothing and every keyless
checkout is unprotected (#1093 §3).

## Phase 3 — Concurrent checkout: one wins, the loser replays

Fire two identical requests with the same new key **in parallel** via
`Promise.all`, for slot `<D+5T10:00Z>`.

**Expected:** neither response is a 500. One is the original, the other is the
replay, and the row count is again exactly one. If you see a 500 with a P2002 in
the server log, the catch-and-replay branch is broken.

## Phase 4 — `initialAllocation` rejects the second tab

Allocate the webinar once, normally:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-009/allocate",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "agent-009-alloc-key-A",
      },
      body: JSON.stringify({ isAuto: true, initialAllocation: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 with `data` holding the created appointment(s). Confirm the
webinar now has confirmed slots:

```sql
SELECT COUNT(*) FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."webinarId" = 'test-webinar-009'
  AND s."isTentative" = false AND s."deletedAt" IS NULL;
-- Expected: > 0
```

Now repeat the request with a **different** `Idempotency-Key`
(`agent-009-alloc-key-B`) and the same body.

**Expected:** **409** with `errorCode: "LOCK_CONTENTION"` and a message naming
the confirmed slot count. The side-effect to check is that the confirmed slot
count is **unchanged** — the second tab must not have deleted and replaced the
first tab's allocation.

Finally repeat with the **same** key as the winner (`agent-009-alloc-key-A`).

**Expected:** 200, not 409 — a same-key double submit replays the committed
batch. The confirmed slot count is still unchanged.

## Phase 5 — `expectedTentativeSlotCount` rejects a stale tab

Send an allocate with `expectedTentativeSlotCount` deliberately wrong:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/webinars/test-webinar-009/allocate",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "agent-009-alloc-key-C",
      },
      body: JSON.stringify({ isAuto: true, expectedTentativeSlotCount: 99 }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** **409**, `errorCode: "LOCK_CONTENTION"`, and no change to any
slot row.

## Phase 6 — `isAuto` is required

Send an allocate body with no `isAuto` at all.

**Expected:** **400**, with the message `'isAuto' is required` surfacing through
the route's ZodError formatter. Then send `{ "isAuto": false }` with no `slots`.

**Expected:** **400**, message
`Manual allocation requires 'slots' array with at least one time slot`.

---

## Verification Checklist (End-to-End)

| #   | Assertion                                            | Expected                          |
| --- | ---------------------------------------------------- | --------------------------------- |
| 1   | Repeated `clientIdempotencyKey` on checkout          | one Payment, one slot             |
| 2   | Omitted `clientIdempotencyKey`                       | key minted server-side, not null  |
| 3   | Concurrent identical checkout                        | no 500; one Payment               |
| 4   | Second tab, `initialAllocation: true`, different key | 409 `LOCK_CONTENTION`             |
| 5   | Confirmed slot count after the 409                   | unchanged                         |
| 6   | Same `Idempotency-Key` resubmitted to allocate       | 200 replay, not 409               |
| 7   | Wrong `expectedTentativeSlotCount`                   | 409 `LOCK_CONTENTION`             |
| 8   | Missing `isAuto`                                     | 400                               |
| 9   | `isAuto: false` with no `slots`                      | 400                               |
| 10  | `/api/checkout` ignores an `Idempotency-Key` header  | contract, not a probe — see below |

Row 10 is the one line in this table that no phase sends a request for, and that
is deliberate. It is settled by reading `app/api/checkout/route.ts`, which takes
`clientIdempotencyKey` off the validated body and never calls
`request.headers.get("Idempotency-Key")` — the header is not ignored by accident,
it is never looked at. Keep the row so nobody assumes the header dedupes a
checkout, and do not report it as a passed assertion.

---

## Cleanup

Delete only the rows this case created, newest first so foreign keys unwind:
the `-009` slots, appointments, payments, consultation, webinar, plans,
profiles and users. Leave every seed row untouched.
