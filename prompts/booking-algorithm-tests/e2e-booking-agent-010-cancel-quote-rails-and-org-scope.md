# E2E Booking Algorithm Test — Agent 010: Cancel Quote, Refund Rails & Org Scope

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

> **Coverage marker:** the cancellation **quote** endpoint and the funding-rail
> field it returns are wave-5 work (#1325 for `fundingRail`, #1327 for the
> single `quoteBookingRefund` both the quote and the charge call). Both are
> merged into `dev`, as are the `?orgScope=` phases, so every phase here runs
> against plain `dev`.

You are a senior QA engineer. Your job is to prove that the number and the
sentence the cancel dialog shows are the number and the rail the cancel
actually pays, and that the scoped appointment list never leaks another
tenant's rows. Tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction and `fetch()` calls via `evaluate_script`

All test data uses the `-010` suffix.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase.
2. Verify DB state after every action via `execute_sql`.
3. A quote that disagrees with the charge is a failure even when both are
   individually plausible. Compare them numerically, not by eye.
4. All times in SQL are UTC. Book at least **5 days out** so the notice tiers do
   not shift mid-run.
5. Never leave a cancelled booking half-refunded; record the refund ids you
   create so you can assert exactly one per payment.

---

## Background

`GET /api/appointments/[appointmentId]/cancel/preview` computes, never writes.
It returns `refundPct`, `estimatedRefundPaise`, `currency`,
`hoursUntilNextSession`, `prorated`, `fundingRail`, `wholeEvent` and
`attendeeCount`. Its authorization mirrors the sibling `POST .../cancel` branch
for branch, deliberately: a preview that answers where the cancel would 403 is a
quote for an action the viewer cannot take.

The rail comes from `fundingRailForIntent`
(`lib/payments/operations/booking-refund.ts`) and is decided from the payment
intent prefix alone: `org_` → `"INTERNAL"` (an in-ledger reversal),
`free_` → `"CREDITS"` (referral credits restored), everything else →
`"GATEWAY"`. For a **group event** the preview returns `wholeEvent: true`,
`refundPct: 100`, `hoursUntilNextSession: null` and `fundingRail: null`, because
the POST route hands the whole event to `refundWholeEventPayments` and the seats
may be funded on several rails at once.

`GET /api/appointments` resolves `?orgScope=` through
`lib/api/scope/parse.ts` into one of `personal`, `org`, `orgMember` or `all`,
and builds its filter in `lib/api/scope/list-appointments.ts`.

---

## Phase 0 — Data Seeding

Create with the `-010` suffix: a consultant
(`testconsultant010@familiarise.com` / `TestPassword010!`, profile
`test-consultant-profile-010`, `scheduleType` `WEEKLY`, Mon–Fri 09:00–17:00
UTC), two consultees (`testconsultee010a@…`, `testconsultee010b@…`), a
consultation plan `test-consultation-plan-010` (0.5 h, ₹2,000), a subscription
plan `test-subscription-plan-010` (4 sessions), and a webinar
`test-webinar-010` with two paid attendees.

Then, as consultee A, book one mock-payment consultation **6 days out at 10:00
UTC** via `POST /api/checkout` with `isMockPayment: true`. Record
`APPOINTMENT_ID` and `PAYMENT_ID`. Start the run on a Tuesday so that six-day
target is the following Monday; six days from an arbitrary today lands on a
weekend roughly two runs in seven, and the seeded availability is Mon–Fri only.
The six-day distance is itself load-bearing — it is what puts the booking in the
top notice tier that Phase 1 asserts — so move the anchor, never the distance.

---

## Phase 1 — The quote matches the charge on a 1:1 booking

Read the quote first:

```javascript
async () => {
  const response = await fetch(
    "/api/appointments/<APPOINTMENT_ID>/cancel/preview",
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200 with `wholeEvent: false`, `prorated: false` (a consultation is
not proratable), a `refundPct` from the top notice tier at six days out, and
`fundingRail: "GATEWAY"`. Record `estimatedRefundPaise`.

Now cancel:

```javascript
async () => {
  const response = await fetch("/api/appointments/<APPOINTMENT_ID>/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes: "Agent 010 quote-versus-charge" }),
  });
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200. The side-effect to check is that the refund actually written
equals the quote:

```sql
SELECT r."amountPaise", r.status
FROM "Refund" r
WHERE r."paymentId" = '<PAYMENT_ID>';
-- Expected: exactly ONE row, amountPaise = the estimatedRefundPaise from the quote.
```

## Phase 2 — The quote is authorization-symmetric

Log in as consultee **B**, who has no relationship to the booking, and call the
same preview URL.

**Expected:** **403**, with the same message the POST route uses
(`You are not authorized to cancel this appointment`). A 200 here is an
information leak: it tells a stranger a booking exists and what it cost.

Call it while signed out.

**Expected:** **401**. Call it with a nonexistent appointment id.

