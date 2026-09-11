# 08 — DPDP Act 2023 + Rules 2025 — data privacy

> **Status:** ✅ DataBreach 72-hour deadline cron live (Round 2, 2026-05-02); ✅ ConsentArtifact schema with SHA-256 hash + 7-year retention; ✅ `checkConsent` / `withdrawConsent` are real (fail-closed predicate — not a stub); ✅ org-side consent endpoint live; ✅ admin-driven `ErasureRequest` flow + `scrubUser` live; ✅ `OrgDataExportJob` (DPDP §11 access bundle) route + worker live; 🟡 consent-retention sweeper code exists but is NOT yet wired to a GH Actions schedule; 🔴 consumer-side consent at signup, consumer self-serve DSAR endpoints, multilingual notices, age gate all missing.
> **Audience:** auth, signup, consent, account-settings code; admin compliance dashboard.
> **Last reviewed:** 2026-06-05 (DPDP Act/Rules web-verified as of 2026-06-05)
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
- [Deloitte DPDP Rules implementation guide](https://www.deloitte.com/in/en/services/consulting/about/indias-dpdp-rules-2025-leading-digital-privacy-compliance.html)
- See also: [09](./09-consumer-protection-and-grievance.md) (the OTHER grievance officer, under E-Commerce Rules 2020), [#701](https://github.com/Practitionist/familiarise_web/issues/701) (org-side DPDP epic).
