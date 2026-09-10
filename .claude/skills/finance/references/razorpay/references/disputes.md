# Disputes and chargebacks

Razorpay has no API for *managing* disputes — they are raised by the issuing bank, worked
in the Razorpay Dashboard, and surfaced to us purely through webhooks. Everything here is
therefore event-driven.

## The six events

`payment.dispute.*` is a real event family, and this repo handles all of it. The payload
carries both the payment and the dispute entity.

| Event | Meaning | Handler |
|---|---|---|
| `payment.dispute.created` | A chargeback has been raised | `handleDisputeCreated` |
| `payment.dispute.under_review` | Razorpay/the bank is assessing | `handleDisputeUpdated` |
| `payment.dispute.action_required` | Evidence needed from us before `dueBy` | `handleDisputeUpdated` |
| `payment.dispute.won` | Resolved in our favour; funds retained | `handleDisputeUpdated` |
| `payment.dispute.lost` | Resolved against us; funds debited | `handleDisputeUpdated` |
| `payment.dispute.closed` | Terminal | `handleDisputeUpdated` |

Dispatch is in `app/api/webhooks/razorpay-dispatch.ts`. Note that `closed` maps to the
`DisputeStatus.CLOSED` enum value — the mapping is explicit in `prisma/schema.prisma`,
because Razorpay's `closed` is not the same thing as `won` or `lost`.

Source: <https://razorpay.com/docs/webhooks/disputes/>

## Why disputes block refunds

`refundPayment` throws `REFUND_BLOCKED_BY_DISPUTE` when the payment has an open dispute.
This is not a nicety. If you refund a payment that is simultaneously being charged back,
you can pay the same money out twice — once to the customer via the refund and once to the
bank when the dispute is lost. Resolve the dispute first, then decide.

`Dispute.isChargeRefundable` records whether Razorpay considers the underlying charge
still refundable, and `dueBy` is the evidence deadline. `action_required` events with a
near `dueBy` are the ones worth alerting a human about — miss the deadline and the dispute
is lost by default.

## Ledger effects

A lost dispute is real money leaving. The B2C chargeback path posts counter-legs rather
than mutating the original payment — see `__tests__/payments/b2c-chargeback-ledger.test.ts`
and `__tests__/payments/dispute-refund-correctness.test.ts` for the invariants. Do not
"fix" a lost dispute by editing the `Payment` row.

## Testing

Disputes cannot be triggered in test mode. The only way to exercise this path is to send a
signed synthetic webhook at `/api/webhooks/razorpay` — see `local-testing.md` for the
signing recipe, and use the dev-only simulator at `app/api/dev/mock-webhook/route.ts`.
