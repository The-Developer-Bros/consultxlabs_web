---
name: booking-money-boundary
description: Where the booking subsystem touches money — the tentative hold and Payment.expiresAt, mock and zero-amount payments, the one price derivation, the one refund quote, the three funding rails, EXPIRED versus REJECTED versus CANCELLED, the earnings healer, and everything checkout re-validates inside its lock. Load when changing checkout, a payment hold, a refund amount or rail, a cancellation quote, earnings accrual, or anything under lib/payments/pricing/, lib/payments/operations/, or app/api/checkout.
---

# Booking Money Boundary

Booking and money meet at four seams: the hold that reserves a slot before the
money lands, the price the buyer is charged, the amount a cancellation returns,
and the earnings that accrue afterwards. Each seam has exactly one implementation
on purpose, because two implementations of a number is how a quote and a charge
come to disagree.

## 1. The hold is a tentative slot plus `Payment.expiresAt`

Checkout writes a `Payment` and its slot atoms together. When real money is
involved the payment is `PENDING`, the slots are created with `isTentative:
true`, and `expiresAt` is set thirty minutes out. That window is an inline
`new Date(Date.now() + 30 * 60 * 1000)` in
`lib/payments/operations/checkout.ts` with a trailing comment — **there is no
named constant**, so if you change it, grep rather than trusting a symbol. The
abandoned-payments sweep mirrors it independently with a 35-minute buffer for
legacy rows that carry a null `expiresAt`. `Payment` is indexed on
`[expiresAt, paymentStatus]` for exactly this cohort.

When checkout supersedes an earlier open order for the same buyer and plan it
stamps the old row `EXPIRED` with `expiresAt: new Date()`, so its hold dies
immediately rather than at the original deadline. `PaymentStatus` has exactly
four values — `PENDING`, `SUCCEEDED`, `FAILED`, `EXPIRED` — with no `CAPTURED`;
`SUCCEEDED` is the success terminal and `EXPIRED` means timed out rather than
gateway-rejected. See `references/availability.md` for when such a hold stops
occupying its slot.

## 2. Mock, zero-amount and org-funded payments share one bypass

`isMockPayment` is read from the **raw request body**, not from `checkoutSchema`,
and is gated by `body.isMockPayment === true && process.env.NODE_ENV ===
"development"`. That is a strict equality, so it is unavailable in production and
also in `test` and preview builds; a client cannot set it anywhere that matters.

Inside checkout it feeds `skipPayment = isMockPayment || isZeroAmountPayment ||
isOrgSponsoredPayment`, and that one flag drives the whole bypass: the payment
is written `SUCCEEDED` rather than `PENDING`, `expiresAt` is null, slots are
created non-tentative (`isTentative: !skipPayment`), the gateway call is skipped
and earnings are created inline instead of by webhook. Note the trap: the
persisted `Payment.isMockPayment` column is set true for all three cases, so the
column does **not** mean "a developer's mock" — do not filter production
analytics on it expecting only test rows.

## 3. One price derivation

`deriveCheckoutAmount` (`lib/payments/pricing/derive-checkout-amount.ts`) is the
only place a checkout price is computed, with exactly one production call site,
inside checkout's transaction. It works in **integer paise as plain `number`**,
not BigInt. The fixed order of operations is why it is centralised: list price,
discount, tax on the discounted base, then referral credits against the
tax-inclusive total. It returns `originalAmount`, `discountPaise`,
`discountedAmount`, `taxAmount`, `taxRate`, `isZeroRated`, `taxedAmount`,
`creditsApplied`, `amount`, `isInternational` and `tax`. Its helpers
`computeDiscountPaise` (which multiplies before dividing, and throws outright on
a negative `discountValue` or `maxDiscount`, since either would raise the price
above list) and `isCreditRedemptionEligible` are exported only so the parity
suite can drive them; neither has a production call site outside the module, and
neither should be reimplemented.

## 4. One refund quote

