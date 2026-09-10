# 01 — TDS overview (sections, rates, thresholds)

> **Status:** 🔴 production bug on B2C side (wrong section + rate). B2B side is closer to correct but still needs wiring. 🔴 **NEW (2026-06-05): the Income-tax Act, 2025 took effect 1-Apr-2026 — the old §194O/194J/194C/195 section _numbers_ no longer exist for returns on transactions on/after that date. See "Income-tax Act 2025 renumbering" below; code still emits the old labels.**
> **Audience:** anyone working on payouts (`lib/payments/payouts/`), tax helpers (`lib/payments/tax/`, `lib/compliance/`).
> **Last reviewed:** 2026-06-05 (regulatory facts web-verified as of 2026-06-05; prior review 2026-05-02)
> **Linked issues:** [#737](https://github.com/Practitionist/games/familiarise_web/issues/737), [#738](https://github.com/Practitionist/familiarise_web/issues/738) (Item F).

## What it is

Tax Deducted at Source — the income-tax withholding that a payer (us) takes off a payee's (consultant's) income at the moment of payment, and deposits with the government. The right **section** depends on the relationship.

Section numbers below are given as **§1961-Act, now §2025-Act / payment-code** (see the renumbering note immediately after the table). Rates and thresholds are **unchanged** by the 2025 Act — only the citation/form taxonomy changed.

| Section (1961 → 2025 Act)                   | Applies to                                        | Rate (FY 2026-27)                                                                                                                                                       | Threshold                                                                                                                                         | No-PAN fallback                                                                      |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **194O → §393(1) Table Sl.8(v), code 1035** | E-commerce operator pays e-commerce participant   | **0.10%** (cut from 1% w.e.f. 1 Oct 2024 by Finance (No. 2) Act 2024)                                                                                                   | ₹5,00,000 / FY for resident _individuals/HUF_ with valid PAN/Aadhaar; **no threshold** for partnerships / companies / LLPs / non-residents        | **5%** (special carve-out for 194O — not the usual 20% under old 206AA, now §397(2)) |
| **194J → §393(1) Table Sl.6(iii)**          | Professional / technical services billed directly | **10% professional** (codes 1027/1028) / **2% technical** (code 1026) — _the rates have been distinct since FY 2020-21; the 2025 Act gives them separate payment codes_ | **₹50,000 / FY** (raised from ₹30,000 w.e.f. FY 2026-27; computed _per payment-type_ — professional, technical, royalty each have their own ₹50K) | 20%                                                                                  |
| **194C → §393(1) Table Sl.6(i)**            | Contract works / vendor services                  | 1% (individual/HUF, code 1023) or 2% (others, code 1024)                                                                                                                | ₹30,000 single / ₹1,00,000 aggregate                                                                                                              | 20%                                                                                  |
| **195 → §393(2) Table Sl.17, code 1057**    | Any payment to a non-resident                     | 20% (or DTAA rate if Form 10F + TRC + lower-rate cert produced)                                                                                                         | None                                                                                                                                              | DTAA cap or 20%                                                                      |

**Removed and gone (do not implement):**

- Section 206C(1H) — TCS on sale of goods > ₹50L. Omitted by Finance Act 2025 w.e.f. 1 Apr 2025. ✅ verified 2026-06-05.
- Section 206AB / 206CCA — higher TDS / TCS for non-filers. Omitted w.e.f. 1 Apr 2025. ✅ verified 2026-06-05.

### Income-tax Act 2025 renumbering — verified as of 2026-06-05

The **Income-tax Act, 2025 (Act 30 of 2025)** received Presidential assent 21 Aug 2025 and **came into force 1 Apr 2026** — operationalised by the Income-tax Rules, 2026 (G.S.R. 198(E), 20 Mar 2026); the 1961 Act stood repealed 31 Mar 2026. **Every TDS provision outside salary is consolidated into a single Section 393** (salary TDS → §392; TCS → §394; higher-rate-for-no-PAN, old 206AA/206CC → **§397(2)**, retaining the 20% rate). The old alphanumeric section numbers (194O, 194J, 194C, 195, 206AA…) **cease to exist as filing citations** for any transaction on/after 1 Apr 2026 and are replaced by **numeric payment codes (the 10xx series — publishers cite 1001–1067)** keyed to table serials inside §393. (Exact code endpoints differ across early concordances; treat any single code below as the _publisher-asserted_ mapping pending the final CBDT challan/RPU schema — see follow-up note.)

