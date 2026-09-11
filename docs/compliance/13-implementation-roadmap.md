# 13 — Implementation roadmap

> **Status:** consolidated B2B + B2C compliance roadmap. Synthesised from #737 + #738 + this doc series.
> **Audience:** engineering leads + product + finance.
> **Last reviewed:** 2026-06-05 (reconciled with shipped enterprise-v2 reality + DPDP/PA deadlines web-verified as of 2026-06-05)

> **Already-shipped reality check (verified 2026-06-05 against the repo)** — several items below are partially done; verify in code before re-scoping:
> - DPDP: `checkConsent` / `withdrawConsent` are **real** (fail-closed); `ConsentArtifact` schema + `lib/compliance/dpdp.ts:buildConsentArtifact` live; `consent-retention-sweeper.ts` **exists** (env-gated, but not yet on a GH Actions schedule); `OrgDataExportJob` + `app/api/organizations/[orgId]/data-exports/**` + `scripts/cleanup/process-data-exports.ts` (DPDP §11) **live**; admin `ErasureRequest` flow + `scrubUser` (DPDP §12) **live**; `databreach-deadline-alerts` cron **live**.
> - Tax-adjustment schema: `CreditNote`, `TdsAdjustment`, `GstTcsBatch`, `GstTcsAdjustment` models **already exist** (Phase 2 below is implementation/wiring on top of them, not greenfield schema).
> - IRP: `irp-uploader` cron + `lib/compliance/irp.ts` + `lib/compliance/irp-payload.ts` mapper **live**, gated behind `ENABLE_IRP_UPLOADER` + ClearTax env.
> - MSME: `msme-payment-alerts` cron + `lib/compliance/msme.ts` (15/45-day rule) **live**.
> - Still genuinely undone: consumer signup consent, consumer self-serve `/api/me/*` DSAR, multilingual notices, age gate, Grievance (consumer-protection) model + page + SLA cron, refund-SLA tracking, GST TCS *collection* at payment time, 26Q/27Q FVU generation, cross-border consultant (Sec 195) pivot.

This is the master plan. It is split into phases by **dependency + risk**, not by team. Some phases can run in parallel; the dependency graph at the bottom shows what's blocking what.

## At a glance

