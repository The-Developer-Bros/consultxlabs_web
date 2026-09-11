---
title: Settlement currency stays the Currency enum; gateway and display codes live in free-text fields
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-15
---

# ADR 15 — Settlement currency is the `Currency` enum, not free-text

## Context

ADR 02 fixed money as integer paise, and the v3 audit (#781 §A) converted the
`currency` column on every money-bearing row — `Payment`, `Refund`, `Dispute`,
`ConsultantEarnings`, `OrganizationEarnings`, the payout rows, and the plan
`priceCurrency` fields — from a free-text string to the four-value `Currency`
enum (`INR`, `USD`, `EUR`, `GBP`). A productionization review reopened the
question: should the settlement column instead be a free-text `String` guarded
by a database `CHECK`, so it can "faithfully store whatever ISO code a gateway
returns"? The concern behind the question is real — a strict enum could reject
a gateway response carrying a currency the platform does not model.

## Decision

Settlement currency stays the `Currency` enum. The concern that motivated the
free-text proposal is already handled by the schema as it stands: the raw,
buyer-facing currency code is captured separately in free-text fields that
exist for exactly that purpose — `Payment.displayCurrencyAtCheckout`,
`Refund.displayCurrency`, and `OrgWorkspaceProfile.currencyDisplayCode` — each
paired with an FX snapshot (`exchangeRateAtCheckout`, `exchangeRateAtRefund`).
The enum governs the value the platform actually settles and books to the
ledger, where a constrained, closed set is a stronger guarantee than a runtime
`CHECK`: it is enforced at both the type layer and the database, and it makes
an unsettleable currency a compile-time impossibility rather than a row that
slips through validation. Reverting it would trade that guarantee for nothing,
because gateway codes already have a home. The ledger itself remains
INR-denominated per #783, so settlement currency never varies in practice today.

`OrganizationInvoice.displayCurrency` intentionally keeps the enum rather than
matching the free-text display fields on `Payment` and `Refund`: an invoice is
a formal document and should render only a currency the platform can settle.

## Consequences for the gateway boundary

Gateway adapters receive arbitrary ISO strings and must normalise them at the
boundary. `toCurrencyEnum()` (in `lib/payments/validation/currency-guards.ts`)
is the single normaliser: it trims, upper-cases, and accepts only codes in the
enum, throwing on anything else so a webhook caller dead-letters the event
rather than settling a currency the platform cannot represent. That enum is
deliberately narrower than `SUPPORTED_CURRENCY_CODES` (in
`lib/currency-codes.ts`), which lists the display-only FX codes the navbar can
render and the checkout pages can estimate in, but which the platform cannot
settle; the two must not be conflated, and a comment in the guard cross-links
them. `CURRENCY_MULTIPLIERS` used to play that role and is referenced by older
revisions of this document; it was deleted in #1396 because nothing imported it.

The same file now carries `assertInrSettlement`, which is the enforcement half
of this decision. `toCurrencyEnum` says which currencies the platform can
represent; `assertInrSettlement` says which one it can actually settle, and it
runs as the first statement of both `createRazorpayOrder` and
`createStripeCheckoutSession`. A caller that reads a currency out of the
database and hands it to a gateway therefore fails loudly rather than minting an
order denominated in a foreign subunit.

This decision also closed three latent multi-currency defects found in the same
review. Ledger accounts must never be keyed by a row's settlement currency:
`postLedgerTxn` keys every account to INR (#783), and the organisation-payout
postings (both the settlement and the reversal legs) were forwarding
`payout.currency` into the account reference, which would have orphaned INR
paise in a foreign-labelled account the moment a non-INR payout existed. The
class-multi refund reversal path was dropping the FX snapshot that the
single-payment refund path preserves, so partial-class reversals lost their
audit trail. Both are now fixed, and the consultant-payout postings — which
already omitted currency — remain the reference pattern.
