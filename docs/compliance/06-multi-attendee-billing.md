# 06 — Multi-attendee billing (webinars / classes)

> **Status:** ⚠️ unverified. Schema appears to support per-attendee Payments / Invoices / TDS records, but the data path hasn't been audited end-to-end against multi-attendee tax events.
> **Audience:** booking + payment code; tax-aggregation code.
> **Last reviewed:** 2026-06-05 (regulatory facts web-verified as of 2026-06-05; prior review 2026-05-02). *No rate/threshold in this doc changed; framing updated for §393/0.5%-TCS/Form-140.*
> **Linked issues:** [#738 Item C](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

A consultant can sell a **WEBINAR** or **CLASS** plan with one session and N attendees (e.g. 1 webinar × 50 attendees). For tax purposes, each attendee's purchase is a **separate ECO transaction**:

| Per-attendee event | Per-attendee record |
|---|---|
| Consumer pays (B2C) or org pays for a member (B2B) | Separate `Payment` row |
| Tax invoice issued | Separate `Invoice` (B2C) or `OrganizationInvoice` line item (B2B) |
| 194O TDS calculated (0.1% — §393(1) Sl.8(v) code 1035 from 1-Apr-2026; see [doc 01](./01-tds-overview.md)) | Separate `TDSRecord` row, against the consultant's per-FY cumulative + ₹5L threshold |
| GST output liability (18%) | Separate per attendee, place-of-supply per attendee's state |
| GST TCS Sec 52 (B2C, registered consultant) — 0.5% net | Separate per attendee |

The consultant gets **one aggregated payout** for the session, but the underlying tax events are **per-attendee**.

This matters because:

- A 50-attendee webinar is 50 separate 194O transactions — each one counts toward the consultant's per-FY threshold.
- Place of supply varies per attendee — one webinar with attendees in 5 states yields 5 different PoS rows in GSTR-1.
- Refunding 1 attendee out of 50 needs to issue 1 credit note + reverse 1 TDS line + reduce 1 TCS line — see [doc 05](./05-refund-and-chargeback-tax-adjustments.md).

## When it applies

### B2C

- WEBINAR / CLASS plans purchased individually by N consumers. **Applies.**
- Each consumer transaction is independent at the tax level.

### B2B (org-sponsored)

- A WEBINAR / CLASS purchased by an org for N member-attendees. The org gets a single invoice line per attendee (one consolidated invoice covering all attendees).
- TDS per attendee on the consultant payout side (each attendee's payment is a separate ECO event).
- TCS Sec 52 N/A (B2B side).

### Trial sessions

- Trials are typically free for the trial-taker (no payment) → no tax events. But a paid trial (rare) would behave like a 1-attendee CONSULTATION.

## Current code

| File | What it does | State |
|---|---|---|
| `Appointment` (schema) | One row per attendee per session — many appointments can share `webinarPlanId` / `classPlanId` | ✅ |
| `Payment` (schema) | One per checkout. Verify: does each attendee's checkout create a separate `Payment`? | ⚠️ verify |
| `Invoice` (B2C) / `OrganizationInvoice` (B2B) | Per-payment. ✅ for B2C; B2B has line items aggregated to monthly invoice. | ✅ |
| `TDSRecord` | Per-payout, not per-payment. The aggregator should sum across attendee payments to produce a single per-quarter TDS record. | ⚠️ verify |
| Webinar / class checkout | Each attendee goes through `/api/checkout` separately → one Payment per attendee. | ⚠️ verify |
| `lib/payments/operations/checkout.ts` | Same code path for CONSULTATION / WEBINAR / CLASS | ✅ |

## Gap

| Gap | Severity |
|---|---|
| Data-path verification: does each WEBINAR/CLASS attendee produce its own Payment + Invoice + earnings record? | 🟠 |
| Per-attendee place-of-supply capture (each attendee may be in a different state) | 🟠 — depends on [doc 02](./02-gst-overview.md) state-capture work |
| GSTR-8 aggregation: ensure TCS lines are per-Payment, not per-session | 🟠 |
| Refund of 1 attendee out of N: only that attendee's credit note + TDS / TCS adjustment, not the whole session | 🟠 |
| Auto-allocate to multiple consultants for the same session: each consultant's TDS calculated separately | 🟡 |
| Capacity-cap enforcement: when the last seat is sold, no more Payments for that session | 🟡 (booking concern, not tax) |

## Required

1. **Audit the data path** — pick a real or seeded webinar with 5+ attendees. Verify:
   - 5 separate `Payment` rows.
   - 5 separate `Invoice` rows (B2C).
   - 5 separate entries in the 194O cumulative for the consultant.
   - Per-attendee `consumerStateCode` populated (after [doc 02](./02-gst-overview.md) ships).
2. **Add an integration test** that seeds a webinar + 5 attendees in 3 different states + runs the GST/TDS aggregators; assert the per-attendee math.
3. **Refund-of-one-attendee test**: refund attendee #3, verify only attendee #3's credit note + TDS adjustment + TCS adjustment are emitted; the other 4 are untouched.
4. **GSTR-1 (or GSTR-8) export**: per-Payment lines, not per-Session. Verify in the export builder.
5. **Multi-consultant collaborator handling**: if a class has 2 collaborating consultants splitting revenue (current `WebinarCollaborator` / `ClassCollaborator` schema supports this), each consultant gets their own TDS calculation on their split.

## Acceptance

- A webinar with 50 attendees produces 50 Payments + 50 Invoices + 50 TDS lines for the consultant in the next 26Q→Form 140.
- Refunding 1 attendee leaves 49 untouched; only the refunded attendee gets a credit note + TDS adjustment.
- A webinar with attendees in MH, KA, TN produces 3 different place-of-supply lines in GSTR-1.
- A 2-collaborator class with 50/50 revenue split produces 50 TDS lines × 2 consultants, each at the per-consultant cumulative.

## Don't build

| Don't build | Reason |
|---|---|
| Per-session aggregated invoice | Each attendee is their own consumer with their own state and PoS. Aggregating loses tax data. |
| Bulk-refund-by-session as a single tax event | Refunds are per-Payment by design. |

## References

- [Place of supply Sec 12 IGST](https://www.cbic.gov.in/htdocs-cbec/gst/igst-act-2017-amend-finance-act-2024.pdf)
- *No standalone rate/threshold is asserted in this doc; all figures are cross-references to [doc 01](./01-tds-overview.md) (194O 0.1% / §393) and [doc 02](./02-gst-overview.md) (GST 18% / TCS 0.5%), both web-verified 2026-06-05.*
- See also: [02](./02-gst-overview.md) (place of supply + TCS), [05](./05-refund-and-chargeback-tax-adjustments.md) (per-attendee refund cascade), [docs/booking/](../booking/) (the booking model).