Verified old→new mapping (sources: Finpracto / Tax2win / Jurishour concordances, Mar–May 2026):

| 1961 Act                       | 2025 Act                | Payment code    | Rate                  |
| ------------------------------ | ----------------------- | --------------- | --------------------- |
| 194O                           | §393(1) Table Sl.8(v)   | **1035**        | 0.10%                 |
| 194J (technical)               | §393(1) Table Sl.6(iii) | **1026**        | 2%                    |
| 194J (professional / director) | §393(1) Table Sl.6(iii) | **1027 / 1028** | 10%                   |
| 194C (individual/HUF)          | §393(1) Table Sl.6(i)   | **1023**        | 1%                    |
| 194C (others)                  | §393(1) Table Sl.6(i)   | **1024**        | 2%                    |
| 195                            | §393(2) Table Sl.17     | **1057**        | rates-in-force / DTAA |
| 206AA / 206CC (no-PAN)         | **§397(2)**             | —               | 20% (retained)        |

**Filing impact (verified):** for Q4 FY 2025-26 (up to 31 Mar 2026) returns still use the old section numbers + old form names. For Tax Year 2026-27 onward, a return filed with an old section number (e.g. "194O") **triggers a system-level validation error at upload**. Form names also change — see [doc 04](./04-tds-quarterly-filings.md) (26Q → Form 140, 27Q → Form 144, 16A → Form 131).

🟡 **Code-vs-law divergence (verified 2026-06-05):** the code still stores and emits the **old labels** — `lib/compliance/tds.ts` `TDS_SECTION_DEFAULTS` keys (`"194O"`, `"194J"`, `"194C"`), `TDSRecord.tdsSection`, and `OrganizationPayout.tdsSectionApplied` all carry `"194O"`/`"194J"`/`"194C"`. These are correct for _internal classification_ but **must be translated to §393 payment codes before any return upload for FY 2026-27** or the FVU/portal upload will reject. This is a filing-export concern, not a withholding-math concern (the _rates_ are unchanged). Tracked as an engineering follow-up; the FVU generator (doc 04) is the right place to map label → code.

## When it applies

### B2C (consumer marketplace)

- A consumer pays the platform via card. Platform is the **e-commerce operator** under Sec 194O Explanation(a). Consultant is the **e-commerce participant** under Explanation(b).
- The right section is **194O at 0.10%**. Threshold of ₹5L applies only to _resident individuals/HUF_ with valid PAN/Aadhaar. For everyone else, withhold from rupee 1.
- For non-resident consultants, **194O does not apply** — pivot to **Sec 195 + DTAA**.

### B2B (org-sponsored)

- Org pays via INVOICE / WALLET / LICENSE → no ECO transaction. The org makes a separate **payout to the consultant** via the org payout pipeline.
- For org → consultant payout, classification is **fact-specific**: if the consultant is engaged via the platform (most common), 194O still applies because the platform is the ECO. If the org engages the consultant directly off-platform with their own contract, **194J** would apply — but that's outside our payout flow.
- Default in code: **194O**. Override on `ConsultantProfile.tdsSection` for the rare direct-engagement case.

### Cross-border

- Non-resident consultant on either rail → **Sec 195**. See [doc 07](./07-cross-border-flows.md) for DTAA, Form 10F, TRC, Form 15CA/CB, FIRC.
- Non-resident consumer paying a resident consultant → still 194O on the resident consultant.

## Current code

Two TDS files, two contracts, partial overlap (re-verified against code 2026-06-05):

