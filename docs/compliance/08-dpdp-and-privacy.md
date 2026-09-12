# 08 — DPDP Act 2023 + Rules 2025 — data privacy

> **Status:** ✅ DataBreach 72-hour deadline cron live (Round 2, 2026-05-02); ✅ ConsentArtifact schema with SHA-256 hash + 7-year retention; ✅ `checkConsent` / `withdrawConsent` are real (fail-closed predicate — not a stub); ✅ org-side consent endpoint live; ✅ admin-driven `ErasureRequest` flow + `scrubUser` live; ✅ `OrgDataExportJob` (DPDP §11 access bundle) route + worker live; 🟡 consent-retention sweeper code exists but is NOT yet wired to a GH Actions schedule; 🔴 consumer-side consent at signup, consumer self-serve DSAR endpoints, multilingual notices, age gate all missing.
> **Audience:** auth, signup, consent, account-settings code; admin compliance dashboard.
> **Last reviewed:** 2026-08-27 (DPDP Rule 8(2) pre-erasure notice and Rule 8(3) one-year retention floor verified against the Gazette PDF on 2026-08-27; remaining Act/Rules facts web-verified as of 2026-06-05)
> **Linked issues:** [#737 §3, §4](https://github.com/Practitionist/familiarise_web/issues/737), [#701](https://github.com/Practitionist/familiarise_web/issues/701) (org consent + DataBreach UI epic), [#738](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

The Digital Personal Data Protection Act 2023, with the **Digital Personal Data Protection Rules, 2025** notified by MeitY on **13 Nov 2025** (published in the Gazette **14 Nov 2025**). Applicable to any digital personal data processed in India. *(Verified as of 2026-06-05 against the PIB notification + MeitY Rules text.)*

**Phased rollout** (measured from the 13 Nov 2025 notification):

| Phase | Deadline | What's enforceable |
|---|---|---|
| **Phase 1** | Immediate — **13 Nov 2025** | Definitions + Data Protection Board provisions (Board constituted) |
| **Phase 2** | **13 Nov 2026** (12 months) | Consent Manager registration framework live |
| **Phase 3** | **13 May 2027** (18 months) | All other substantive obligations enforceable: consent notice, data-principal rights, breach reporting, retention/erasure, SDF duties |

**Key obligations on a Data Fiduciary (us):**

| # | Obligation | Detail |
|---|---|---|
| 1 | **Granular consent at signup** | Itemised purposes (booking, payment, recordings, marketing, analytics) — each independently toggleable. Plain English + 22 Schedule VIII languages. |
| 2 | **Withdrawal mechanism** | One-click revocation; cascade to revoke downstream processing. |
| 3 | **Data principal rights** | DPDP Act **§11** (right to access information — summary of processing + list of recipients), **§12** (right to **correction, completion, updating AND erasure** — both correction and erasure live in §12, titled "Right to correction and erasure of personal data"), **§13** (right of grievance redressal), **§14** (right to nominate). Endpoints with response SLAs. *(Section mapping verified 2026-06-05 against the Act text.)* |
| 4 | **Verifiable parental consent** | For users under 18; age-gate at signup (Act §9). |
| 5 | **Retention limits** | Auto-erasure per the Rules' Third Schedule — e.g., the prescribed inactivity rule for e-commerce (≥ 2 cr users) / online gaming (≥ 50 lakh) / social media (≥ 2 cr): erase if the data principal has not approached the fiduciary for the specified period. |
| 6 | **Breach reporting** | DPDP **Rules 2025 Rule 7**: notify the Board AND affected data principals **"without delay"** on becoming aware; a **detailed report to the Board within 72 hours** (extendable on written request). The code's 72-hour clock targets the detailed-report deadline; see 🟡 callout below. |
| 7 | **DPO appointment** | If "Significant Data Fiduciary" (SDF — designated by govt under Act §10; criteria not yet finalised, volume-driven). SDF triggers DPIA + India-based DPO + independent audit. |
| 8 | **Grievance officer** | Public-facing contact; the Rules require the fiduciary to publish the contact and respond within its published period. **Separate** from the Consumer Protection officer (see [doc 09](./09-consumer-protection-and-grievance.md)). |
| 9 | **48-hour pre-erasure notice** | DPDP **Rules 2025 Rule 8(2)**: before a Third Schedule retention period under Rule 8(1) completes and the platform erases the data principal's personal data, the platform must warn her at least 48 hours in advance, and the warning must state that logging in, otherwise contacting the fiduciary for the specified purpose, or exercising a data-principal right within that window will stop the erasure. |
| 10 | **One-year retention floor on all processing** | DPDP **Rules 2025 Rule 8(3)**: independent of Rule 8(1)'s purpose-served erasure duty and Rule 8(2)'s notice duty, the platform must retain every data principal's personal data, associated traffic data, and processing logs for a minimum of one year from the date of that processing, for the purposes in the Seventh Schedule, and must then cause both the platform's own copies and any Data Processor's copies to be erased unless a law requires longer retention or the Government notifies otherwise. The Gazette follows Rule 8(3) with two official illustrations, quoted verbatim below. |

The Gazette's two illustrations under Rule 8(3) read, verbatim:

> **Case 1:** X, a Data Principal purchases an e-book on an e-book platform Y. Once delivery is completed, the specified purpose of processing is served. The platform Y must retain the order details, personal data, and logs of the processing (such as order confirmation, payment, and delivery events) for at least one year from the date of the transaction, even if X deletes her account.
>
> **Case 2:** X, a company engages a cloud service provider C as its Data Processor to host customer records. X as the Data Fiduciary, is required to ensure that the C also retains the data and associated logs for at least one year before erasure, unless any other applicable law requires a longer period.

Case 2 is the direct analogue of our own Data-Processor relationships (Stream.io for chat/video/recordings, any hosting vendor). It reads as a two-way obligation on us as the Data Fiduciary: we must be able to show that the processor retained for at least a year, and we must separately be able to cause that processor to erase once the floor (and any longer statutory retention) has cleared, per Act §8(7)(b). Neither direction is implemented today — see the Rule 8(3) callout below.

> 🟡 **Law-vs-code — 48-hour pre-erasure notice (Rule 8(2)).** DPDP Rules 2025 Rule 8(2) requires that, at least forty-eight hours before a Third Schedule erasure period completes, the Data Fiduciary inform the Data Principal that her personal data will be erased on completion of that period unless she logs into her user account, otherwise initiates contact with the Data Fiduciary for the specified purpose, or exercises a right in relation to that processing. There is no code today that computes a Third Schedule erasure date and fires a warning 48 hours ahead of it — the platform doesn't operate in any of the three Third Schedule classes (see the "What does *not* apply to us" note in [`docs/enterprise/40-compliance-and-data/02-deletion-policy.md`](../enterprise/40-compliance-and-data/02-deletion-policy.md)), so Rule 8(1)/(2) don't bind us today, but the notice mechanism has no implementation to fall back on if that ever changes. Rule 8(2) commences with the rest of Rule 8 in Phase 3 on **13 May 2027** — this does not move the phasing table above, it just confirms Rule 8(2) sits in the same phase as Rule 8(1). *(Source: DPDP Rules 2025 Rule 8(2); verified against the Gazette PDF 2026-08-27.)*
>
> 🟡 **Law-vs-code — one-year retention floor (Rule 8(3)).** Rule 8(3) opens "Without prejudice to sub-rules (1) and (2)," so unlike Rule 8(1)/(2) it binds independently of Third Schedule class membership: the Data Fiduciary must retain personal data, associated traffic data, and other processing logs — its own and any Data Processor's — for a minimum of one year from the date of processing, for the Seventh Schedule purposes, before causing erasure, unless another law requires longer retention or the Government notifies otherwise. The Seventh Schedule (`[See rule 23(1) and 8(3)]`) is a table of State-access purposes, not a general business-retention list: (1) State/instrumentality use of personal data in the interest of sovereignty/integrity of India or security of the State, (2) State use for performing a function or a law-mandated disclosure under any law in force in India, and (3) MeitY's assessment for SDF designation — each with its own named authorised person. So the floor exists to keep data obtainable for those State-access purposes for a year; it isn't conditioned on our purpose for processing, and it extends to our Data Processors, but we have no code that enforces it: the retention logic in `jobs/compliance/consent-retention-sweeper.ts` and in [`docs/enterprise/40-compliance-and-data/02-deletion-policy.md`](../enterprise/40-compliance-and-data/02-deletion-policy.md) only reasons about retention as an *upper* bound (the 5-7 year tax/accounting keep on money rows). No code change made — flagged for the live-impl PR. Rule 8(3) commences with the rest of Rule 8 in Phase 3 on **13 May 2027**. *(Source: DPDP Rules 2025 Rule 8(3) + Seventh Schedule; verified against the Gazette PDF 2026-08-27.)*
>
> ⚠️ **Design constraint, not yet solved — Rule 8(3) vs GDPR Article 17.** This is an ordinary legal-obligation conflict, not a novel deadlock: GDPR Article 17(3)(b) already exempts erasure where processing is necessary "for compliance with a legal obligation which requires processing by Union or Member State law" — but that clause names *Union or Member State* law specifically, so an Indian Rule 8(3) duty doesn't automatically qualify for an EU data subject's row. A user who is simultaneously a DPDP data principal and a GDPR data subject — e.g. an EU-resident consultee — can therefore face a genuine conflict on the same row: Rule 8(3) requires holding it a year for the Seventh Schedule's State-access purposes, while Article 17 requires erasing it "without undue delay" once invoked, with no Article 17(3)(b) shelter available. A single global retention constant can't resolve this; the fix is a per-jurisdiction retention policy evaluated at the row level. Recorded here as an open design constraint for whichever team builds cross-border retention — not implemented, and no code today distinguishes DPDP-governed rows from GDPR-governed rows for retention purposes.

> 🟡 **Law-vs-code — breach notification window.** `jobs/compliance/databreach-deadline-alerts.ts` (`REPORTING_DEADLINE_HOURS = 72`) and `DataBreach.reportedAt` ("must be ≤72h after detectedAt") model breach reporting as a single 72-hour deadline. The current rule (DPDP **Rules 2025, Rule 7**, in force from Phase 3 / 13 May 2027) is two-staged: notify the Board **and** affected data principals **"without delay"** on becoming aware, with a **detailed report to the Board within 72 hours** (extendable). The code's 72h clock maps to the *detailed report*, not the *initial* "without delay" intimation. No code change made — flagged for the live-impl PR. *(Source: DPDP Rules 2025 Rule 7; verified 2026-06-05.)*

## When it applies

### B2C (consumer marketplace)

- **Applies on every consumer signup, every booking, every recording, every refund.** No exceptions.
- Currently consumer signup at `app/auth/signup/page.tsx` has **no granular consent** — just email/password.
- Privacy policy page exists at `app/(pages)/privacy/page.tsx` but isn't linked from a consent gate.

### B2B (org-sponsored)

- **Applies on org member signup, on org operator data, on consultant onboarding.**
- Org-side `ConsentArtifact` schema + endpoint at `app/api/organizations/[orgId]/consent/route.ts` exists. Consents are typically captured at the org level (org consents on behalf of members for purposes like attendance recording, video sessions).
- Operators (OWNER, MAINTAINER, etc.) need their own consent for org-admin processing.

### Consultants

- Same as B2C consumers for personal-data processing.
- Plus profession-specific data (PAN, GSTIN, bank details, Aadhaar masked) which the platform processes for tax-compliance purposes — has its own purpose code ("payout disbursement + statutory reporting") with retention extending to 7 years post-account-closure (TDS / GST audit trail).

## Current code

| Item | What it does | State |
|---|---|---|
| `ConsentArtifact` (schema) | Per-user consent record with SHA-256 hash, `auditRetainedUntil` (grantedAt + 7y), `withdrawnAt`, language, `consentManager` | ✅ schema-final |
| `lib/compliance/dpdp.ts:buildConsentArtifact` | Builds the SHA-256 hash + 7-year retention window | ✅ live |
| `lib/compliance/dpdp.ts:checkConsent` | **Real fail-closed predicate** — returns `false` if no artifact / withdrawn / past retention. NOT a stub (module docblock says "Implementation is real"). What's still deferred is the consent-manager / notice-versioning workflow around it. | ✅ |
| `lib/compliance/dpdp.ts:withdrawConsent` | Stamps `withdrawnAt`; supports narrow (single-purpose) withdrawal | ✅ |
| Org-side consent endpoint at `app/api/organizations/[orgId]/consent/route.ts` | Org operator consents | ✅ |
| `OrgDataExportJob` + `app/api/organizations/[orgId]/data-exports/**` + `scripts/cleanup/process-data-exports.ts` worker + `.github/workflows/process-data-exports.yml` | **DPDP §11 right-to-access** bundle (JSON+CSV across members/contracts/earnings/invoices/payouts/audit-log; 7d signed URL; OWNER+BILLING_ADMIN; 1/24h rate-limit) | ✅ live |
| `ErasureRequest` + `app/api/admin/erasure-requests/**` + `lib/compliance/erasure/scrub-user.ts` | **DPDP §12 erasure** — admin-driven: file → process (`scrubUser`) / reject; audit row survives admin deletion | ✅ live |
| Consumer-side consent at signup | **Missing** — no checkbox, no granular purposes | 🔴 |
| Consumer **self-serve** DSAR endpoints (`/api/me/*` access / correction / erasure / grievance / nomination) | **Missing** — note the org-scoped access export + admin erasure flow above already cover the operator path | 🔴 |
| `DataBreach` (schema) | Reporting fields (`detectedAt`, `reportedAt` ≤ 72h, `dpbReference`) | ✅ |
| `jobs/compliance/databreach-deadline-alerts.ts` + `.github/workflows/databreach-deadline-alerts.yml` | Hourly cron, warns ≤12h before + at/past the 72h report deadline | ✅ live (Round 2) |
| Consent withdrawal cascade | `withdrawConsent` flips `withdrawnAt` and `checkConsent` immediately reads it as revoked; **downstream side-effect teardown** (e.g. revoking Stream.io access, purging marketing lists) is still **missing** | 🟡 |
| `jobs/compliance/consent-retention-sweeper.ts` | Two-mode sweeper (`DPDP_SWEEPER_DELETE` env-gated: counts-only by default, deletes in capped batches when enabled). Code exists; **NOT wired to a GH Actions workflow yet** (no `.yml`) | 🟡 |
| Multilingual notices (Schedule VIII 22 languages) | **Missing** | 🔴 |
| Age gate / parental consent | **Missing** | 🔴 |
| DPO designation flag (`isSignificantDataFiduciary`) | **Missing** | 🟡 — only relevant once designated an SDF (volume-driven) |
| Privacy policy page at `app/(pages)/privacy/page.tsx` | ✅ exists | content not audited |

## Gap

| # | Gap | Phase | Severity |
|---|-----|-------|----------|
| 1 | Granular consent at consumer signup | Phase 3 (13 May 2027) | 🔴 |
| 2 | Consumer **self-serve** DSAR endpoints (`/api/me/*`, 5 rights) — org-scoped §11 export + admin §12 erasure already exist | Phase 3 | 🔴 |
| 3 | Withdrawal **side-effect teardown** — `withdrawConsent` flips the flag and `checkConsent` reads it, but downstream processors (Stream.io, marketing) aren't actively revoked | Phase 3 | 🟡 |
| 4 | Wire `consent-retention-sweeper.ts` to a GH Actions schedule **and** land the hash-only archival pipeline so `DPDP_SWEEPER_DELETE=true` is safe to flip | Phase 3 | 🟡 — code exists, unscheduled |
| 5 | Multilingual notices (Hindi + Bengali + Tamil minimum) | Phase 3 | 🟠 |
| 6 | Age gate + verifiable parental consent | Phase 3 | 🟠 |
| 7 | ~~`checkConsent` actually checks the latest grant~~ — **DONE**: predicate is real + fail-closed | — | ✅ |
| 8 | Public-facing grievance officer (separate from Consumer Protection officer) | Phase 3 | 🟠 |
| 9 | Org-side parity: `ConsentArtifact` per org operator | Phase 3 | 🟡 |
| 10 | DPO designation if Significant Data Fiduciary | Phase 3 | 🟢 (only past threshold) |

## Required

### A. Consumer signup consent (PR 1)

1. **Schema**: `ConsumerConsentArtifact` model — analogous to org-side `ConsentArtifact`. Fields: userId, version, purposeCodes[], grantedAt, withdrawnAt, language, hash (SHA-256 of consent text + timestamp), retainUntil.
2. **Signup form**: granular toggles per purpose:
   - `BOOKING` — required (cannot complete signup without it)
   - `PAYMENT_PROCESSING` — required
   - `SESSION_RECORDING` — optional, asked again per-session
   - `MARKETING_EMAILS` — optional, default off
   - `ANALYTICS_THIRD_PARTY` — optional, default off
3. **Persist on signup** + on every consent change.
4. **Privacy policy** must list each purpose explicitly.

### B. DSAR endpoints (PR 2)

1. `GET /api/me/data-export` — generate a JSON dump of all the user's records across the schema. Returns within 7 days (Phase 3 standard SLA).
2. `POST /api/me/data-correction` — user submits correction request; admin actions it.
3. `DELETE /api/me/account` — initiates erasure; cascade described below.
4. `POST /api/me/grievance` — submits a DPDP grievance to the DPO.
5. `POST /api/me/nominate` — designates a nominee for the user's data post-mortem.

### C. Erasure cascade (PR 3)

When a user requests deletion:

1. Mark `User.erasureRequestedAt`.
2. Run within 30 days (Phase 3 standard).
3. Cascade:
   - Anonymise `User` record (keep ID + hashed email for tax-record integrity; remove name, profile pic, etc.).
   - Delete `ConsumerProfile` / `ConsultantProfile` PII.
   - Anonymise message threads (replace user's messages with `[deleted]`).
   - Recordings: per-recording delete option; default retention rule applies.
   - **Tax records (TDSRecord, Invoice)**: cannot be deleted — retain for 7 years (statutory). User is informed.
4. Email user a confirmation with what was retained and why.

### D. Retention sweeper (PR 4)

`jobs/compliance/consent-retention-sweeper.ts` **already exists** (two-mode, `DPDP_SWEEPER_DELETE`-gated, weekly Sunday 03:00 IST per its docblock). Remaining work:
- Wire it to a `.github/workflows/consent-retention-sweeper.yml` schedule (no workflow file today).
- Land the hash-only archival pipeline (dispute-resolution copy) upstream so deletion mode is safe to enable.
- Extend it (or add a sibling) for `ConsumerConsentArtifact` once that model lands, and for inactive-user erasure (no login in the prescribed period) with a prior notice email.

### E. Multilingual notices (PR 5)

- All consent text + privacy policy + grievance form available in: English, Hindi, Bengali, Tamil at minimum. Telugu / Marathi / Gujarati / Kannada / Malayalam / Punjabi as growth markets.
- Detect language from browser; allow user override.
- The 22-Schedule-VIII full set is aspirational; ship the top 10 by population.

### F. Age gate (PR 6)

- Date-of-birth field at signup. If under 18, parental consent flow:
  - Parent's email + signed consent (digital signature or DSC if available).
  - Block payment / recording features until verified.
  - Flag profile as `MINOR` for the operator's view.

### G. checkConsent enforcement (PR 7)

`checkConsent` itself is **already real** (fail-closed: returns `false` if the latest grant is missing, withdrawn, or past retention). Remaining work is *wiring*, not the predicate:
- Call `checkConsent({ userId, purposeCode })` from every data-touching code path (booking, payment, recording, analytics, Stream.io handoff).
- Caller short-circuits with a 403 + UX prompt to re-grant.
- Seed real consent artifacts at signup (PR 1) so the guard has something to read — until then it fail-closes everything for consumers who never granted.

## Acceptance

- A new consumer cannot complete signup without ticking the required consent boxes.
- Consumer can withdraw any optional consent in <3 clicks from settings.
- `GET /api/me/data-export` returns a JSON dump within 7 days.
- `DELETE /api/me/account` triggers anonymisation in 30 days.
- A breach detected at T fires an alert email at T + 60h (12h before deadline) and again at T + 72h.
- Inactive users (3+ years) get a 60-day notice email then auto-anonymisation.
- Privacy policy + signup form available in 4+ languages.
- Minor users blocked from payment until parental consent is verified.

## Don't build

| Don't build | Reason |
|---|---|
| Custom consent management platform | A Phase-2 Consent Manager framework will be third-party-provided; integrate when available. |
| Aadhaar-based parental verification | Aadhaar UIDAI auth is restricted; use a digital signature or PAN-based verification. |
| Cross-product data sharing without separate consent | Each new purpose requires a fresh consent prompt; don't piggyback. |

## References

- [DPDP Rules 2025 PIB notification](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf) — notified 13 Nov 2025, Gazette 14 Nov 2025; phasing 13 Nov 2025 / 13 Nov 2026 / 13 May 2027 *(verified 2026-06-05)*
- [MeitY DPDP Rules 2025](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa)
- [DPDP Act 2023 — Chapter III data-principal rights (§11 access, §12 correction+erasure, §13 grievance, §14 nomination)](https://www.dpdpa.com/dpdpa2023/chapter-3) *(section mapping verified 2026-06-05)*
- [DPDP Rules 2025 — Rule 7 breach-notification timeline ("without delay" + 72h detailed report)](https://www.dpdpa.com/dpdparules/rule7.html) *(verified 2026-06-05)*
- [DPDP Rules 2025 — Gazette PDF, G.S.R. 846(E), Gazette No. 760 dated 13 Nov 2025 (Rule 8(2) 48-hour pre-erasure notice, Rule 8(3) one-year retention floor plus its two illustrations)](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) *(verified against the PDF text 2026-08-27)*
- [Deloitte DPDP Rules implementation guide](https://www.deloitte.com/in/en/services/consulting/about/indias-dpdp-rules-2025-leading-digital-privacy-compliance.html)
- See also: [09](./09-consumer-protection-and-grievance.md) (the OTHER grievance officer, under E-Commerce Rules 2020), [#701](https://github.com/Practitionist/familiarise_web/issues/701) (org-side DPDP epic).
