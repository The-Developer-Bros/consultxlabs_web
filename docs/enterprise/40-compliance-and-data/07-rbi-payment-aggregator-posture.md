---
title: RBI Payment Aggregator posture — funds-flow classification
band: 40-compliance-and-data
audience: founder / finance / sde2
status: live
last-reviewed: 2026-08-23
---

# Is Familiarise a payment aggregator? Current answer: no — by construction, and only while three things stay true

## Why this file exists

The RBI's Payment Aggregator/Payment Gateway directions (and the September
2025 revisions Razorpay began enforcing on Route users with a 31-Dec-2025
compliance deadline) draw one line that decides whether a platform needs RBI
authorisation: **does the entity accept or handle payments on behalf of
third-party sellers and transfer or settle those payments onward?** Pooled
balances are the common shape, not the legal prerequisite — a future direct
or split-settlement flow would fall inside scope just as fully. An
e-commerce marketplace doing so is deemed a PA even if it never calls itself
one. This memo records how Familiarise's actual money movement classifies
against that line, what would change the answer, and what must be kept true
in contracts and accounting so the classification stays valid. It exists
because this question was raised during the enterprise overhaul (#1230) with
no written answer, and an unwritten answer cannot survive a due-diligence
call or a bank KYC review.

## What the code actually does today (verified against dev @ fccda90f)

Collections run through standard Razorpay orders and checkout — a pure
payment-gateway relationship where settlement lands in the platform's own
regular account. There are **no** Razorpay Route linked accounts, no
`transfers.create` calls on the Razorpay side, and no split-settlement
configuration anywhere in `lib/payments/` (the only `transfers.create` in the
codebase is Stripe Connect, used by a different rail). Disbursements to
consultants and host organisations run through RazorpayX Payouts
(`lib/payments/payouts/razorpay-payouts.ts`), which moves money **out of the
platform's own RazorpayX account** after the fact; nothing about that flow
holds customer money in trust. Organisation wallet top-ups are pre-payments to
the platform itself — a customer liability (deferred revenue), not third-party
funds held for onward settlement.

## The classification

Under the principal model, Familiarise contracts in its own name on both
sides: it bills buyers (organisations or consumers) as the supplier of record
— which is why GST tax invoices issue from the platform, and why
refund/chargeback liability sits with the platform first — and it purchases
the consulting services wholesale from its consultants, paying them as its
own payables through RazorpayX. A principal is not an intermediary: no PA
authorisation is required, no nodal or escrow account structure applies, and
the Route eligibility questions never arise because Route is not used.

One deliberate caveat on the tax sentence above: **withholding on consultant
payouts is its own classification question and is NOT settled by
supplier-of-record status.** The consultant rail runs `TDS_ENGINE=LEGACY`,
which today preserves only the ₹50,000 threshold — the payout path records
section `194O` on its TDSRecords regardless, so do **not** request a 194J
payment code for it. `TdsRate.paymentCode` remains null and the return
exporter carries no payment-code mapping until the CBDT schema is final.
The retirement decision (194J → 194-O semantics) stays conditional on a
written CA sign-off (#738). Under the Income Tax Act 2025 renumbering
effective for transactions from 1 April 2026: non-resident withholding is
**§393(2)** (formerly s.195); the e-commerce-operator rule formerly
s.194-O lives in **§393(1), Table Sl. No. 8(v)**; and **§397(3)** governs
quarterly filing/reporting mechanics rather than the withholding itself.

## The three conditions that keep this true

First, the **terms of service must say the platform acts as principal** for
both buyer and consultant relationships. If the copy ever drifts to
"we connect you with independent consultants and pass your payment to them",
the de facto PA analysis flips, and the platform would need either RBI PA
authorisation (with escrow discipline and net-worth requirements) or
settlements routed through an authorised PA — most practically by adopting
Razorpay Route under Razorpay's own PA umbrella.

Second, the **accounting must treat wallet balances and pending payouts as
platform liabilities**, not as customer funds held in trust. They already sit
in the double-entry ledger as credits to customer accounts against CASH, which
is consistent; finance should preserve that treatment in statutory books too.

Third, **no product surface may introduce pass-through collection** — any
feature that lets a buyer pay a consultant directly through us as a conduit
(supplier-of-record = consultant, platform takes only a fee) reintroduces the
deemed-PA pattern and should be escalated before build, not after launch.

## Related obligations that exist regardless of classification

Payment-gateway-side duties still apply through Razorpay (KYC on our merchant
account, card-data rules we inherit by tokenisation). DPDP, GST-TCS §52,
194-O withholding, and MSME payment terms are independent of the PA question
and tracked in #738 and the compliance matrix elsewhere in this band.
