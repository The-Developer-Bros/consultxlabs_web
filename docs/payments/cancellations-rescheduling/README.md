# Cancellations & Rescheduling - Payment Implications

Payment-side documentation for cancellation and rescheduling flows. Covers refund triggers, earnings cascade, and payment reuse.

> For booking-side docs (slot mechanics, API architecture, validation), see [booking/](../../booking/).

---

## Documents

| #   | Document                                                       | Description                                                           |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| 01  | [Cancellation Payment Flow](./01-cancellation-payment-flow.md) | How cancellations trigger refunds and the earnings cascade |
| 02  | [Rescheduling Payment Flow](./02-rescheduling-payment-flow.md) | No-refund flow, payment reuse, earnings unchanged                     |

## Key Principle

**Cancellation is a booking operation. Refund is a payment operation.** They are decoupled by design — cancelling an appointment does NOT automatically refund the payment. This enables business logic like manual refund approval, partial refunds, or handling cases where consultant earnings have already been paid out.
