# TESTING PLAN — B2C/B2B Booking & Finance Hardening Train

Audience: the consulting/QA team validating the PR-1 train (#835 wallet-refund
audit, #849 cancel-pending-booking, #850 payout consolidation, #814/#821
waitlist crons) plus regression coverage of the booking/payments core. Written
to be executed by several testers (or test agents) **in parallel**, with the
race scenarios deliberately requiring two actors on the same resource.

---

## 1. Environment setup & reset

### 1.1 Check before you reset

The dev database is **shared** (Supabase). It was schema-pushed and re-seeded
on 2026-06-11 (#837 train). Verify state before nuking anything:

```bash
# Schema in sync? (should print "The database is already in sync")
npx prisma db push --skip-generate

# Seeded? (should return a row count > 0)
npx tsx -e "import p from '@/lib/prisma'; p.user.count().then(c => { console.log('users:', c); process.exit(0); })"
```

### 1.2 Full reset + reseed (only if needed / agreed with the team)

```bash
npm run db:push          # sync schema + auto-apply ledger triggers and CHECK constraints (#847)
npm run db:seed:medium   # or db:seed / db:seed:small / db:seed:large
```

`npm run db:push` now chains the sidecars (`db:triggers` then `db:constraints`)
after the schema push, so the raw-SQL CHECK constraints and ledger triggers are
applied automatically. Running `npm run db:constraints` separately afterwards is
redundant, though harmless.

### 1.3 Credentials

Every seeded user shares one password: `SEED_PASSWORD` env, default
**`SeedPass123!`** (`prisma/seedFiles/1a-create-users.ts`).

Seeded org shapes (`prisma/seedFiles/15a-create-organizations.ts`):

| Org | Shape | Funding | Use for |
|---|---|---|---|
| Wipro | pure SPONSOR | INVOICE (LICENSED_SEAT program) | invoice-funded booking tests |
| LearnPro Agency | pure HOST | WALLET (CREDIT_POOL program) | **org-wallet refund tests (#835)** |
| IIT Madras | HYBRID | WALLET + payout account | 3-way split, clawback tests |
| Rahul | solo consultant | — | plain B2C control group |

Find concrete emails per role:

```bash
npx tsx -e "import p from '@/lib/prisma'; p.user.findMany({ where: { role: 'CONSULTEE' }, select: { email: true }, take: 5 }).then(r => { console.log(r); process.exit(0); })"
```

### 1.4 Server & harness

```bash
npm run dev                          # app at http://localhost:3000
npm run test:chaos:api               # real-API chaos categories 07 + 09
CHAOS_BASE_URL=https://staging.x npm run test:chaos:api   # other target
```

Scenarios call `ensureServerOrSkip()` — with no reachable server they SKIP
cleanly (exit 0), so a forgotten dev server shows as SKIP lines, not failures.
Webhook-signing scenarios additionally need `RAZORPAY_WEBHOOK_SECRET` in env.

Run one scenario alone:

```bash
npx tsx tests/typescript/race-conditions/master-runner.ts sequential \
  --category=07-real-api-booking --test=test-cancel-pending-vs-webhook
```

---

## 2. Route matrix — new/changed surfaces (complex params)

Legend: ✓ = expected success; codes are the **only** acceptable outcomes.
Anything 5xx anywhere is a P0 finding.

### 2.1 `DELETE /api/checkout/pending/[paymentId]` (#849 — NEW)

Precondition: a PENDING gateway payment owned by the caller. Mock checkout
confirms instantly, so create the fixture directly (see §4.1 snippet) or
abandon a real Razorpay checkout popup mid-flow.

| # | Caller | paymentId state | Expect | Assert (DB) |
|---|---|---|---|---|
| 1 | owner | PENDING, consultation parent APPROVED_PENDING_PAYMENT | 200 `{success, slotsReleased}` | payment EXPIRED; 0 tentative slots; parent CANCELLED + cancellationNotes "Cancelled by user during checkout" |
| 2 | owner | PENDING, webinar (shared appointment, 2+ users tentative) | 200 | only the CALLER's tentative slot deleted; other users' slots intact |
| 3 | owner | PENDING, class (multi-session) | 200 | caller's tentative slots across ALL class appointments deleted |
| 4 | owner | SUCCEEDED | 409 | zero writes |
| 5 | owner | already EXPIRED (double-cancel) | 409 | zero writes |
| 6 | owner | PENDING but parent already SCHEDULED (another payment won) | 409 | full rollback — payment STAYS PENDING |
| 7 | **different user** | PENDING | 404 (never 403 — don't leak existence) | zero writes |
| 8 | unauthenticated | any | 401 | — |
| 9 | owner | nonexistent uuid | 404 | — |
| 10 | owner, 11 rapid calls in 1 min | any | 11th returns 429 (`cancelPendingLimiter` 10/min) | — |

Dashboard wire-up: consultee dashboard → home → Pending Payments widget →
`gateway_pending` item shows **Processing + Cancel**. Click Cancel → confirm →
item disappears on refetch; a 409 shows the "already confirmed" notice bar.

### 2.2 Refund cascade with org-wallet funding (#835)

Fixture: LearnPro/IIT Madras WALLET-funded payment with a WALLET PaymentLeg
(seeded; or book as a sponsored LEARNER member). Refund via the admin refund
surface or `refundPayment()`.

| # | Scenario | Assert |
|---|---|---|
| 1 | Full refund of WALLET-funded payment (organizationId set) | `OrgAuditLog` row `category=WALLET, action=WALLET_REFUND` with `details.amountPaise` = wallet-leg reversal AND `details.balanceAfterPaise`; wallet balance restored; existing INVOICE_REFUNDED row still present (dual-row is intended) |
| 2 | Full refund where **Payment.organizationId is NULL** but billingAccount belongs to an org | WALLET row still written — org resolved via `BillingAccount.ownerOrgId` (the original invisible path) |
| 3 | Partial 50% refund ×2 | one WALLET row per refund event, each with the proportional amount; no drift in wallet balance |
| 4 | Multi-leg WALLET + REFERRAL_CREDIT | exactly ONE WALLET row (credit leg produces none); referral credits restored |
| 5 | Refund with completed-payout clawback | PAYOUT_CLAWBACK row AND the WALLET row both present |

```sql
SELECT category, action, description, details
FROM "OrgAuditLog"
WHERE category = 'WALLET' AND action = 'WALLET_REFUND'
ORDER BY "createdAt" DESC LIMIT 5;
```

Org dashboard: org audit page filtered to category=WALLET must list the rows.

### 2.3 Payout job (#850)

Use `workflow_dispatch` on **Process Payouts** (or `npm run
scripts:process-payouts` locally with RazorpayX test creds).

| # | Scenario | Assert |
|---|---|---|
| 1 | Run with ≥1 APPROVED payout | GH outputs `processed/succeeded/failed/success`; payout PROCESSING with `providerPayoutId`; **TDS fields** (`tdsDeducted`, `netAmount`, `tdsRateAppliedBps`, `tdsFinancialYear`) populated (0 below ₹50K cumulative unless `TDS_ENGINE=194O`) |
| 2 | Two concurrent runs (dispatch twice fast) | each payout disbursed ONCE — loser's CAS claim skips (`skipped`, not failed); gateway sees one `X-Payout-Idempotency: payout_<id>` |
| 3 | Redis down / lock held with APPROVED payouts waiting | run exits **1** with `::error::` (silent-skip guard) — never a green no-op |
| 4 | Org payouts PENDING | advanced→PROCESSING only when `ENABLE_LIVE_PAYOUTS=true`; errors reported but don't block consultant disbursement |
| 5 | Env regression | Razorpay API calls must succeed with `RAZORPAYX_KEY_SECRET` or `RAZORPAY_SECRET` resolved — the payouts client never reads `RAZORPAY_KEY_SECRET`, and the job-level credential gate alone passing is NOT sufficient (handle-stuck/reconcile jobs gate on `RAZORPAY_SECRET ?? RAZORPAY_KEY_SECRET`, which can pass while the client secret is empty) |

### 2.4 Waitlist crons (#814/#821)

`workflow_dispatch` on **Send Waitlist Reminders** and **Process Waitlist
Expirations** (both have `dry_run` inputs).

| # | Scenario | Assert |
|---|---|---|
| 1 | Normal run | exit 0; reminders stamped `reminderSentAt`; expirations move NOTIFIED→EXPIRED + notify next in queue |
| 2 | Two overlapping runs (dispatch both within seconds) | second logs `⏭️` lock-held and exits **0** (not a failure issue) |
| 3 | Transient pooler timeout | `[connect-retry] … retrying` lines; run still green if retry succeeds |
| 4 | Repeat run after success | no duplicate reminder emails (reminderSentAt filter) |

### 2.5 Regression — checkout & webhooks (unchanged behavior to re-verify)

| Route | Cases |
|---|---|
| `POST /api/checkout` | same `clientIdempotencyKey` double-submit → one Payment row, second call replays the original response (#828); 6th call in 1 min → 429 |
| `POST /api/webhooks/razorpay` | signed `payment.captured` replay ×10 → one WebhookEvent row, all acknowledged 2xx; out-of-order events acknowledged + deduped |
| `POST /api/appointments/[id]/cancel` vs reschedule | chaos scenario 09 invariants (one winner, no resurrections) |

---

## 3. Multi-agent execution protocol

Five testers/agents, parallel, deliberately colliding. Reset/agree on fixtures
first (§1), then:

| Agent | Charter | Sections |
|---|---|---|
| A | cancel-pending happy paths + authz matrix (§2.1 #1-3, 7-10) | works alone |
| B | **pairs with C** on shared payment ids | §4.1, §4.2 races |
| C | **pairs with B**; also webhook replay regression | §4.1, §4.2, §2.5 |
| D | refunds + org audit (§2.2) + payout job (§2.3) | money paths |
| E | waitlist crons (§2.4) + last-seat enrollment storm (§4.3) | crons + capacity |

Every agent reports: scenario id, requests sent (method/path/params), response
codes, DB assertion results, and a pass/fail verdict. Any 5xx, any double
state-change, any money mismatch = file a GitHub issue with the transcript.

---

## 4. Deliberate cross-agent race scenarios

These REQUIRE two actors hitting the same resource within the same second
(use a shared countdown or run both commands from one shell with `&`).

### 4.1 Cancel-vs-cancel (Agents B + C)

Fixture (run once, both agents share the printed paymentId):

```bash
npx tsx -e "
import p from '@/lib/prisma';
(async () => {
  const appt = await p.appointment.findFirst({
    where: { consultation: { isNot: null }, slotsOfAppointment: { some: {} } },
    select: { id: true, consultation: { select: { id: true, requestedBy: { select: { user: { select: { id: true, email: true } } } } } } },
  });
  await p.consultation.update({ where: { id: appt!.consultation!.id }, data: { status: 'APPROVED_PENDING_PAYMENT' } });
  await p.slotOfAppointment.updateMany({ where: { appointmentId: appt!.id }, data: { isTentative: true } });
  const pay = await p.payment.create({ data: {
    amount: 10000, originalAmount: 10000, paymentMethod: 'card',
    paymentIntent: 'order_manual_race_' + Date.now(), paymentGateway: 'RAZORPAY',
    paymentStatus: 'PENDING', isMockPayment: true,
    userId: appt!.consultation!.requestedBy.user.id, appointmentId: appt!.id,
  }, select: { id: true } });
  console.log(JSON.stringify({ paymentId: pay.id, login: appt!.consultation!.requestedBy.user.email }));
  process.exit(0);
})()"
```

Both agents log in as the printed user and fire `DELETE
/api/checkout/pending/<paymentId>` simultaneously.

**Invariant**: exactly one 200, one 409; payment EXPIRED once; parent
CANCELLED once; no 5xx.

### 4.2 Cancel-vs-webhook-confirm (Agents B + C)

Same fixture shape; agent B fires the DELETE while agent C posts a signed
`payment.captured` for the fixture's `paymentIntent` (HMAC-SHA256 of the raw
body with `RAZORPAY_WEBHOOK_SECRET`, header `x-razorpay-signature`).
Automated equivalent: `test-cancel-pending-vs-webhook` (runs in
`npm run test:chaos:api`).

**Invariants**: webhook acknowledged 2xx always; payment never stays PENDING; end
state is exactly one of — EXPIRED + slots deleted + parent CANCELLED (cancel
won), SUCCEEDED + slots confirmed + cancel 409 (webhook won), or the
documented late-capture orphan: SUCCEEDED after a 200 cancel with slots
deleted + parent CANCELLED (reconciler must flag it for refund — check
`reconcile-orphaned-confirmations` output). Never a half-confirmed mix.

### 4.3 Last-seat enrollment storm (Agent E, optionally + A)

Pick a seeded webinar with 1 remaining seat (or shrink capacity via Prisma).
Fire N≥10 concurrent checkouts from different seeded consultees.

**Invariants**: at most one enrollment wins the seat; losers get a clean
4xx/waitlist path, never 5xx; `SlotOfAppointment` user-join rows ≤ capacity;
no duplicate Payment rows per user (idempotency keys).

### 4.4 Waitlist-expire vs booking (Agent E)

Arm a NOTIFIED waitlist entry with `expiresAt` in the past, then dispatch the
expiration workflow while the notified user books the seat through checkout.

**Invariant**: the seat is either booked by the notified user OR re-offered to
the next in queue — never both; the entry ends in exactly one of
BOOKED/EXPIRED.

### 4.5 Checkout idempotency replay (Agent C)

`POST /api/checkout` twice concurrently with the SAME `clientIdempotencyKey`.

**Invariant**: one Payment row; both responses describe the same attempt
(P2002 → replay, #828).

---

## 5. Automated suites (run before AND after the manual pass)

```bash
npx tsc --noEmit                          # types
npx jest                                  # unit/integration (~1340 tests)
npm run lint                              # eslint
npm run dev & npm run test:chaos:api      # real-API chaos: categories 07 + 09
npm run test:race                         # full race-condition harness
```

Chaos category 07 now includes `test-cancel-pending-vs-webhook` (#849) and
`test-last-seat-storm` (capacity race regression — exactly one winner for a
single free webinar seat).

DB-level backstop (#440): the `slot_no_confirmed_overlap` exclusion
constraint (applied automatically by `npm run db:push`, which now chains
`db:constraints`) rejects two CONFIRMED overlapping slots for one consultant at
the database. Verify after any reset: a direct duplicate-window insert with
`isTentative=false` and a set `consultantProfileId` must fail with an exclusion
violation; tentative and back-to-back inserts must succeed.

## 6. Reporting

One findings doc per run: scenario → verdict → evidence (response codes, SQL
output). P0 = money wrong / double-booking / 5xx on the matrix. P1 = wrong
status code / missing audit row / UX dead-end. P2 = polish. File P0/P1 as
GitHub issues tagged `bug` + the relevant issue number from this train.