| Phase | What | Effort | Blocks |
|---|------|-------|--------|
| **1** | Production bug fixes — TDS section + rate + threshold + entity type, place-of-supply state capture, HSN selection | ~1 week | Phases 2, 4 |
| **2** | Statutory filings + tax adjustments — GST TCS Sec 52, refund/chargeback tax cascade, Form 26Q/27Q FVU, Form 16A | ~3 weeks | Phase 6 (cross-border 27Q) |
| **3** | Consumer Protection — Grievance officer, refund SLA, chargeback evidence UI | ~1 week | none |
| **4** | DPDP consumer layer — consent at signup, DSAR, erasure cascade, retention sweeper, multilingual notices, age gate | ~3 weeks | DPDP Phase 3 deadline 13 May 2027 |
| **5** | Subscription mid-period refund UI (collapsed from #737's Phase 5) | ~0.5 days | none |
| **6** | Cross-border — non-resident consumer flow, non-resident consultant payouts (Sec 195 + DTAA + 15CA/CB), 27Q | ~2 weeks | Phase 2 |
| **7** | Consultant onboarding — GSTIN field + validation, tax-entity-type capture | ~1 week | Phases 1, 2 |
| **8** | Architecture memos + cleanup — RBI PA Directions 2025 memo, removed-levies cleanup grep, doc drift pass | ~1 week | none |

**Total**: ~10 weeks. Critical path = Phases 1 → 2 → 4 (driven by DPDP 13 May 2027). Cross-border (Phase 6) deferrable if non-resident traffic is small.

## Phase 1 — Production bug fixes (~1 week)

The two TDS bugs and the place-of-supply gap are real production risks today.

### PR 1.1 — TDS reconciliation
- Update `lib/compliance/tds.ts` rate constants: `"194O": 0.001` (not `0.01`); add 5% no-PAN constant.
- Pivot `lib/payments/tax/tds-service.ts` from Sec 194J to Sec 194O via `lib/compliance/tds.ts:computeTdsForPayout`.
- Add `ConsultantProfile.taxEntityType` enum (`INDIVIDUAL` / `HUF` / `PARTNERSHIP` / `COMPANY` / `LLP` / `NON_RESIDENT`); migrate via Supabase MCP.
- Threshold: ₹5,00,000 / FY for `INDIVIDUAL` / `HUF` only; **no threshold** for everyone else.
- No-PAN fallback: 5% for 194O; 20% for 194J/194C.
- Decision: back-correct historical `TDSRecord` rows (refund excess withholding) OR grandfather (public communication). Document in PR.
- Tests covering every section × entity-type × PAN-state cell.

### PR 1.2 — Place of supply state capture
- Schema: `Payment.consumerStateCode` (2-char).
- Checkout form: capture from billing address; validate against ISO state codes.
- Wire into `deriveGstBreakdown` for B2C path.
- Block IN-resident checkout if state is missing.

### PR 1.3 — HSN selection
- 999293 for CONSULTATION.
- 999299 for WEBINAR / CLASS / SUBSCRIPTION on educational content.
- Update `lib/pdf/invoice-renderer.tsx` selection logic + tests.

### PR 1.4 — Per-FY 194O entity-type threshold
- Builds on PR 1.1; threshold logic keyed off `taxEntityType`.
- Migrate existing consultants: default `INDIVIDUAL`; ask at next login to confirm.

**Acceptance**: see [doc 01](./01-tds-overview.md) and [doc 02](./02-gst-overview.md).

## Phase 2 — Statutory filings + tax adjustments (~3 weeks)

The biggest correctness phase. Refund/chargeback tax cascade is the single largest gap in #738.

### PR 2.1 — GST TCS Sec 52 collection
- Schema: `Payment.gstTcsCollectedPaise` (field exists) + `GstTcsBatch` model (**already exists**, `@@unique([financialYear, month])`); add `ConsultantEarnings.gstTcsAccruedPaise` if missing.
- Compute at payment success when consultant is GST-registered: 1% of net taxable. *(Sec 52 TCS rate 1% — note: the 0.5%+0.5% intra-state split; verify against current GSTR-8 norms at build.)*
- Monthly cron `gst-tcs-batches-aggregator.yml` (1st of month, 05:00 UTC).
- GSTR-8 CSV export endpoint.

### PR 2.2 — Form 26Q + 27Q + 16A
- Quarterly cron `tds-quarterly-return-prep.yml`.
- Aggregator query that unions B2B + B2C TDS records per consultant per quarter.
- FVU file generator (NSDL format).
- Form 16A PDF + email to consultants.
- Admin dashboard `/dashboard/admin/tds/quarterly-returns`.

### PR 2.3 — Refund tax-adjustment cascade (the big one)
- Schema: `CreditNote`, `TdsAdjustment`, `GstTcsAdjustment` models **already exist** (#778 §D) — this PR is the *cascade logic*, not the schema.
- Refund cascade emits all four (negative leg + credit note + TDS adj + TCS adj) in one Prisma transaction.
- Proportional logic for partial refunds.
- 26Q FVU includes negative-line entries.
- GSTR-8 includes negative-line entries.
- GSTR-1 includes credit notes.

### PR 2.4 — Chargeback tax-adjustment hook
- Trigger on dispute LOST status.
- Same cascade as PR 2.3.

### PR 2.5 — RBI PA architecture memo
- Add `docs/payments/06-pa-master-direction-architecture.md`.
- Engage CA + RBI counsel for Path C opinion.
- File annual self-declaration calendar reminder.

**Acceptance**: see [doc 02](./02-gst-overview.md), [doc 04](./04-tds-quarterly-filings.md), [doc 05](./05-refund-and-chargeback-tax-adjustments.md), [doc 10](./10-rbi-pa-and-payment-architecture.md).

## Phase 3 — Consumer Protection (~1 week)

### PR 3.1 — Grievance officer page + backend
- Public page at `/grievance` with officer details + 48h/30-day SLAs.
- `Grievance` model + API.
- `grievance-sla-sweeper.yml` hourly cron with auto-ack at 47h.
- Admin dashboard.

### PR 3.2 — Refund SLA
- `Refund.targetCompletionDate` (initiatedAt + 7d cards / 5d UPI).
- `refund-sla-sweeper.yml` daily cron.
- Customer-facing "expected refund date" on order detail.

### PR 3.3 — Chargeback evidence-submission UI
- File-upload field on admin dispute detail page.
- POST to Razorpay / Stripe evidence API.
- Persist URLs on `Dispute`.

**Acceptance**: see [doc 09](./09-consumer-protection-and-grievance.md).

## Phase 4 — DPDP consumer layer (~3 weeks)

Hard deadline: **13 May 2027** (Phase 3 / substantive obligations of DPDP Rules 2025; consent-manager framework is Phase 2 / 13 Nov 2026). *(Verified 2026-06-05.)* Note several pieces are already built (see the reality-check banner at the top) — this phase is mostly the *consumer-facing* layer + wiring.

### PR 4.1 — Consumer signup consent
- `ConsumerConsentArtifact` model.
- Granular toggle UI per purpose at signup.
- Persist on every consent change.
- Update privacy policy with explicit purpose list.

### PR 4.2 — DSAR endpoints
- `GET /api/me/data-export`, `POST /api/me/data-correction`, `DELETE /api/me/account`, `POST /api/me/grievance` (DPDP-flavoured), `POST /api/me/nominate`.

### PR 4.3 — Erasure cascade
- `User.erasureRequestedAt` flag.
- 30-day async cascade: anonymise PII, delete profiles, anonymise messages, retain tax records 7 years.
- Confirmation email.

### PR 4.4 — Retention sweeper
- `jobs/compliance/consent-retention-sweeper.ts` **already exists** (env-gated `DPDP_SWEEPER_DELETE`). Remaining: add a `.github/workflows/consent-retention-sweeper.yml` schedule + land the hash-only archival pipeline before enabling delete mode.
- Add inactivity-based erasure (Rules' Third Schedule period) with a prior notice email.

### PR 4.5 — Multilingual notices
- English + Hindi + Bengali + Tamil at minimum.
- Browser-detect with user override.

### PR 4.6 — Age gate + parental consent
- DOB at signup; if minor, parental verification flow.
- Block payment / recording until verified.

### PR 4.7 — `checkConsent` enforcement
- ~~Replace stub with real lookup~~ — **already real** (fail-closed predicate in `lib/compliance/dpdp.ts`). Remaining work is *wiring*: call it from every data-touching code path (booking, payment, recording, analytics, Stream.io handoff) + seed real artifacts at signup (PR 4.1) so the guard has grants to read.

**Acceptance**: see [doc 08](./08-dpdp-and-privacy.md).

## Phase 5 — Subscription refund UI (~0.5 days)

### PR 5.1 — Mid-period cancel + refund button
- On subscription detail page, add "Cancel & request refund".
- Routes to standard refund flow with pro-rated unused-sessions amount.
- **No** UPI AutoPay logic (N/A).
- **No** auto-renewal disclosure (N/A).

## Phase 6 — Cross-border (~2 weeks)

Defer if non-resident traffic is < 5% of volume.

### PR 6.1 — Non-resident consumer flow
- `Payment.buyerCountry`.
- B2C `Invoice.displayCurrency` + `inrEquivalentPaise` + `fxRateUsed`.
- LUT enforcement on invoices.
- e-FIRC capture (manual upload first; auto via Razorpay later).

### PR 6.2 — Non-resident consultant payouts (Sec 195)
- Pivot `lib/payments/tax/tds-service.ts` non-resident path from "skip" to delegate to `lib/compliance/tds.ts`.
- Schema: `ConsultantProfile.taxResidencyStatus`, `country`, `trcRef`, `form10FRef`, `noPeDeclarationRef`.
- B2C `Payout` schema parity with `OrganizationPayout` (15CA/CB/FIRC/DTAA/RBI/FX).
- Stripe Connect routing (already wired).
- Form 15CA filing automation via CA partner.

### PR 6.3 — 27Q quarterly return (extension of PR 2.2)
- Same cron, separate file generator with DTAA fields.

**Acceptance**: see [doc 07](./07-cross-border-flows.md).

## Phase 7 — Consultant onboarding (~1 week)

### PR 7.1 — GSTIN field
- Optional initially, with format-regex validation.
- Live registry verification deferred (no public API).

### PR 7.2 — Tax-entity-type capture
- Tied to PR 1.4. Onboarding form captures `taxEntityType`.

### PR 7.3 — Consultant detail page disclosure (Rule 5(1))
- Legal name + state + GSTIN (when present).
- Customer-care channel.

**Acceptance**: see [doc 09](./09-consumer-protection-and-grievance.md), [doc 02](./02-gst-overview.md).

## Phase 8 — Architecture memos + cleanup (~1 week)

### PR 8.1 — RBI PA Directions 2025 memo
- See PR 2.5 above.

### PR 8.2 — Removed-levies cleanup grep
- Run the grep from [doc 11](./11-removed-and-deprecated-levies.md). Remove or annotate any stale references.

### PR 8.3 — Doc drift pass
- `docs/finances/`, `docs/payments/`, anywhere mentioning Equalisation Levy, 206AB, 206C(1H), ZestMoney, internal IRP — annotate with "removed in 2024–2025" or remove.

## Dependency graph

```
Phase 1 (bug fixes)
  ├── Phase 2 (filings + tax adjustments)
  │     ├── Phase 6 (cross-border) — needs 27Q from Phase 2
  │     └── Phase 7 (onboarding) — needs entity-type from Phase 1
  ├── Phase 4 (DPDP consumer layer) — independent of Phase 2 but shares same hard deadline
  └── Phase 3 (Consumer Protection) — independent
Phase 5 (subscription UI) — independent
Phase 8 (memos + cleanup) — independent, can ship anytime
```

## Soak window (post-Phase 2 completion)

Before declaring B2C compliance "production-grade":

1. Run all new crons for **14 consecutive days** with zero discrepancies.
2. At least one full B2C cycle: payment → invoice → TDS withhold → 26Q row → Form 16A.
3. At least one B2C refund: full cascade → credit note → TDS adjustment → TCS adjustment.
4. At least one chargeback: same cascade auto-fired.
5. At least one consumer DSAR completed end-to-end.
6. At least one grievance acknowledged in <48h, resolved in <30d.

## Open product / business decisions (block scope, not code)

1. **Consultant GST registration policy** ([doc 02](./02-gst-overview.md)): onboard unregistered + absorb operational complexity, OR block at onboarding?
2. **Cross-border consumer roadmap** ([doc 07](./07-cross-border-flows.md)): if Phase 6 PR 6.1 wasn't going to be used in v1, scope it down.
3. **Consultant entity-type self-declaration UX** ([doc 01](./01-tds-overview.md)): force at next login OR progressive disclosure?
4. **TDS back-correction policy** (PR 1.1): refund excess withholding to consultants (apologies + comms) OR grandfather (no comms)?
5. **Multilingual scope** ([doc 08](./08-dpdp-and-privacy.md)): top 4 languages OR all 22 Schedule VIII?

These are flagged at the top of #738 and need product+legal sign-off before code starts on the affected PRs.

## References

See [14-references.md](./14-references.md).
