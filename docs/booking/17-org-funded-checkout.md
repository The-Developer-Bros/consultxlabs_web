# Org-Funded Checkout

## Overview

Every booking — self-funded or employer-sponsored — enters through the **same** checkout operation (`handleCheckout()` in `lib/payments/operations/checkout.ts`); there is no separate B2B endpoint. What makes a booking org-funded is one optional input: when the client passes `organizationId`, checkout resolves the org's funding context up front and, for the sponsored funding sources, **skips the payment gateway entirely** — the appointment is confirmed in the same transaction with no webhook, no client payment step, and a synthetic payment-intent id.

This document walks that rail from resolution to settlement, from the booking system's point of view. The payments-side view of the same seam (payment legs, refund audit rows, wallet lifecycle) is [`docs/payments/05-b2c-b2b-funding-seam.md`](../payments/05-b2c-b2b-funding-seam.md); the enterprise money model behind it is [`docs/enterprise/10-money-and-ledger/`](../enterprise/10-money-and-ledger/). For the ordinary gateway path this document builds on, read [10-checkout-payment-integration.md](./10-checkout-payment-integration.md) first.

The four funding sources behave as follows (`BillingAccount.fundingSource`, `prisma/schema.prisma`).

| fundingSource | Who pays, and when                                                  | Gateway?                      |
| ------------- | ------------------------------------------------------------------- | ----------------------------- |
| `PERSONAL`    | The learner's own card; the org is tagged for reporting only        | Yes — ordinary two-phase flow |
| `WALLET`      | The org's prepaid wallet, debited atomically at checkout            | No                            |
| `INVOICE`     | Nobody at checkout; the amount accrues to the org's monthly invoice | No                            |
| `LICENSE`     | Absorbed by a LICENSED_SEAT program; the amount billed is 0         | No                            |

---

## The resolution chain

When `validatedData.organizationId` is present, `handleCheckout()` resolves the org context before any pricing or locking (`lib/payments/operations/checkout.ts`). Each gate fails closed with a thrown error; the order below is the order in the code.

