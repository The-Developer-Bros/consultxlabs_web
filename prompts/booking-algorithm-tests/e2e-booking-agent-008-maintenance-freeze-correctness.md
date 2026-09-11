# E2E Booking Algorithm Test — Agent 008: Maintenance-Freeze Correctness

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

> **Coverage marker:** this case covers maintenance-freeze correctness for
> in-flight money. The whole subsystem is live on `dev` — the phases and the
> financial-cron abort in `lib/maintenance.ts` and `lib/maintenance-cron.ts`,
> the middleware gate in `lib/maintenance-edge.ts`, the admin API under
> `app/api/admin/maintenance`, and the regression suite
> `__tests__/maintenance/freeze-appointments.test.ts`. What this case proves is
> that freezing never destroys a payment and that freeze-then-cancel never
> refunds twice.

You are a senior QA engineer. Your job is to prove two invariants across a
maintenance freeze, using Supabase MCP for SQL and Chrome DevTools MCP for
API calls:

1. **A PENDING payment in flight when maintenance freezes must survive.** The
   tentative booking may expire or complete later, but the `Payment` row is
   never deleted and never left pointing at destroyed state. (This is the
   #1074 doctrine — the slot is freed by status alone; the money row is
   immortal.)
2. **Freeze then manual cancel must not double-refund.** A booking cancelled
   during/after a freeze gets exactly one refund, no matter how the freeze-era
   catch-up machinery and the manual cancel interleave.

All test data uses the `-008` suffix. You need an ADMIN login for the
maintenance API — promote your test admin via SQL if needed
(`UPDATE users SET role='ADMIN' WHERE email='testadmin008@familiarise.com';`).

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase.
2. Verify DB state after every action via `execute_sql`.
3. **ALWAYS end maintenance mode before finishing a phase** — a leaked
   DEGRADED/OFFLINE state breaks every other case (and your own re-runs).
   `DELETE /api/admin/maintenance` (or the admin UI) must return the phase to
   OFF; verify via `GET /api/admin/maintenance`.
4. Refund/ledger assertions are integer paise. Never divide by 100.
5. Mock payments only (`isMockPayment: true`). Never touch the real gateway.

---

## Background: What "freeze" means here

Maintenance has three phases — `OFF → DEGRADED (read-only) → OFFLINE (full
page)` — stored in Redis for the middleware edge gate and mirrored to Prisma
for audit (`lib/maintenance.ts`). Two behaviors matter for money:

- The middleware blocks write APIs during DEGRADED and everything but exempt
  routes during OFFLINE (`middleware.ts`, maintenance gate).
- Financial crons refuse to run under ANY maintenance phase:
  `abortIfMaintenance(jobName)` in `lib/maintenance-cron.ts` exits
  `cleanup-abandoned-payments`, `reconcile-payment-status`,
  `cascade-refund-earnings`, `sync-payment-earnings`, and the payout/refund
  jobs, precisely so half-frozen state is never "cleaned up" mid-freeze.

The post-freeze catch-up order is documented in
`docs/maintenance/07-post-maintenance-recovery.md` §4 "Run Critical
Reconciliation Jobs", whose six priorities run payment reconciliation, slot
reconciliation, payment-earnings sync, tentative-slot cleanup, refund
reconciliation and payout reconciliation in that order. The fleet itself is
catalogued in `docs/maintenance/04-cron-jobs-reference.md`. This case exercises
the two money hazards in that hand-off.

---

## Phase 0 — Data Seeding

Reuse the Agent-005 recipe with the `-008` suffix: consultant
`testconsultant008@familiarise.com`, consultee `testconsultee008@familiarise.com`,
admin `testadmin008@familiarise.com` (all `TestPassword008!`), consultant
profile `test-consultant-profile-008` with weekly availability Mon–Fri
09:00–17:00 UTC, and consultation plan `test-consultation-plan-008` (0.5h,
₹1,000). Verify seeding with the standard SELECTs before continuing.

---

## Phase 1 — Freeze With a PENDING Payment In Flight

### Test 1.1 — Create the in-flight payment

As CONSULTEE, start a checkout that stays PENDING: call `POST /api/checkout`
for a slot 5 days out **without** mock auto-succeed — i.e. a real two-phase
flow against the mock gateway that stops before confirmation (create the
intent, do not complete it). If the branch offers no way to hold a mock
payment open, fall back to SQL: create the booking via mock checkout, then
reset it to the in-flight shape and note you did so:

```sql
UPDATE "Payment" SET "paymentStatus" = 'PENDING',
       "expiresAt" = NOW() + INTERVAL '30 minutes'
WHERE id = '<PAYMENT_ID>';
UPDATE "SlotOfAppointment" SET "isTentative" = true
WHERE "appointmentId" = '<APPOINTMENT_ID>';
```

Record `PAYMENT_ID`, `APPOINTMENT_ID`, and the slot ids.

### Test 1.2 — Freeze

As ADMIN: `POST /api/admin/maintenance` with
`{ "phase": "DEGRADED", "reason": "agent-008 freeze test" }` → expect 200.
Confirm `GET /api/admin/maintenance` reports DEGRADED.

### Test 1.3 — The freeze must not destroy the payment

Run the abandoned-payment cleanup the way the cron would (
`npx tsx jobs/payments/cleanup-abandoned-payments.ts` if you have shell
access, otherwise wait out one cron tick or invoke its route). **Expected:**
the job exits early via `abortIfMaintenance` and touches nothing.