As of wave 5 (#1327), `quoteBookingRefund` in
`lib/payments/operations/cancellation-policy.ts` is the only refund
calculation, and both the cancel POST route and the `cancel/preview` GET route
call it. It returns `refundPct`, `tierRefundPct`, `noticeHours`,
`proratedBasePaise`, `prorated`, `refundPaise` and `creditRestoresInFull`. Unlike
the price derivation it **does** use BigInt for its two multiplications, on the
stated grounds that the products can leave the safe-integer range long before the
amounts stop being real money. A booking that was never scheduled has
`noticeHours` of positive infinity, so it sits in the top tier rather than the
already-started floor. `PLATFORM_DEFAULT_TIERS` is 100% at 24 hours, 50% at 2
hours, 0% below.

A quote that restates the rule is a rule that can drift from the charge. If you
change a tier, a proration denominator or a clamp, change it here.

**The tiers are typed rows, not a Json snapshot (#1499).** `CancellationPolicy` +
`CancellationPolicyTier` hold one published, immutable version of a ladder;
`Appointment.cancellationPolicyId` points at the version that governed the sale.
`Appointment.cancellationPolicySnapshot` is FROZEN — never written, never read,
dropped at the reset — so do not add a reader for it. Loading and publishing live
in `lib/payments/operations/cancellation-policy-store.ts`
(`POLICY_TERMS_INCLUDE`, `termsFromPolicyRow`, `ensurePlatformCancellationPolicy`,
`resolveCheckoutCancellationPolicyId`, `publishOrgCancellationPolicy`); the maths
module above stays Prisma-free. Checkout resolves the version once inside the
booking transaction, and an org's ladder governs only the bookings that **org
funds** — a personal booking merely tagged to an org keeps the platform ladder.
Webinar and class seats always use the platform ladder, because one shared
`Appointment` serves every registrant. Editing a ladder publishes a new version
and archives the old one under `withSerializableRetry`; nothing updates a version
in place.

## 5. Refunds travel on three rails, and the rail is named before the click

`FundingRail` is `"GATEWAY" | "INTERNAL" | "CREDITS"`, decided from the payment
intent prefix: `org_` is `INTERNAL` (an in-ledger reversal against the org's
wallet, invoice or licence), `free_` is `CREDITS` (referral credits restored,
no gateway money), everything else is `GATEWAY`. The two front doors are
`refundBookingPayment` and `refundWholeEventPayments`, plus
`refundRemovedAttendeeSeat` for one seat; see the booking doctrine in `../SKILL.md`.
`refundBookingPayment` refuses a partial `amountPaise` on the credits rail with
`RefundValidationError` / `INVALID_AMOUNT`.

**The credits rail cannot pay a fraction, so #1500 rounds the tier, not the
rail.** A booking funded entirely by credit (`free_` intent **and** amount 0)
restores its credit IN FULL inside any tier above 0%, and restores NOTHING inside
a 0% tier — a late cancel bites a credit buyer exactly as it bites a card buyer.
The whole rule is one predicate in `quoteBookingRefund`
(`isFreeCreditFunded && refundPct > 0`) surfaced as `creditRestoresInFull`; the
cancel route calls `refundBookingPayment` with no `amountPaise` when it is true
and falls through to `POLICY_ZERO` when it is not. There is no `MANUAL_REVIEW`
status any more. A `free_` intent with a NON-zero amount is a mixed payment that
still settles on the money arm and is still refused `INVALID_AMOUNT`; both halves
of the predicate are load-bearing.

As of wave 5 (#1325) the rail is also computed **ahead of the refund** by
`fundingRailForIntent` (`lib/payments/operations/booking-refund.ts`), so the
cancel dialog can say which way the money comes back. `GET
/api/appointments/{appointmentId}/cancel/preview` surfaces it as `fundingRail`,
and the cancel POST response carries `rail`. Both readings come from the same
two prefixes, which is the point: the dialog used to promise every learner that
their card would be credited in five to seven working days, including learners
whose card was never charged. For a whole-event cancellation `fundingRail` is
deliberately `null` — the seats of one event may be funded through several rails
at once, so no single sentence is true of the aggregate.

## 6. EXPIRED, REJECTED and CANCELLED are three different stories

`EXPIRED` means a window lapsed: nobody paid in time, or an approved request was
never allocated. `REJECTED` means the consultant declined, and reads that way on
every surface. `CANCELLED` means a party with standing ended a live booking.
Picking the wrong one is a user-facing lie even when the row state is otherwise
correct, and it changes which refund path runs.

## 7. The earnings healer has no age window

`scripts/earnings/sync-payment-earnings.ts` repairs payments that are
`SUCCEEDED` but carry no `ConsultantEarnings`, accruing the earning and its
balanced `booking:<paymentId>` ledger journal. As of wave 5 (#1327) its cohort
has **no `createdAt` filter at all**: it used to look back thirty days, so a
payment unaccrued for a month left the cohort silently and the consultant was
never paid for a session they had delivered. There is no age at which money
stops being owed. Runtime is bounded instead by `MAX_PAYMENTS_PER_RUN` (500),
oldest first, so a backlog drains across runs. An age threshold survives only
for _alerting_: `UNACCRUED_ALERT_AFTER_HOURS` is 24, after which a payment that
resolves no consultant is escalated as `EARNINGS_UNACCRUABLE_NO_CONSULTANT`.

## 8. What checkout re-validates inside the lock

Everything that could have changed between the pre-flight read and the write is
re-asserted after the lock is held, because a gate that ran before the lock is a
gate a concurrent writer walked through:

- The slot window against the union of published availability rows, atom by
  atom (see `references/availability.md`).
- Slot conflicts, via `validateSlotAvailability`, checkout's own in-transaction
  re-check. It subtracts `buildDeadHoldFilter(new Date())` from the occupancy
  query so a lapsed hold no longer blocks, and the consultee-side conflict reads
  beside it use the same subtraction for parity. (`revalidateConflicts` on
  `SlotValidationService` is the allocator's equivalent, not checkout's — do not
  cite it here.)
- The lock grant, renewed at the top of every Serializable attempt; lost
  ownership aborts the attempt.
- As of wave 5 (#1319, B2B gap 3) the **org funding context** — the org's
  `status` and `canSponsor` and the caller's membership status, re-read by id
  under the lock, because an org suspended or a membership revoked between the
  gate and the write previously still got a sponsored booking. The credit limit
  is re-checked inside the Serializable booking transaction.

## 9. The pay-link mint is its own atom

The mint has its own guarded key nested under the approval lock, in the order
approval → mint; see `references/concurrency.md` §1.
