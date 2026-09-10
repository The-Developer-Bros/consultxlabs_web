# The money seam between B2C checkout and B2B funding

Organisation money flows through the same consumer-facing checkout as a personal card payment. This page describes what changes when the payer is an organisation: which funding rail collects the price, what each rail records, how overage is handled when a programme's cap is breached, and how the config-time refusals keep a rail from being asked to do something it structurally cannot.

## The four funding rails

`BillingAccount.fundingSource` selects the money path at checkout: **PERSONAL** tags the org for reporting only while the learner's own card pays; **WALLET** debits `BillingAccount.walletBalance` atomically; **INVOICE** accrues the charge to the organisation's monthly invoice with no real-time charge; and **LICENSE** is absorbed entirely by a `LICENSED_SEAT` programme assignment, billed at zero. Each of the three non-personal rails writes a distinct `PaymentLeg` source (`WALLET`, `INVOICE_ACCRUAL`, `LICENSE`), and for wallet and licence legs no gateway call happens at all — the `Payment` row is created at `SUCCEEDED` immediately, in the same transaction that confirms the appointment, because there is no asynchronous capture to wait for.

Three fields on `Payment` divide the responsibility of tracking that money once it has moved: `organizationId` is a reporting tag answering which org's member made the booking; `billingAccountId` is the settlement pointer identifying whose `BillingAccount` was charged; and `billableToOrgInvoiceId` is stamped once the accrual is rolled into a specific `OrganizationInvoice`, staying null while the charge is still pending in the current billing period.

## Overage: BLOCK, CHARGE_ORG, CHARGE_MEMBER, and the refusals

A programme's overage policy decides what happens once a member's booking would breach the programme's per-cycle cap. **BLOCK** refuses the booking outright once the cap and any circuit-breaker (`maxOveragePerCyclePaise`) are exhausted, surfaced as the modelled `PROGRAM_CAP_EXHAUSTED` refusal (HTTP 402) rather than an unclassified error. **CHARGE_ORG** carves the marginal amount into a distinct `OVERAGE_INVOICE_ACCRUAL` leg on the INVOICE rail so the month-end rollup bills exactly the over-cap portion once, without double-billing the base amount the parent `INVOICE_ACCRUAL` leg already covers. **CHARGE_MEMBER** redirects the marginal amount to a side-charge the member pays directly through `/dashboard/overage`.

The WALLET rail collects the whole nominal price at the moment the booking commits, so an overage on that rail is settled in the same debit rather than as a separate leg — writing an `OVERAGE_INVOICE_ACCRUAL` leg there would break the leg-sum identity and double-charge a later cancellation refund. That asymmetry is also why `CHARGE_MEMBER` is not available on a wallet-funded billing account at all: charging the member back out of a wallet-funded booking would require crediting the wallet mid-transaction, a credit-back path that does not exist, so the combination is refused at programme configuration time with a fail-closed `OVERAGE_CHARGE_MEMBER_UNSUPPORTED` (HTTP 409) for any programme that predates the guard.

## Wallet debit and credit; the NULL-cache seed

`walletDebit()` performs an atomic test-and-decrement of `BillingAccount.walletBalance` in the same transaction the `WALLET` leg is written, so a booking cannot be confirmed against a balance that has already been spent by a concurrent checkout. `walletCredit()` is the refund-side mirror, crediting the cache and writing the corresponding `Cr WALLET(org)` ledger entry. A newly created `BillingAccount` seeds its wallet balance as `NULL` rather than zero, which is a deliberate signal distinguishing "this org has never had a wallet balance computed" from "this org's wallet balance is exactly zero" — code that reads the balance must treat a `NULL` as needing initialisation, not as a debit failure.

## Invoice accrual, rollup, and dunning

An INVOICE-rail booking accrues an `INVOICE_ACCRUAL` (or `OVERAGE_INVOICE_ACCRUAL`) leg with no immediate cash movement. `rollupOrgInvoiceAccruals`, run monthly, sums every unbilled accrual leg for an organisation into one `OrganizationInvoice`, stamping `billableToOrgInvoiceId` on each `Payment` it consumed so a second rollup run does not re-bill the same charge. An invoice past its due date is marked `OVERDUE` by the dunning cron, which sends reminders on a fixed cadence; booking-suspension on terminal non-payment is gated behind a feature flag that defaults off, so an overdue invoice alone does not, by default, block the organisation's members from booking further sessions.

## Purchase-order draw-down

A `PurchaseOrder` gates an `OrganizationInvoice` by tracking `remainingAmountPaise`: an invoice cannot be issued against a purchase order whose remaining balance is insufficient, and each issued invoice decrements the balance in the same currency as the order. This is a spending-cap mechanism layered on top of the INVOICE rail, not a fifth funding rail of its own.

## Domain verification and consent gates

An organisation cannot fund bookings, or be billed for its members' overage, until its domain is verified and its billing consent is on record. Both checks are read at checkout time from the same transaction that decides the funding leg, so a booking cannot commit against an organisation whose verification lapsed between the page load and the checkout submit.

## Sources

`docs/payments/05-b2c-b2b-funding-seam.md`, `docs/enterprise/10-money-and-ledger/04-wallet-and-topups.md`, `docs/enterprise/10-money-and-ledger/05-booking-to-earnings.md`, `lib/enterprise/reachable-paths.ts`.