```sql
SELECT id, "paymentStatus", "appointmentId" FROM "Payment" WHERE id = '<PAYMENT_ID>';
-- Expected: the row EXISTS, status still PENDING (or EXPIRED later — but the
-- row itself must never disappear).

SELECT COUNT(*) FROM "SlotOfAppointment"
WHERE "appointmentId" = '<APPOINTMENT_ID>' AND "deletedAt" IS NULL;
-- Expected: unchanged from Test 1.1 — no slot was hard-deleted mid-freeze.
```

### Test 1.4 — Thaw and settle

End maintenance (`DELETE /api/admin/maintenance`), verify OFF, then let the
normal lifecycle resolve the payment (run the cleanup job again after
`expiresAt` passes, or complete the mock payment). **Expected:** the payment
reaches a terminal status (`EXPIRED`/`FAILED`/`SUCCEEDED`) **by status
transition** — the `Payment` row and its `appointmentId` linkage survive; only
tentative slots are released.

```sql
SELECT "paymentStatus" FROM "Payment" WHERE id = '<PAYMENT_ID>';
-- Expected: terminal status; row present. The appointment may be tombstoned
-- (deletedAt/status) but never hard-deleted while a Payment points at it.
```

---

## Phase 2 — Freeze Then Manual Cancel Must Not Double-Refund

### Test 2.1 — Create a paid booking

As CONSULTEE, book a mock-payment consultation 5 days out (₹1,000 → 100000
paise, `paymentStatus: SUCCEEDED`, confirmed slot). Record
`PAYMENT_2_ID` / `APPOINTMENT_2_ID`.

### Test 2.2 — Freeze, then cancel after thaw

Freeze (DEGRADED), verify the cancel API is blocked while frozen (expect
503 with the maintenance banner headers), thaw, then as CONSULTEE cancel the
booking through the normal cancellation API (full refund window applies at 5
days out).

### Test 2.3 — Exactly one refund, exactly once

Immediately re-run every refund-adjacent re-drive that a post-freeze catch-up
would run — the cancel API a second time (expect 4xx: already cancelled, a
dead CAS edge), `reconcile-pending-refunds`, `cascade-refund-earnings` — then
assert the money moved **once**:

```sql
SELECT COUNT(*) AS refund_rows, COALESCE(SUM("amountPaise"), 0) AS refunded_paise
FROM "Refund" WHERE "paymentId" = '<PAYMENT_2_ID>';
-- Expected: refund_rows = 1, refunded_paise = 100000 — never more than paid.

SELECT status, "cascadedAt" FROM "Refund" WHERE "paymentId" = '<PAYMENT_2_ID>';
-- Expected: cascadedAt NOT NULL and unchanged across re-drives — it is the
-- #776 idempotency stamp; the backstop cron selects only rows where it is null.

SELECT "refundedShareAmount", "consultantSharePaise" FROM "ConsultantEarnings"
WHERE "paymentId" = '<PAYMENT_2_ID>';
-- Expected: refundedShareAmount = consultantSharePaise exactly once —
-- a second pass must not claw the earning again.

SELECT COUNT(*) FROM "LedgerTransaction" lt
JOIN "Refund" r ON lt."idempotencyKey" = 'refund:' || r."refundId"
WHERE r."paymentId" = '<PAYMENT_2_ID>';
-- Expected: 1 — the refund's journal posting is keyed `refund:<refundId>`;
-- a re-drive re-derives the same key and no-ops.
```

If ANY of these shows a second refund row, a doubled clawback, or a second
journal transaction, that is the #1163 bug this case exists to catch — stop
and fix.

---

## Phase 3 — Freeze During the Cancel (ordering variant)

Repeat Phase 2 with the freeze landing **between** the cancel request and the
refund settling, if the branch allows you to interleave (freeze immediately
after the cancel API returns, before running any re-drives). Thaw, run the
re-drives, and re-assert the Phase 2.3 block. **Expected:** identical — one
refund, one clawback, one journal txn.

---

## Verification Checklist (End-to-End)

| #   | Check                                                         | Expected                 |
| --- | ------------------------------------------------------------- | ------------------------ |
| 1   | Freeze with PENDING payment: cleanup aborts under maintenance | job exits, no writes     |
| 2   | Payment row survives the freeze                               | row exists               |
| 3   | No hard-deleted slots mid-freeze                              | counts unchanged         |
| 4   | Post-thaw the payment resolves by STATUS, row intact          | terminal status          |
| 5   | Cancel API blocked while frozen                               | 503                      |
| 6   | Manual cancel after thaw refunds once                         | 1 Refund row             |
| 7   | Second cancel is a dead CAS edge                              | 4xx                      |
| 8   | Re-drives do not double-claw earnings                         | refundedShareAmount once |
| 9   | Refund journal posting idempotent                             | 1 LedgerTransaction      |
| 10  | Ordering variant (freeze mid-cancel) identical                | same as 6–9              |
| 11  | Maintenance OFF at the end                                    | GET reports OFF          |
| 12  | Cleanup complete                                              | all `-008` counts = 0    |

---

## Cleanup

**First** confirm maintenance is OFF. Then delete in dependency order with the
`-008` suffix, mirroring Agent 005 Phase 10, adding the money rows first:

```sql
DELETE FROM "Refund" WHERE "paymentId" IN
  (SELECT id FROM "Payment" WHERE "userId" IN
    (SELECT id FROM users WHERE email LIKE 'test%008@familiarise.com'));
DELETE FROM "ConsultantEarnings" WHERE "paymentId" IN
  (SELECT id FROM "Payment" WHERE "userId" IN
    (SELECT id FROM users WHERE email LIKE 'test%008@familiarise.com'));
```

Then slots → payments → appointments → consultations → plans → availability →
profiles → users → subdomain/domain. Leave the seeded `LedgerTransaction`
rows in place if the FK restricts deletion — note them in your run report
instead of force-deleting journal history.
