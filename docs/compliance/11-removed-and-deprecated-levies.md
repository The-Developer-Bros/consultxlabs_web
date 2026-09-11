# 11 — Removed / deprecated levies — cleanup hygiene

> **Status:** ✅ none of these are live in code. This doc exists to prevent re-implementation by accident and to flag any stale references in docs / comments.
> **Audience:** anyone tempted to add code for one of these.
> **Last reviewed:** 2026-06-05 (abolition/omission dates web-verified as of 2026-06-05; nothing has returned)
> **Linked issues:** [#737 §13](https://github.com/Practitionist/familiarise_web/issues/737).

## What these are

Tax provisions that were live in past financial years and are now **abolished or omitted**. Building them today is wasted effort.

## Equalisation Levy

**Status: fully abolished.**

| Levy | What it was | Abolition |
|---|---|---|
| 2% e-commerce EL | 2% on consideration received from non-resident e-commerce operators for online supply of goods/services to India | **Abolished by Finance (No. 2) Act 2024 w.e.f. 1 Aug 2024.** *(Verified 2026-06-05.)* |
| 6% advertisement EL | 6% on online advertisement payments to non-resident service providers | **Abolished by Finance Act 2025 (No. 7, signed 29 Mar 2025) w.e.f. 1 Apr 2025.** Sec 10(50) exemption sunset accordingly. *(Verified 2026-06-05.)* |

**Residual:** Pending assessments for transactions before the sunset dates remain assessable. The EL Statement (Form 1) for FY 2024-25 (covering 6% receipts up to 31 Mar 2025) was due **30 Jun 2025** — so a residual filing existed for FY 2024-25. No new prospective EL filings needed for FY 2025-26 onward.

**Action**: grep + remove any `equalisationLevy` / `equalization_levy` / `EL_RATE` references in code or doc comments. Already noted in `lib/compliance/tds.ts` header docblock as "Removed provisions (DO NOT implement)".

## Section 206C(1H) — TCS on sale of goods

**Status: omitted.**

- Was: TCS at 0.1% on sale of goods > ₹50L per buyer per FY.
- **Omitted by Finance Act 2025 w.e.f. 1 Apr 2025.** *(Verified 2026-06-05.)*
- Never applied to services anyway (we sell services), so this was always out-of-scope for us. Kept for completeness.

**Action**: confirm no `206C` / `TCS_GOODS` references — none found at audit.

## Section 206AB / 206CCA — higher TDS / TCS for non-filers

**Status: omitted.**

- Was: a multiplier on TDS / TCS rates for payees who hadn't filed their last ITR (post-2024 amendment: one year, previously two) and had aggregate TDS / TCS > ₹50,000.
- **Both omitted by Finance Act 2025 w.e.f. 1 Apr 2025.** *(Verified 2026-06-05.)*
- Removed the need for platforms to do "PAN vs ITR-filing" reconciliation against the Compliance Check API.

**Action**: grep + remove any `206AB` / `206CCA` / `nonFilerHigherRate` references. None found at audit. Confirmed in `lib/compliance/tds.ts` header docblock.

## Section 206AA — merged into §397(2) (IT Act 2025)

**Still live in substance; the citation moved.**

- Old Sec 206AA applied a **20% (or actual rate, whichever higher)** fallback when the payee fails to provide PAN. From 1-Apr-2026 this lives in **Section 397(2)** of the Income-tax Act 2025, which retains the 20% default and carries an explicit **5% carve-out for e-commerce (old 194-O)** payouts.
- The original audit found code using 20% even for 194-O; that bug is fixed — `lib/compliance/tds.ts` applies `NO_PAN_RATE_194O = 0.05` for 194-O and the 20% fallback for 194J/194C. See [doc 01](./01-tds-overview.md).

**Action**: none — rate fixed (#771 P0-1); cite §397(2), not 206AA, in any new code or filing artifact.

## ZestMoney EMI

**Status: shut down December 2023.**

- Was a no-cost EMI provider used by many EdTech platforms.
- Don't integrate ZestMoney even if mentioned in old docs.
- **Replacements**: Propelld, Eduvanz, Bajaj Finserv, HDFC Credila for education-financing use cases.

## Self-custodied escrow

**Status: not viable for our scale.**

- RBI Payment Aggregator authorisation requires ₹15 cr net worth + 24-month track record + governance overhead.
- Practical alternative: route via RazorpayX / Cashfree (already done; see [doc 10](./10-rbi-pa-and-payment-architecture.md)).

## Internal IRP integration

**Status: not viable; use a licensed connector.**

- IRP (Invoice Registration Portal) requires a Goods and Services Tax Network (GSTN) approved e-invoicing partner.
- We already use **ClearTax** (env-gated in `lib/compliance/irp.ts`).
- Don't reverse-engineer the IRP API or build a direct integration.

## Parent–child org hierarchy UI

**Status: schema-only, deferred.**

- `Organization.parentOrganizationId` (self-relation "OrgHierarchy") + `rootOrganizationId` exist in schema (re-added under #771 D3 after being dropped in #768; APIs stubbed 501). There is **no `depth` column** — earlier docs that listed `parentId`/`rootId`/`depth` were wrong on the field names. *(Schema verified 2026-06-05.)*
- No dominant marketplace ships parent-child UI at launch.
- Defer until a customer asks.

## Programs v2 (PROJECT / RETAINER)

**Status: enum reserved; runtime not built.**

- `ProgramType` enum has `PROJECT` and `RETAINER` values.
- No code path consumes them today.
- Defer until design-partner feedback identifies a use case.

## BetterAuth `Member` as primary membership

**Status: superseded by typed `Membership`.**

- BetterAuth's `Member` table exists for invitation-token compatibility only.
- Our `Membership` model is the source of truth for org-side roles + capabilities.
- Don't write business logic against BetterAuth `Member`.

## Inventory e-commerce entity classification

**Status: doesn't apply to us.**

- Consumer Protection (E-Commerce) Rules 2020 distinguishes "marketplace" (Rule 5) from "inventory" (Rule 6) e-commerce entities.
- We are unambiguously a **marketplace** — we don't own the service inventory.
- Don't apply Rule 6 obligations.

## Verification

A periodic grep that should return zero results:

```bash
grep -rn "equalisationLevy\|equalization_levy\|EL_RATE\|206AB\|206CCA\|206C_1H\|TCS_GOODS\|zestmoney\|ZestMoney" \
  --include="*.ts" --include="*.tsx" --include="*.prisma" --include="*.md" \
  app/ lib/ prisma/ docs/ 2>&1
```

If anything surfaces in docs (especially old planning docs in `docs/finances/`), update them with a "removed in 2024–2025" note rather than deleting outright — it's useful history.

## References

- [Finance Act 2024 PDF (CBDT)](https://incometaxindia.gov.in/Pages/finance-acts.aspx)
- [Finance Act 2025 changes (ClearTax)](https://cleartax.in/s/tds-and-tcs-changes-from-april-2025)
- [Equalisation Levy abolition (IndiaFilings)](https://www.indiafilings.com/income-tax/equalisation-levy-abolished)
- [TCS 206C(1H) removal (TaxGuru)](https://taxguru.in/income-tax/tcs-sale-goods-removed-april-1-2025-faqs.html)
- See also: [01](./01-tds-overview.md) (Sec 206AA carve-out), [10](./10-rbi-pa-and-payment-architecture.md) (escrow path).