**Expected:** **404**.

## Phase 3 — The whole-event quote is not the viewer's seat

As the CONSULTANT who owns `test-webinar-010`, preview its cancellation.

**Expected:** 200 with `wholeEvent: true`, `refundPct: 100`,
`hoursUntilNextSession: null`, `fundingRail: null`, and `attendeeCount` equal to
the number of **paid** seats (`paymentStatus = 'SUCCEEDED'` and `amount > 0`),
not the roster size. `estimatedRefundPaise` must be the sum of the seats'
refundable balances.

The historical defect this pins: the organiser owns no seat, so quoting the
viewer's own payment found nothing and said "no refund at this notice" while
the click was about to return every attendee's money. If you see
`estimatedRefundPaise: 0` here, that regression is back.

## Phase 4 — Rails: org-funded and credit-funded

Create a second booking funded by an organization (an `org_wallet_`,
`org_invoice_` or `org_license_` intent) and a third funded entirely by referral
credits (a `free_` intent, `Payment.amount = 0`). Preview each.

**Expected:** `fundingRail: "INTERNAL"` for the org-funded booking and
`"CREDITS"` for the credit-funded one. Confirm from the data, not the label:

```sql
SELECT id, "paymentIntent", amount
FROM "Payment"
WHERE "appointmentId" IN ('<ORG_APPT_ID>', '<CREDIT_APPT_ID>');
-- Expected: one intent starting 'org_', one starting 'free_'.
```

Cancel the org-funded booking. **Expected:** the response's `rail` is
`"INTERNAL"`, and the reversal lands in the ledger with **no** gateway refund
row. A gateway call on an `org_` intent dies on `UNKNOWN_GATEWAY` and
historically reversed nothing (#1003, #1020).

## Phase 5 — `?orgScope=` on `/api/appointments`

With consultee A signed in, walk the four values:

| Request                                                        | Expected status | Expected body                                                       |
| -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `GET /api/appointments`                                        | 200             | personal rows only; every item has `organizationId = null`          |
| `GET /api/appointments?orgScope=mine`                          | 200             | identical result to the bare call                                   |
| `GET /api/appointments?orgScope=<orgId-they-do-not-belong-to>` | 403             | `code: "ORG_MEMBERSHIP_REQUIRED"`                                   |
| `GET /api/appointments?orgScope=all`                           | 403             | `code: "ALL_REQUIRES_PRIVILEGED_ROLE"` for a non-ADMIN/STAFF caller |

Then add consultee A to an org as a plain LEARNER (below `operations.read`) and
request `?orgScope=<thatOrgId>`.

**Expected:** **200, not 403** — the resolution deliberately downgrades to
`orgMember` scope, which is that member's own rows within that org. Assert the
downgrade actually narrowed:

```sql
-- Every returned id must belong to this org AND involve this user.
SELECT id, "organizationId" FROM "Appointment" WHERE id IN (<RETURNED_IDS>);
-- Expected: organizationId = the requested org for every row.
```

Finally, promote the member to a role that holds `operations.read` and request
the same scope.

**Expected:** 200, and the result is now the org's rows without a user filter.
Critically, it must contain **only rows the org owns** — a session this org
merely _funded_ inside another org's event must NOT appear, because the detail
page 404s any row whose `organizationId` is not this org (#1166 ORG-8). Prove
it by creating one funded-elsewhere row and asserting it is absent.

Also send a malformed `appointmentType`.

**Expected:** **400** with `{ error: "Invalid query", detail: … }`.

---

## Verification Checklist (End-to-End)

| #   | Assertion                                       | Expected                                  |
| --- | ----------------------------------------------- | ----------------------------------------- |
| 1   | 1:1 quote versus the refund actually written    | equal to the paise                        |
| 2   | Exactly one Refund row per payment              | 1                                         |
| 3   | Preview by a stranger / signed out / unknown id | 403 / 401 / 404                           |
| 4   | Group-event preview                             | `wholeEvent: true`, `refundPct: 100`      |
| 5   | Group-event `attendeeCount`                     | paid seats, not roster                    |
| 6   | Group-event `fundingRail`                       | `null`                                    |
| 7   | `org_` intent                                   | `fundingRail: "INTERNAL"`, no gateway row |
| 8   | `free_` intent                                  | `fundingRail: "CREDITS"`                  |
| 9   | `?orgScope=` for a non-member                   | 403 `ORG_MEMBERSHIP_REQUIRED`             |
| 10  | `?orgScope=all` for a non-privileged caller     | 403 `ALL_REQUIRES_PRIVILEGED_ROLE`        |
| 11  | LEARNER passing their own org id                | 200, downgraded to their own rows         |
| 12  | Org scope with `operations.read`                | owned rows only; funded-elsewhere absent  |

---

## Cleanup

Reverse the ledger effects you created, then delete only the `-010` rows,
newest first. Leave every seed row untouched.
