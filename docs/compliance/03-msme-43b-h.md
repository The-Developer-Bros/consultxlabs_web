# 03 — MSME Section 43B(h) — 15/45-day payment rule

> **Status:** ✅ derivation live (`computeMsmePaymentDeadline`); ✅ alert cron live + GH Actions schedule wired (Round 2, daily 04:30 UTC); 🟡 counterparty data capture (`msmeStatus`, `udyamNumber`, `writtenAgreementWithFamiliarise`) needs UX flow.
> **Audience:** payout pipeline + consultant onboarding code.
> **Last reviewed:** 2026-06-05 (regulatory facts web-verified as of 2026-06-05; prior review 2026-05-02)
> **Linked issues:** [#681](https://github.com/Practitionist/familiarise_web/issues/681) (compliance master), [#737 §1.5](https://github.com/Practitionist/familiarise_web/issues/737), [#738](https://github.com/Practitionist/familiarise_web/issues/738) (FF-5 confirmed live).

## What it is

Section 43B(h) of the Income Tax Act (inserted by Finance Act 2023, effective AY 2024-25 / 1-Apr-2024) requires that payments to **Micro and Small** suppliers — registered under the MSMED Act 2006 via Udyam — be made within the Section 15 MSMED Act window:

| MSME size | Without written agreement | With written agreement |
|---|---|---|
| **MICRO** / **SMALL** | 15 days from acceptance/invoice date | 45 days (the MSMED §15 hard ceiling — an agreed credit period **cannot exceed 45 days**) |
| **MEDIUM** / **NONE** | Buyer's default terms (60 days max recommended) | Buyer's default terms |

**Scope (verified 2026-06-05):** 43B(h) applies **only to MICRO and SMALL** Udyam-registered suppliers — **MEDIUM enterprises are outside its scope**, and unregistered suppliers are not covered even if they'd qualify by size. If the buyer breaches the deadline, **the expense is disallowed in the current year's tax computation** until actually paid. Hard ceiling: 43B(h) days WIN over a longer `defaultTermsDays`. The provision **carries forward into the Income-tax Act, 2025** (in force 1-Apr-2026) with a renumbered citation: old §43B becomes **Section 37**, and the MSME limb §43B(h) becomes **Section 37(2)(g)** ("any sum payable to a micro or small enterprise beyond the time limit specified in section 15 of the MSMED Act, 2006"). The 15/45-day mechanics are unaffected — only the clause number moved, and filings covering payments on/after 1-Apr-2026 must cite §37(2)(g).

**Revised Udyam classification thresholds (S.O. 1364(E), 21-Mar-2025, effective 1-Apr-2025 — verified 2026-06-05):** investment limits ×2.5 and turnover limits ×2 versus the 2020 framework. Composite criterion — *both* must be satisfied; breaching *either* bumps the enterprise up a category.

| Category | Investment in plant & machinery / equipment | Annual turnover |
|---|---|---|
| **MICRO** | ≤ ₹2.5 crore | ≤ ₹10 crore |
| **SMALL** | ≤ ₹25 crore | ≤ ₹100 crore |
| **MEDIUM** | ≤ ₹125 crore | ≤ ₹500 crore |

These determine which `msmeStatus` a consultant self-declares; only MICRO/SMALL trigger the 15/45-day deadline. Existing Udyam certificates remain valid with automatic benefit extension under the new limits.

Udyam registration number format: `UDYAM-XX-NN-NNNNNNN` (19 chars: `UDYAM` + 2-char state + 2-digit district + 7-digit serial). Code regex `lib/compliance/msme.ts:isValidUdyamNumber` is `/^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/` ✅ matches. MSME status comes from a self-declaration + Udyam certificate; Familiarise stores `ConsultantProfile.msmeStatus` (`MsmeStatus`: `MICRO` / `SMALL` / `MEDIUM` / `NONE`) + `udyamNumber` + `writtenAgreementWithFamiliarise` (bool).

## When it applies

### B2B (org-sponsored)

- **Applies.** When an org makes a payout to an MSME-registered consultant, the deadline is 15 / 45 / `defaultTermsDays` from the invoice date. `OrganizationPayout.mustPayByDate` is the derived field.
- The org's books (not ours) carry the disallowance risk, but the platform must surface the deadline so finance/AP doesn't miss it.

### B2C (consumer marketplace)

- **N/A on the consumer leg.** The consumer pays the platform; there's no buyer-supplier relationship between consumer and consultant under 43B(h).
- **N/A on the platform-to-consultant payout leg either** — Practitionist pays from the consumer's payment within days, well inside any 15/45 window. The platform's books bear the disallowance risk, but it is mathematically not breached when payouts run weekly/monthly.

So 43B(h) is effectively a **B2B-only** compliance — but the schema fields (`msmeStatus`, etc.) sit on `ConsultantProfile` regardless of rail because the same consultant may earn through both rails.

## Current code

| File | What it does | State |
|---|---|---|
| `lib/compliance/msme.ts:54–76` | `computeMsmePaymentDeadline` — MICRO/SMALL 15/45-day, MEDIUM/NONE default | ✅ live |
| `lib/compliance/msme.ts:83` | `isValidUdyamNumber` — regex check | ✅ live |
| `OrganizationPayout.mustPayByDate` (schema) | Stamped at payout creation from `computeMsmePaymentDeadline` | ✅ schema-final |
| `ConsultantProfile.msmeStatus`, `udyamNumber`, `writtenAgreementWithFamiliarise` | Schema fields | ✅ |
| `jobs/compliance/msme-payment-alerts.ts` | Sweeps payouts within 5 days of `mustPayByDate`; emails finance via Resend | ✅ live |
| `.github/workflows/msme-payment-alerts.yml` | Daily 04:30 UTC | ✅ wired (Round 2) |
| Consultant onboarding form | Captures `msmeStatus` + Udyam number + written-agreement toggle | 🟡 status unknown — verify on next walkthrough |

## Gap

| Gap | Severity |
|---|---|
| Consultant onboarding flow may not collect `msmeStatus` / `udyamNumber` / `writtenAgreementWithFamiliarise` cleanly | 🟡 |
| No admin UI to verify Udyam registration against the live Udyam portal | 🟡 |
| `mustPayByDate` is stamped at payout creation, but if the org's `defaultTermsDays` changes mid-cycle, in-flight payouts don't update | 🟢 (edge case) |
| No back-office workflow if a 43B(h) breach happens — alert cron fires, then what? | 🟡 — needs runbook |

## Required

1. **Onboarding UX**: ensure the consultant signup / settings flow captures the MSME fields with a clear UDYAM-format hint and a written-agreement checkbox tied to org contract acceptance.
2. **Admin verification**: a small `/dashboard/admin/consultants/[id]/verify-msme` page that lets staff lookup the Udyam number externally + flip a `msmeVerifiedAt` timestamp (schema add).
3. **Runbook**: `docs/runbooks/msme-deadline-approaching.md` documenting what finance does when the alert email fires (chase finance team, accelerate payout, escalate to org admin if blocked).
4. **Optional (defer)**: integrate the [Udyam search API](https://udyamregistration.gov.in/) for live verification; it has no public API today, so manual verification is fine for v1.

## Acceptance

- An MSME-registered consultant with no written agreement and an invoice issued 1 May 2026: `mustPayByDate = 16 May 2026`.
- Same with written agreement: `mustPayByDate = 15 Jun 2026`.
- A non-MSME consultant: `mustPayByDate = invoiceDate + contract.defaultTermsDays` (default 60).
- Daily cron at 04:30 UTC fires email to `MSME_ALERT_EMAIL` whenever any payout has `mustPayByDate < now + 5d` and `status != COMPLETED`.
- Structured log `event: "msme.payout.at_risk"` emitted regardless of email config.

## Don't build

- Internal Udyam-portal scraper. The portal has anti-bot measures and no API. Verify manually.
- Calendar reminders to consultants about their MSME status — that's their CA's job, not ours.

## Related disclosure (not 43B(h), but adjacent)

**Form MSME-1** is the half-yearly ROC/MCA return (Companies Act, not Income-tax Act) disclosing payments to Micro & Small suppliers **outstanding beyond 45 days**. Due **31 Oct** (Apr–Sep half) and **30 Apr** (Oct–Mar half). It is a *company-law* obligation that runs parallel to 43B(h); if Practitionist (the company) ever owes an MSE supplier past 45 days it must file MSME-1. Tracked in the [compliance calendar (doc 12)](./12-india-compliance-calendar.md). Penalty: ₹20,000 + ₹1,000/day continuing (cap ₹3 lakh) under Companies Act §405(4).

## References

- [MSME 43B(h) explainer (TaxGuru)](https://taxguru.in/income-tax/section-43bh-payments-msme-suppliers.html)
- [Revised Udyam thresholds S.O. 1364(E) effective 1-Apr-2025 (Taxmann)](https://www.taxmann.com/post/blog/revised-msme-classification) — *Micro ₹2.5cr/₹10cr, Small ₹25cr/₹100cr, Medium ₹125cr/₹500cr; verified 2026-06-05*
- [Revised MSME thresholds effective 1-Apr-2025 (TaxGuru)](https://taxguru.in/corporate-law/msme-threshold-limit-effective-1st-april-2025.html) — *verified 2026-06-05*
- [43B(h): MICRO/SMALL only, MSMED §15 45-day ceiling, carries into 2025 Act (ClearTax)](https://cleartax.in/s/section-43bh-of-income-tax-act) — *verified 2026-06-05*
- [Form MSME-1 half-yearly due dates 31 Oct / 30 Apr (ClearTax)](https://cleartax.in/s/form-msme-1) — *verified 2026-06-05*
- [Udyam registration portal](https://udyamregistration.gov.in/)
- [CBDT Circular 1/2024 on 43B(h)](https://incometaxindia.gov.in/communications/circular/circular-no-1-2024.pdf)
- See also: [04-tds-quarterly-filings.md](./04-tds-quarterly-filings.md) (Form 26Q→140 includes MSME flags), [12-india-compliance-calendar.md](./12-india-compliance-calendar.md) (MSME-1 dates).
