# 05 — Refund & chargeback tax adjustments

> **Status:** 🟢 adjustment hooks fully wired; the filing EXPORTS remain deferred (#778 §F). Every statutory adjustment row is now written at event time: the refund cascade mints the Sec 34 `CreditNote`, calls `recordTdsReversal` (negative `TDSRecord` **and** a `TdsAdjustment` filing artifact), and emits `GstTcsAdjustment` when TCS was collected; the lost-chargeback handler has full parity (#738-B) — TDS reversal for paid-out earnings, a credit note idempotent on `CreditNote.disputeId`, and the TCS adjustment. The TCS rows stay inert until Sec 52 collection itself ships (see [doc 02](./02-gst-overview.md)). What remains deferred is reading these rows out: the GSTR-1/3B/8 exports and the Form 140/144 FVU generation.
> **Audience:** payment / refund / dispute code; finance ops.
> **Last reviewed:** 2026-06-10 (chargeback parity + TdsAdjustment/GstTcsAdjustment write hooks wired in the #778 finance-correctness PR; prior review 2026-06-07)
> **Linked issues:** [#738 Items A, B, H](https://github.com/Practitionist/familiarise_web/issues/738) (this is the largest gap added in #738).

## What it is

When a payment is refunded (or a chargeback is lost), the **money already moved** through several statutory hooks:

| Hook | What was deposited | Adjustment required |
|---|---|---|
| **Income-tax TDS (Sec 194O / 195; §393 under the 2025 Act from 1-Apr-2026)** | Already deposited to govt by 7th of following month | Reverse-credit in **next** 26Q→Form 140 / 27Q→Form 144 quarterly return as a negative adjustment line. **Now wired (#813):** `recordTdsReversal` writes a negative `TDSRecord` capped at the original withholding; if the original record is unfiled the reversal copies its FY/quarter, if already filed it stamps the current IST-reckoned FY/quarter (the adjust-against-future-liability convention). Cross-FY adjustments that exceed the consultant's current-quarter liability still ultimately require an income-tax refund claim by the consultant, and correction statements for already-filed quarters remain a manual CA action; the policy is provisional pending CA sign-off. |
| **GST output liability** (the GST charged on the original invoice) | Already discharged in GSTR-3B for the month of supply | Issue a **GST credit note** under CGST **Sec 34** (Rule 53 content/format), link to original invoice, and net it off in the next month's GSTR-1 / 3B. *(Sec 34/GSTR mechanics unaffected by GST 2.0 — verified 2026-06-05.)* |
| **GST TCS (Sec 52)** — B2C only | Already collected from consultant + deposited via GSTR-8 | Reduce the next-month GSTR-8 by the refunded TCS, OR file a GSTR-8 amendment if the supply month already passed. (TCS rate is 0.5% since 10-Jul-2024 — see [doc 02](./02-gst-overview.md).) |
| **Consultant earnings ledger** | Already credited to consultant's earnings | Reverse via the existing PaymentLeg negative-leg cascade. ✅ already works. |
| **Org earnings ledger** (B2B) | Already credited to org's earnings + accrued in the next invoice | Reverse via existing cascade. ✅ already works. |
| **Org payout / consultant payout** (already disbursed) | Money is gone | **Clawback** flow needed — see #715/#716 epics. |

Of the first three rows, the **GST credit note** and the **income-tax TDS reversal** are now wired (the latter via a negative `TDSRecord`, #813); the **GST TCS (Sec 52)** reversal is still entirely unimplemented. Until the TCS leg lands, a refund of a TCS-bearing B2C supply leaves the next monthly GSTR-8 **wrong by the refunded amount**, which is a Sec 234E / Sec 122 penalty risk.

## When it applies

### B2B (org-sponsored)

- Refund of an org-sponsored booking → reduce the org's invoice (or issue a credit note if invoice already issued).
- TDS reversal: now emitted by the refund cascade as a negative `TDSRecord` proportional to the refund (#813), so the next 26Q nets it out; it also covers the case where the refund drops the consultant's per-FY total back below the threshold.
- GST credit note: applies if the org invoice was already issued. Issued to the org under their GSTIN.
- GST TCS: N/A for B2B (no TCS collected on org leg).

### B2C (consumer marketplace)

- Refund of a consumer payment → reduce consultant earnings + reverse the negative `PaymentLeg`. Already works.
- TDS reversal: same logic as B2B; the negative `TDSRecord` affects the per-FY consultant aggregate (#813).
- GST credit note: applies if the consumer invoice was already issued. Issued to the consumer (or the consultant supplier per Sec 34, depending on who's the deemed supplier — for facilitator marketplace like ours, the consultant issues, but the platform generates on their behalf).
- GST TCS: applies if the consultant is GST-registered. Reduce next month's GSTR-8 batch.

### Chargeback (lost dispute)

- Same cascade as refund, but triggered by the gateway, not by us. Razorpay/Stripe debits us; consumer never went through our refund flow.
- Currently `app/api/webhooks/utils.ts:955–1104` (dispute auto-hold) holds consultant earnings but does NOT emit any tax adjustment.
- A refund **then** a lost chargeback on the same payment can no longer double-reverse the TDS: `recordTdsReversal` caps cumulative reversals at the original withholding, so the second cascade adds nothing once the first has already reversed it (#813).

### Partial refund

- Proportional. 50% refund → 50% of original TDS / TCS / GST adjusted, not full reversal. Multi-leg refunds (B2B WALLET + LICENSE + INVOICE_ACCRUAL combinations) compound this.

## Current code

| File | What it does | State |
|---|---|---|
| `lib/payments/operations/refund.ts:336–388` | Refund cascade — negative `PaymentLeg`, wallet credit, ConsultantEarnings refundedShareAmount update | ✅ ledger-side OK |
| `recordTdsReversal` (`lib/payments/tax/tds-service.ts`), called from `refund.ts` + `payouts/earnings-service.ts` | Writes a negative `isReversal` `TDSRecord` on refund (integer-paise proportion, capped at the original, filed-aware FY/quarter) | ✅ TDS reversal wired (#813) |
| `mintRefundCreditNote` (called from the cascade + the gateway-refund webhook) | Mints the Sec 34 GST credit note, idempotent on `refundId` | ✅ GST credit note wired |
| `TdsAdjustment` write hook | ✅ wired (#778 §D) — `recordTdsReversal` now also emits a `TdsAdjustment` row (the filing artifact for the Form 140/144 export) alongside the negative `TDSRecord` (which stays the YTD/dedup source) | ✅ |
| `GstTcsAdjustment` write hook | ✅ wired (#738) — both the refund cascade and the lost-dispute handler emit a signed-negative row when `Payment.gstTcsCollectedPaise` is set; inert until Sec 52 collection ships (see [doc 02](./02-gst-overview.md)) | ✅ |
| `CreditNote` model (schema) | **Present** — per-org `creditNoteNumber` + `fiscalYear`, `@@unique([organizationId, creditNoteNumber])`, `refundId @unique` (idempotent minting, #776), Sec 34 invoice FK | ✅ schema-final |
| `TdsAdjustment` model (schema) | **Present** — signed `amountPaise`, `financialYear`/`quarter`, `reportedInForm26Q` | ✅ schema-final |
| `GstTcsAdjustment` model (schema) | **Present** — signed `amountPaise`, FK to `GstTcsBatch` | ✅ schema-final |
| GST output reversal in GSTR-1/3B (export reads `CreditNote`) | **Missing** (no GSTR-1 export yet) | 🔴 |
| 26Q→140 / 27Q→144 negative-adjustment line (FVU reads `TdsAdjustment`) | **Missing** | 🔴 |
| Monthly GSTR-8 amendment for TCS reversal (reads `GstTcsAdjustment`) | **Missing** (Sec 52 collection itself stubbed — see [doc 02](./02-gst-overview.md)) | 🔴 |
| `app/api/webhooks/utils.ts:955–1104` | Dispute auto-hold of consultant earnings | ✅ holds money correctly |
| Chargeback tax-adjustment trigger on dispute LOST | ✅ wired (#738-B) — the LOST/CHARGE_REFUNDED branch reverses TDS for paid-out earnings via `recordTdsReversal` (the cap prevents double-reversal after a prior refund), mints the Sec 34 credit note idempotently on `CreditNote.disputeId`, and emits `GstTcsAdjustment` when TCS was collected | ✅ |

## Gap

| Gap | Severity |
|---|---|
| ~~Refund emits no GST credit note (CGST Sec 34)~~ wired (#776/#785) | ✅ |
| ~~Refund emits no TDS adjustment record~~ wired — negative `TDSRecord` (#813) + `TdsAdjustment` filing artifact (#778 §D) | ✅ |
| ~~Refund emits no TCS adjustment~~ write hook wired; rows stay inert until Sec 52 collection ships (doc 02) | ✅ |
| ~~Chargeback (dispute LOST) emits no tax adjustments~~ full parity wired (#738-B) | ✅ |
| ~~No proportional logic for partial refunds~~ integer-paise proportions throughout, reversal-capped | ✅ |
| Filing exports that READ the adjustment rows (GSTR-1/3B/8, Form 140/144 FVU) are deferred (#778 §F) — manual filing from the rows until then | 🟡 |
| Cross-FY refunds (refund this April for an invoice from March) — TDS adjustment isn't possible same-system; needs consultant refund-claim flow | 🟡 |

## Required

### A. CreditNote model — ✅ ALREADY LANDED (schema), wiring pending

The `CreditNote` / `TdsAdjustment` / `GstTcsAdjustment` models are already in `prisma/schema.prisma` (#776/#778) — **do not re-add them.** The shipped `CreditNote` shape differs from (and improves on) the original proposal below:

- Numbering is **per-org gapless** via `@@unique([organizationId, creditNoteNumber])` + `fiscalYear` (CGST **Rule 53** sequence, mirroring `OrganizationInvoice`), minted by `lib/payments/billing/credit-note-numbering.ts` (`<prefix>-CN-<FY>-<seq>`) — **not** a single global `@unique` counter.
- `refundId String? @unique` makes refund-driven minting **idempotent** — a webhook redelivery / cron retry can't mint a duplicate or burn a sequence number.
- Links to **`OrganizationInvoice`** (`invoiceId String?`, nullable for B2C/unregistered where no GST invoice was issued); money split is `subtotalPaise` + `cgstPaise`/`sgstPaise`/`igstPaise` + `totalPaise`; lifecycle `status CreditNoteStatus` (DRAFT/…); `issuedAt DateTime?`.

🟡 *The shipped schema has **no `reportedInGstr1` flag** (the original proposal did). The GSTR-1 export (not built) will need either that flag added or a join against filing records to avoid double-reporting credit notes. Engineering follow-up.*

Original proposal (historical — superseded by the landed schema above):

```prisma
// SUPERSEDED — see lib/payments/billing/credit-note-numbering.ts + schema CreditNote
model CreditNote {
  id                  String          @id @default(cuid())
  creditNoteNumber    String          @unique  // ← shipped version is per-org @@unique, not global
  invoiceId           String
  amountPaise         Int
  cgstPaise           Int
  sgstPaise           Int
  igstPaise           Int
  reason              String
  refundId            String?         @unique
  reportedInGstr1     Boolean         @default(false)  // ← NOT in shipped schema
}
```

### B. Refund cascade additions

Inside the existing Prisma transaction in `refund.ts`. **Field-name note (verified 2026-06-05):** the landed schema uses `amountPaise` (signed) on both `TdsAdjustment` and `GstTcsAdjustment` — *not* `adjustmentPaise`; `TdsAdjustment` keys the source as `tdsRecordId` / `payoutId` / `refundId` (not `originalTdsRecordId`); `GstTcsAdjustment` keys `paymentId` / `refundId` / `batchId`. Treat the pseudocode below as intent, mapping the field names to the real schema:

```typescript
// 1. existing — negative PaymentLeg, wallet credit, ConsultantEarnings reversal
// 2. NEW — emit credit note if original invoice already issued
if (originalInvoice && originalInvoice.status === "ISSUED" || "PAID") {
  await tx.creditNote.create({
    data: {
      creditNoteNumber: await nextCreditNoteNumber(tx),
      invoiceId: originalInvoice.id,
      amountPaise: refund.amountPaise,
      cgstPaise: proportional(originalInvoice.cgstPaise, refundFraction),
      sgstPaise: proportional(originalInvoice.sgstPaise, refundFraction),
      igstPaise: proportional(originalInvoice.igstPaise, refundFraction),
      refundId: refund.id,
      reason: refund.reason,
    },
  });
}

// 3. NEW — TDS adjustment record
if (originalTdsRecord) {
  await tx.tdsAdjustment.create({
    data: {
      originalTdsRecordId: originalTdsRecord.id,
      refundId: refund.id,
      adjustmentPaise: -proportional(originalTdsRecord.tdsDeducted, refundFraction),
      financialYear: getIndianFinancialYear(refund.createdAt),
      quarter: getIndianFYQuarter(refund.createdAt),
      reportedInForm26Q: false,
    },
  });
}

// 4. NEW — TCS adjustment (B2C only, when consultant is GST-registered)
if (consultant.gstin && originalPayment.gstTcsCollectedPaise > 0) {
  await tx.gstTcsAdjustment.create({
    data: {
      originalPaymentId: originalPayment.id,
      refundId: refund.id,
      adjustmentPaise: -proportional(originalPayment.gstTcsCollectedPaise, refundFraction),
      monthYear: monthYearOf(refund.createdAt),
      reportedInGstr8: false,
    },
  });
}
```

### C. Chargeback hook

In `app/api/webhooks/utils.ts:handleDisputeLost` (or equivalent), after the existing earnings hold/release logic:

```typescript
// Treat lost chargeback as an involuntary 100% refund for tax purposes.
await applyTaxAdjustments({
  tx,
  refundLikeEvent: { kind: "CHARGEBACK_LOST", paymentId, fraction: 1.0 },
});
```

### D. Quarterly / monthly aggregation pickup

- The cron in [doc 04](./04-tds-quarterly-filings.md) (FVU generator) needs to include `TdsAdjustment` rows where `reportedInForm26Q = false` as **negative lines** in the next return.
- The cron in [doc 02](./02-gst-overview.md) (GSTR-8 batcher) needs to include `GstTcsAdjustment` rows as **negative lines** in the next GSTR-8.
- The GSTR-1 export (not yet built) needs to read `CreditNote WHERE reportedInGstr1 = false` and include them in the credit-notes section.

### E. Cross-FY edge case

When the refund happens in a different FY than the original payment, **we cannot rewrite the previous FY's 26Q/27Q** — that return is closed. The proposed `TdsAdjustment` flow below was to skip the record entirely; the now-shipped `TDSRecord` reversal (#813) instead follows the **adjust-against-future-liability** convention — if the original record is already reported in Form 26Q, the reversal is stamped into the current IST-reckoned FY and quarter rather than the closed one. The two are not in conflict: the future FVU export must still treat a cross-FY reversal as a current-quarter negative line and surface the manual-correction path below; this policy is provisional pending CA sign-off.

1. Surface this in admin dashboard as "Cross-FY refund — consultant refund-claim required".
2. Generate a Form 16A correction for the consultant showing that ₹X TDS was deposited but the underlying income was reversed; consultant claims a refund from IT dept directly.
3. For the closed FY's already-filed return, the correction statement is a manual CA action — the automated `TDSRecord` reversal lands in the current quarter, not the closed one.

## Acceptance

The criteria below are the target end state for the full consolidation flow. As of #813 the negative `PaymentLeg`, the `CreditNote`, and the income-tax reversal (now landing in a negative `TDSRecord` rather than a `TdsAdjustment`) are met; the `GstTcsAdjustment` leg and the FVU/GSTR machine-export bullets remain pending.

- A 100% refund of an invoiced consumer payment emits, in one Prisma transaction: a negative PaymentLeg, a CreditNote, and a negative `TDSRecord` reversal — plus a GstTcsAdjustment once that leg is wired.
- A 50% refund emits all of the above with proportional amounts.
- A lost chargeback emits the same cascade as a 100% refund, and the reversal cap means a prior refund on the same payment is not double-reversed.
- The next quarterly 26Q FVU includes negative-line entries for all unreported reversals (today the negative `TDSRecord` rows; the `TdsAdjustment`-backed FVU export is the pending consolidation target).
- The next monthly GSTR-8 includes negative-line entries for all unreported GstTcsAdjustments (pending).
- The next GSTR-1 (when implemented) includes the CreditNote rows.
- Cross-FY refund flags admin dashboard, doesn't pollute current-FY return.

## Don't build

| Don't build | Reason |
|---|---|
| Auto-issue a 16A correction certificate to the consultant cross-FY | The consultant must self-claim from IT dept; we just stop double-deposit. |
| Reverse a fully-deposited TDS via TRACES API | Not technically possible in same-cycle; same-FY adjustments are quarterly-return-only. |

## References

- [CGST Sec 34 — credit and debit notes](https://www.cbic.gov.in/htdocs-cbec/gst/cgst-act-2017-amend-finance-act-2024.pdf) — *Sec 34 + Rule 53 credit-note mechanics unchanged by GST 2.0; verified 2026-06-05*
- [Sec 52 GSTR-8 amendments (TaxGuru)](https://taxguru.in/goods-and-service-tax/gstr-8-amendment-rules.html)
- [TDS adjustment vs refund-claim guidance (CBDT)](https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1)
- *Schema landed: `CreditNote` / `TdsAdjustment` / `GstTcsAdjustment` verified present in `prisma/schema.prisma`, 2026-06-05; numbering in `lib/payments/billing/credit-note-numbering.ts`.*
- See also: [04](./04-tds-quarterly-filings.md) (26Q→Form 140 negative lines), [02](./02-gst-overview.md), [#715](https://github.com/Practitionist/familiarise_web/issues/715) (clawback for already-disbursed payouts), [#716](https://github.com/Practitionist/familiarise_web/issues/716) (refund unification epic).
