# Cancellation Payment Flow

## Overview

When an appointment is cancelled, the payment system must handle potential refunds and earnings reversal. Critically, **refunds are NOT automatic** — they must be initiated separately by an admin.

---

## Pre-Payment (Pending) Self-Cancel (#849)

Before a payment has been completed, the user holds a **tentative slot** but no money has moved. In this window the user can self-cancel immediately without admin involvement:

**Endpoint:** `DELETE /api/checkout/pending/[paymentId]`

**Who can call:** The owner of the `paymentId` (session-scoped; 401 if not owner).

**Rate limit:** 10 requests/minute per user.

**What happens:**
1. A single Serializable transaction CAS-claims the payment (`PENDING → EXPIRED`). If the payment is already SUCCEEDED/EXPIRED/FAILED, the CAS matches zero rows and the endpoint returns a 409 — payment has already been settled.
2. Referral credits applied to this payment are reversed.
3. Tentative slots are released per-type:
   - **Class** — all of the caller's tentative slots across every session of the class.
   - **Webinar** — the caller's single tentative slot on the appointment.
   - **Consultation / Subscription** — all tentative slots on the appointment (1:1, so this is just the one slot).
4. The parent consultation/subscription status transitions to `CANCELLED` (narrow from-set: `PENDING` or `APPROVED_PENDING_PAYMENT` only). An `APPROVED` parent blocks the cancel — post-payment cancellations use the standard cancellation path below.
5. Post-commit, best-effort: the gateway payment intent / order is cancelled. Failure does not roll back the database cancel.
6. Write conflicts from Serializable retry exhaustion → **409 Conflict** (not 500).

**Response:**
```json
{ "success": true, "slotsReleased": 1 }
```

**Distinct from post-payment cancellation:** The flow below (admin-initiated cancellation + refund) applies only after `payment.paymentStatus = SUCCEEDED`. Pre-payment self-cancel uses the endpoint above; there is no refund because no money moved.

---

## Cancellation → Refund Flow

```
┌─────────────────────────────────────────────────────────────┐
│ USER CANCELS APPOINTMENT                                     │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ├─→ Appointment deleted
                   ├─→ Slots deleted
                   │
                   └─→ NO automatic refund
                       │
                       └─→ Admin initiates refund via API
                           └─→ Refund created (PENDING)
                               ├─→ Gateway processes
                               └─→ Earnings marked REFUNDED
                                   └─→ pendingRevenue decremented
```

### Why Refunds Are Decoupled

1. **Business flexibility** — allows partial refunds, refund denial, or delayed refunds
2. **Earnings safety** — if consultant earnings are already PAID, the platform would absorb the loss
3. **Dispute prevention** — admin can review before issuing refund

---

## Cancellation Reasons

The system tracks structured cancellation reasons for analytics:

| Category             | Reason                   | Code                     |
| -------------------- | ------------------------ | ------------------------ |
| User-initiated       | Scheduling conflict      | `SCHEDULE_CONFLICT`      |
| User-initiated       | Found another option     | `FOUND_ALTERNATIVE`      |
| User-initiated       | Cannot afford it         | `FINANCIAL_REASONS`      |
| User-initiated       | Unexpected situation     | `PERSONAL_EMERGENCY`     |
| User-initiated       | No longer needed         | `NO_LONGER_NEEDED`       |
| Consultant-initiated | Can't make it            | `CONSULTANT_UNAVAILABLE` |
| Consultant-initiated | Has an emergency         | `CONSULTANT_EMERGENCY`   |
| System-initiated     | Payment couldn't process | `PAYMENT_FAILED`         |
| System-initiated     | Booking expired          | `EXPIRED`                |
| Other                | Catchall                 | `OTHER`                  |

**Code location:** `app/api/appointments/[appointmentId]/cancel/route.ts`

---

## Refund Initiation (Two-Phase Pattern)

When an admin decides to refund a cancelled appointment:

**Phase 1: Create PENDING Refund (atomic transaction)**

- Validates payment status is `SUCCEEDED`
- Checks if consultant earnings have been `PAID` (blocks unless `forceRefund: true`)
- Creates refund record with `PENDING` status

**Phase 2: Call Payment Gateway (outside transaction)**

- Routes to Stripe or Razorpay based on original payment gateway
- Gateway processes the actual money reversal

**Phase 3: Update Status**

- Refund record updated to `SUCCEEDED` or `FAILED`

**Code location:** `app/api/payments/refunds/route.ts`

---

## Earnings Cascade on Refund

When a refund succeeds, consultant earnings must be reversed. This happens **asynchronously** via a scheduled job.

### Cascade Job

- **Schedule:** Every 15 minutes (GitHub Actions)
- **Code:** `scripts/refunds/cascade-refund-earnings.ts`
- **Logic:**
  1. Find all refunds with `status = SUCCEEDED`
  2. Check associated earnings are in `PENDING`, `HELD`, or `READY` status
  3. Mark earnings as `REFUNDED`
  4. Decrement consultant's `pendingRevenue`

### Earnings Refund Eligibility

| Earnings Status | Can be Refunded? | Notes                                 |
| --------------- | ---------------- | ------------------------------------- |
| `PENDING`       | Yes              | Still in hold period                  |
| `HELD`          | Yes              | Under dispute                         |
| `READY`         | Yes              | Available for payout but not yet sent |
| `PAID`          | No\*             | Already in consultant's bank          |
| `REFUNDED`      | N/A              | Already refunded (idempotent skip)    |

\*Can be force-refunded with `forceRefund: true` — platform absorbs the loss.

**Code location:** `lib/payments/payouts/earnings-service.ts` → `refundEarnings()`

---

## Related Documents

- [Refund Flow](../refunds-disputes/02-refund-flow.md) — Detailed two-phase refund pattern
- [Dispute Flow](../refunds-disputes/03-dispute-flow.md) — When customers dispute instead of requesting refund
- [Earnings Lifecycle](../payouts/02-earnings-lifecycle.md) — Complete earnings status machine