| File                                                                   | Section         | Rate                           | Threshold        | No-PAN                                | Notes                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------- | ------------------------------ | ---------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/payments/tax/tds-service.ts` (consultant path, **`@deprecated`**) | 194J            | 10%                            | ₹50,000          | 20%                                   | Header still says "Section 194J flat 10%". Slated for deprecation in favour of the canonical lib once CA signs off on 194-O precedence for consultant payouts (#778 §E). Still live as the conservative default.            |
| `lib/compliance/tds.ts` (canonical / org path)                         | 194O default ✅ | **0.10% ✅** (`"194O": 0.001`) | none for orgs ✅ | **5% ✅** (`NO_PAN_RATE_194O = 0.05`) | **Fixed since the original audit** (#771 P0-1 / #737 / #738) — rate is now 0.001, and 194-O carries its own 5% no-PAN rate distinct from the 206AA/§397(2) 20%. 206AA fallback, §197 cert, and DTAA lookup all implemented. |

🟡 **Two residual code-vs-law nuances (verified 2026-06-05), both in `lib/compliance/tds.ts`:**

- `TDS_SECTION_DEFAULTS["194J"] = 0.1` is a **flat 10%**. Current law (and the 1961 Act since FY 2020-21) distinguishes **technical services at 2%** (code 1026) from **professional/director fees at 10%** (codes 1027/1028). The flat-10% path over-withholds on technical-service consultants. Low blast radius today because 194-O is the platform default, but the residual 194J override path is wrong for technical services.
- Section **labels** (`"194O"`, `"194J"`, `"194C"`) are emitted as-is into `TDSRecord.tdsSection` / `OrganizationPayout.tdsSectionApplied`; these need label→§393-payment-code translation before any FY 2026-27 return upload (see renumbering note above).

The deprecated `tds-service.ts` consultant path historically _skipped_ deduction for non-residents (should pivot to §195/§393(2) + DTAA, not skip). The canonical `lib/compliance/tds.ts` handles NON_RESIDENT via the DTAA-lookup branch; the gap is only on the deprecated path, which is why consolidation onto the canonical lib (#778 §E) is the fix.

### Both rails now write `TDSRecord` (#1354)

`TDSRecord` was a consultant-only table, which meant that host-organisation withholding was computed, deducted from the disbursement and posted to `TDS_PAYABLE` without ever producing a filing row. Organisation payouts now write the same audit row that consultant payouts do, at the moment the payout reaches `COMPLETED` and never earlier, so the quarterly draft covers every deduction the platform actually made.

The table carries both rails at once. `consultantProfileId` and `organizationId` are each nullable and exactly one is set on any row, which `tds_record_deductee_xor` enforces in the database; a second constraint, `tds_record_payout_rail_matches`, prevents a row from citing the payout of the rail it does not belong to. The org rail has its own unique key over `(organizationId, financialYear, quarter, orgPayoutId, isReversal)` rather than sharing the consultant one, because Postgres treats NULLs as distinct and a shared key would silently dedupe nothing. `TdsAdjustment` is widened the same way, so a reversal on either rail produces the revised-statement line the return generator exports.

## Gap

Re-verified against code 2026-06-05. Several rows from the original audit are now **fixed** (struck) because the canonical lib was corrected under #771/#737/#738; the live gaps are the consultant-path consolidation, the 194J split, and the §393 code mapping.

| Gap                                                                                                                | Where                                                                | Severity                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ~~Wrong rate (1% → 0.10%)~~ **FIXED** — `"194O": 0.001`                                                            | `lib/compliance/tds.ts`                                              | ✅                                                                                               |
| ~~Wrong no-PAN fallback (20% → 5% for 194O)~~ **FIXED** — `NO_PAN_RATE_194O = 0.05`                                | `lib/compliance/tds.ts`                                              | ✅                                                                                               |
| Consultant path still 194J/₹50K (deprecated, not yet consolidated onto canonical lib)                              | `lib/payments/tax/tds-service.ts`                                    | 🔴 (blocked on CA signoff, #778 §E)                                                              |
| 194J modelled as flat 10% — no technical-2% (code 1026) vs professional-10% (1027/1028) split                      | `lib/compliance/tds.ts` `TDS_SECTION_DEFAULTS`                       | 🟡                                                                                               |
| Section labels not mapped to §393 payment codes for FY 2026-27 return upload                                       | `lib/compliance/tds.ts`, `TDSRecord.tdsSection`, FVU export (doc 04) | 🔴 (filing-blocking from 1-Apr-2026)                                                             |
| No threshold differentiation by entity type on the deprecated path (companies/LLPs get no threshold under 194-O)   | `tds-service.ts`                                                     | 🟠 (canonical lib treats org payouts as no-threshold; `TaxEntityType` enum now exists in schema) |
| Non-resident path _skips_ deduction on the **deprecated** path (should pivot to §195/§393(2)+DTAA)                 | `tds-service.ts`                                                     | 🔴                                                                                               |
| ~~`ConsultantProfile.taxEntityType` field doesn't exist~~ **ADDED** — `enum TaxEntityType` now in schema (#778 §D) | `prisma/schema.prisma`                                               | ✅                                                                                               |

## Required

In commit order:

1. **`prisma/schema.prisma`** — add `ConsultantProfile.taxEntityType` enum (`INDIVIDUAL` / `HUF` / `PARTNERSHIP` / `COMPANY` / `LLP` / `NON_RESIDENT`). Default `INDIVIDUAL`. Migrate via Supabase MCP.
2. **`lib/compliance/tds.ts`** — fix the rate constant: `"194O": 0.001` (not `0.01`). Add 5% no-PAN constant. Update the no-PAN derivation to apply 5% for 194O / 20% for 194J/194C.
3. **`lib/payments/tax/tds-service.ts`** — pivot the entire file to use `lib/compliance/tds.ts:computeTdsForPayout` (or merge the two). Threshold becomes `taxEntityType === "INDIVIDUAL" || "HUF"` ? `₹5,00,000` : `0`. Non-resident path delegates to Sec 195 (see doc 07).
4. **Migration of historical `TDSRecord` rows**: decide whether to back-correct (refund excess withholding to consultants) or grandfather. Grandfathering is simpler but requires a public communication.
5. **Tests**: per-section, per-entity-type, per-PAN-state, boundary cases at the threshold.

## Acceptance

- A B2C resident-individual consultant earning ₹4L this FY: zero TDS withheld.
- The same consultant earning ₹6L: 0.10% on the marginal ₹1L only (not the full ₹6L).
- A resident **company** consultant earning ₹1: 0.10% withheld immediately.
- A consultant with no PAN: 5% withheld (not 20%).
- A non-resident consultant: pivots to Sec 195 + DTAA via `lib/compliance/tds.ts`, not the B2C 194J file.
- Both `tds-service.ts` and `compliance/tds.ts` use the same rate constants.
- 875+/875+ unit tests pass; new tests cover every threshold/entity/PAN cell.

## References

- [Income-tax Act 2025 in force 1-Apr-2026 — press release (incometaxindia.gov.in)](https://www.incometaxindia.gov.in/documents/d/guest/press-release-income-tax-act-2025-comes-into-force-from-01-april-2026-pdf) — _verified 2026-06-05_
- [Income-tax Act 2025 effective 1-Apr-2026 (PIB PRID 2221416)](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2221416&reg=3&lang=1)
- [TDS/TCS section mapping 1961 → 2025 Act (Finpracto)](https://www.finpracto.com/tds-tcs-section-mapping-from-the-1961-act-to-the-2025-act-your-complete-reference-guide/) — _194O→§393(1) Sl.8(v) code 1035; 194J→Sl.6(iii) 1026/1027/1028; 195→§393(2) Sl.17 code 1057_
- [Old vs new TDS section mapping FY 2026-27 (Jurishour)](https://www.jurishour.in/columns/old-new-tds-sections-mapping-income-tax-act-2025/)
- [206AA/206CC merged into §397(2) (TDSMan, May 2026)](https://blog.tdsman.com/2026/05/higher-rate-of-tds-for-non-furnishing-of-pan-section-3972-206aa-206cc/)
- [Section 194O 0.10% rate + ₹5L threshold (TDSMan)](https://blog.tdsman.com/2025/09/section-194o-tds-on-payments-by-e-commerce-operators-to-participants/) — _0.10% confirmed unchanged for FY 2026-27_
- [TDS Rate Chart FY 2026-27 (TaxGarden)](https://taxgarden.in/blog/tds-rate-chart-2026-to-2027) — _194O 0.1%; 194J 10% prof / 2% technical; §393 payment codes_
- [§194J threshold raised ₹30K → ₹50K w.e.f. FY 2026-27 (Tax2win)](https://tax2win.in/guide/section-194j-under-income-tax-act) — _verified 2026-06-05; ₹50K is per payment-type_
- [Income-tax Rules 2026 G.S.R. 198(E) — new forms 26Q→140 / 27Q→144 / 16A→131 (TDSMan, Mar 2026)](https://blog.tdsman.com/2026/03/new-tds-tcs-forms-it-act-2025-mapping-with-old-forms/) — _verified 2026-06-05_
- See also: [02-gst-overview.md](./02-gst-overview.md) (GST TCS Sec 52 is the GST analogue), [04-tds-quarterly-filings.md](./04-tds-quarterly-filings.md) (Form 26Q→140 / 27Q→144), [07-cross-border-flows.md](./07-cross-border-flows.md) (Sec 195 → §393(2)).