1. **Org exists and may transact.** The org must be `ACTIVE` — or `PENDING_VERIFICATION`, which is allowed to transact only under the INVOICE credit-limit gate below (#687).
2. **`canSponsor` gate.** An org not configured to sponsor bookings (`canSponsor: false`) is rejected outright.
3. **Overdue-invoice suspension** (config-gated by `ENABLE_DUNNING_SUSPEND`, default off — #812). If the dunning cron has stamped `dunningSuspendedAt` on any still-`OVERDUE` invoice, new sponsored bookings are blocked, citing the oldest overdue invoice; paying it lifts the gate naturally.
4. **ACTIVE membership.** The booking user must hold an `ACTIVE` `Membership` at the org.
5. **DPDP consent** (#701). The member needs a live `SESSION_BOOKING` consent artifact (`checkConsent`) before the org can book and pay on their behalf; the check fails closed with a 403-shaped `CONSENT_REQUIRED` error.
6. **fundingSource from the org's BillingAccount**: `fundingSource = org.billingAccount?.fundingSource ?? "PERSONAL"`. Personal referral credits are stripped from the request on any non-PERSONAL source — org money and personal credits never stack.
7. **INVOICE-specific gates.** INVOICE funding requires a verified org domain (`assertVerifiedDomainOrThrow`, K-02/#687), and the org's exposure — unbilled succeeded accruals plus outstanding `ISSUED`/`OVERDUE` invoices — must sit below the effective credit limit (the explicit `creditLimit`, floored by the governance default for unverified orgs). The effective limit (`creditEffectiveLimit`) is threaded into the Serializable booking transaction and **re-checked there** so a concurrent booking cannot slip past it (#785 B6).
8. **ProgramAssignment resolution.** Every non-PERSONAL path requires a currently-active `ProgramAssignment` for the member whose ACTIVE Program covers this `appointmentType` (an empty `coveredPlanTypes` covers everything) under an ACTIVE contract within its effective window. **A missing assignment fails closed: checkout throws** ("No active program assignment covers this booking…") **rather than silently billing the learner's card**. The assignment is the source of truth for "is this booking sponsored?".
9. **ADR 18 gates, inside the lock** (the `revalidateInsideLock` function). The resolved Program's id is carried into the locked revalidation, where two checks run race-safely: the **curated-panel allowlist** — rows on `ProgramConsultantAllowlist` restrict org-sponsored bookings to listed consultants, zero rows keep the sponsor network open — and **`exclusiveEngagement`**, which blocks booking a consultant's independent (non-org-owned) plans while any ACTIVE membership declares exclusivity. Self-booking one's own plan is rejected on the same pass.

`handleCheckout()`'s doc comment states the doctrine in one line: a missing assignment on a WALLET/INVOICE/LICENSE org **refuses rather than silently bills the learner's card**.

---

## Skipping the gateway

After the distributed lock is held and revalidation passes, checkout derives the sponsorship booleans: each of `isOrgWalletPayment` / `isOrgInvoicedPayment` / `isOrgLicensedPayment` requires **both** the funding source and a resolved `programAssignmentId`, and their union is `isOrgSponsoredPayment`. For a sponsored payment no gateway order is created; a synthetic payment-intent id is minted locally with the rail encoded in its prefix:

```
org_wallet_<ts>_<rand>   |   org_invoice_<ts>_<rand>   |   org_license_<ts>_<rand>
```

(The sibling zero-amount path mints `free_…` ids the same way.) Inside the Serializable booking transaction, the `skipPayment` flag then changes three things at once: appointment slots are created **confirmed** rather than tentative, the `Payment` row is written with `paymentStatus: SUCCEEDED` and no `expiresAt` (with `paymentMethod` mapped to `WALLET`/`INVOICE`/`LICENSE`), and no webhook is ever needed to complete the booking. The row carries `organizationId` and `billingAccountId` so the reporting tag and the settlement pointer both survive — see the funding-seam doc for why those are different questions.

### The WALLET debit

For wallet funding the same transaction debits the org's balance. Two guards apply. First, a wallet frozen by the ledger reconciler (cache drifted from the journal) refuses to spend (`isWalletFrozen`, #837). Second, the debit itself is `walletDebit()`'s **atomic conditional `updateMany`** in `lib/api/organizations/wallet.ts`: the UPDATE matches only a row whose `walletBalance` is already `>= amount` and decrements it in the same statement, so two concurrent debits cannot overdraw — the loser matches zero rows and throws `WalletInsufficientFundsError`, rolling the booking back. No journal entry posts here; the accounting leg posts at settlement, where the full fee/payable split is known.

### Engagement debits: CLASS at checkout, SUBSCRIPTION lazily

Sponsored bookings consume **engagements** against the member's program cap (#710); one engagement is one `Appointment` row, one calendar occurrence. The per-type behavior differs deliberately:

- **CONSULTATION / WEBINAR** debit **1** engagement at checkout.
- **CLASS** debits **N** engagements at checkout — the count of class appointments the learner enrolled in, all known up front because the consultant pre-allocated the sessions (`classResult.engagementsConsumed`).
- **SUBSCRIPTION** debits **nothing** at checkout (`engagementsForCap` stays `null`). Slots are allocated lazily by the consultant later, so the debit lands in `SlotAllocationService.createAppointments`, one per allocation batch.

The debit is `recordBookingUtilization()`, which writes the `BookingUtilization` row and the `PaymentLeg` describing where the money or commitment actually came from. Breaching a `BLOCK`-behavior cap throws `ProgramAssignmentLimitError`, rolls the transaction back, and fires a bell notification to the assignee and org operators.

---

## Settlement, and what happens when it fails

Sponsored payments bypass webhooks, so the settlement that `handlePaymentSuccess()` performs for gateway payments runs **inline at checkout** for the mock/zero/sponsored family: referral qualifying action, then `createEarningsFromPayment()` (`lib/payments/payouts/earnings-service.ts`).

Settlement is where the money truth is written, atomically: the `ConsultantEarnings` rows (parked `PENDING_TRUST` when the sponsor is an unverified INVOICE org, #687 E-02), any `OrganizationEarnings` rows, and the balanced double-entry **booking journal** posted with idempotency key `booking:<paymentId>`. A non-retryable posting failure records the drift as a `LEDGER` system error on its own connection and **re-throws so the whole earnings transaction rolls back** — earnings never commit without their journal (a `P2034` serialization conflict is instead retried by `withSerializableRetry`).

One nuance matters on this rail: at that point the **booking transaction has already committed** — the appointment is confirmed and, for WALLET, the org's money has moved. Checkout therefore does not pretend the booking failed; it pages (`recordSystemError`, C-01 #837) and relies on the `sync-payment-earnings` sweep, keyed on row state (SUCCEEDED payment with no earnings), to re-drive settlement idempotently. On the webhook path the same rollback protects the confirmation work batched with it; on this path the healer is the sweep.

---

## Refunds on this rail

An org-funded booking carries a synthetic `org_*` intent that no gateway can resolve, so its refund is **internal**: `refundBookingPayment()` (`lib/payments/operations/booking-refund.ts`) splits the rails on `isInternalFundedIntent()` — gateway/mock money goes through the two-phase gateway refund, org-funded money reverses purely in-ledger through the reversal engine (wallet credited back, invoice accrual netted by a `*_REVERSAL` leg, license engagements restored). Event-wide refunds use `refundWholeEventPayments()` (`lib/payments/operations/event-refunds.ts`), which made the same split first. The full cascade, including the org audit rows it writes, is in the funding-seam doc and [08-cancellation-flow.md](./08-cancellation-flow.md).

## Whose cancellation policy applies

An organisation may publish its own refund ladder, and that ladder governs the bookings the organisation **funds** — the WALLET, INVOICE and LICENSE rails described above, plus any other path where `isOrgSponsoredPayment` is true. The reasoning is the same one that decides every other question on this page: on a cancellation it is the organisation's money that comes back, so the organisation's terms are the ones that bind. A booking a member pays for personally keeps the platform ladder even when it is tagged to an organisation, because the refund settles to the member.

`handleCheckout()` resolves the governing version exactly once, inside the booking transaction, by calling `resolveCheckoutCancellationPolicyId()` with the organisation id on the sponsored path and null everywhere else. The resolver answers the organisation's newest `ACTIVE` version, and falls back to the platform row when the organisation has never published one. The resulting id is stamped on the appointment as `cancellationPolicyId`, so the terms a booking was sold under survive any later edit: publishing a new ladder archives the old version rather than rewriting it. Sessions allocated later against a subscription inherit the id from the row checkout created rather than resolving again.

One case falls back to the platform ladder by construction. A webinar or class has a single shared `Appointment` row for the whole event, across every registrant and therefore across every funding organisation, so no one organisation's terms can be stamped on it. Its policy pointer stays null, the platform ladder applies, and organisation tiers do not reach event seats. Whole-event refunds already assumed the platform terms, so this is consistent rather than merely tolerated, but it is a real limitation: reaching event seats would require the participant row rather than the event row to carry the terms.

The editor is `PUT /api/organizations/{orgId}/cancellation-policy`, restricted to an OWNER because the free-text `defaultCancellationPolicy` on the organisation is already OWNER-only and `MemberRole` has no ADMIN tier to widen to. Reading the policy needs `settings.manage`, matching the rest of the organisation settings surface.

---

---

## Where to look

The pointers below are the fastest paths into the code and the neighboring docs. They cite the file and the function or flag name, not a line number — `checkout.ts` has drifted 500-700 lines since this document was first line-cited, and will keep drifting.

| Concern                                              | Location                                                                                                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolution chain + gates                             | `lib/payments/operations/checkout.ts`, inside `handleCheckout()`                                                                                                                                         |
| ADR 18 allowlist/exclusivity (in-lock)               | `lib/payments/operations/checkout.ts`, the `revalidateInsideLock()` function; `docs/enterprise/70-design-decisions/18-open-b2b-b2c-boundary.md`                                                          |
| Gateway skip + synthetic ids                         | `lib/payments/operations/checkout.ts`, the `isOrgWalletPayment` / `isOrgInvoicedPayment` / `isOrgLicensedPayment` / `isOrgSponsoredPayment` booleans and the `skipPayment` flag                          |
| Wallet debit (atomic conditional updateMany)         | `lib/api/organizations/wallet.ts`, `walletDebit()`                                                                                                                                                       |
| Engagement debits + caps                             | `recordBookingUtilization()` in `lib/api/organizations/program-helpers.ts`, called from `handleCheckout()`; lazy SUBSCRIPTION debit in `SlotAllocationService.createAppointments`                        |
| Inline settlement + ledger posting                   | `lib/payments/operations/checkout.ts`, the sponsored-family branch of the settlement block; `lib/payments/payouts/earnings-service.ts`, `createEarningsFromPayment()`                                    |
| Cancellation policy resolution + publishing          | `lib/payments/operations/cancellation-policy-store.ts`, `resolveCheckoutCancellationPolicyId()` and `publishOrgCancellationPolicy()`; the tier maths is `lib/payments/operations/cancellation-policy.ts` |
| Payments-side seam (legs, refunds, wallet lifecycle) | `docs/payments/05-b2c-b2b-funding-seam.md`                                                                                                                                                               |
| Enterprise money model                               | `docs/enterprise/10-money-and-ledger/`                                                                                                                                                                   |
