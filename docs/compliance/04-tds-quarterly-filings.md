# 04 — Form 26Q / 27Q / 16A — quarterly TDS returns + consultant certificates

> **Status:** schema-tracking is real (`TDSRecord.reportedInForm26Q` flag); FVU export + filing automation + Form 16A generation all missing. 🔴 **NEW (2026-06-05): the Income-tax Act, 2025 + Income-tax Rules, 2026 renamed every TDS form w.e.f. 1-Apr-2026 — 26Q→Form 140, 27Q→Form 144, 16A→Form 131. The `reportedInForm26Q` flag name is now a legacy label (the _concept_ is unchanged; the form it maps to is Form 140 for FY 2026-27+).**
> **Audience:** payout pipeline + admin tax-ops dashboard.
> **Last reviewed:** 2026-06-05 (regulatory facts web-verified as of 2026-06-05; prior review 2026-05-02)
> **Linked issues:** [#737 §6](https://github.com/Practitionist/familiarise_web/issues/737), [#738 Phase 2 PR 2.2](https://github.com/Practitionist/familiarise_web/issues/738).

## What it is

Three related deliverables to the income-tax department after every quarter's TDS deductions. **Form names changed under the Income-tax Act, 2025 (Income-tax Rules, 2026, G.S.R. 198(E)) for any return covering a period on/after 1-Apr-2026** — verified 2026-06-05:

| Deliverable                                                            | Form (1961 Act → 2025 Act) | Frequency                                | Audience                        |
| ---------------------------------------------------------------------- | -------------------------- | ---------------------------------------- | ------------------------------- |
| Quarterly TDS return (resident payees)                                 | **26Q → Form 140**         | Quarterly                                | Income Tax Dept (TRACES / NSDL) |
| Quarterly TDS return (non-resident payees)                             | **27Q → Form 144**         | Quarterly                                | Income Tax Dept                 |
| Consultant TDS certificate (income other than salary, §195(4) wording) | **16A → Form 131**         | Issued within 15 days of return due date | The consultant                  |

**Filing transition (verified):** Q4 FY 2025-26 (period up to 31-Mar-2026) returns are still filed under the **old** form names (26Q/27Q/16A) + old section numbers. From the Q1 FY 2026-27 return onward (Apr–Jun 2026, due ~31-Jul-2026), use the **new** form numbers (140/144/131) + §393 payment codes (the 10xx series — see [doc 01](./01-tds-overview.md)). Section codes inside the FVU change from `194O`/`194J`/`194C` strings to the numeric §393 payment codes. Related renumbering: 24Q→138, 16→130, 26AS→168, 15CA→145, 15CB→146.

**Cadence (unchanged for FY 2025-26 and FY 2026-27 — due dates were not altered by the 2025 Act; verified 2026-06-05):**

| Quarter | Period  | Return due |
| ------- | ------- | ---------- |
| Q1      | Apr–Jun | 31 Jul     |
| Q2      | Jul–Sep | 31 Oct     |
| Q3      | Oct–Dec | 31 Jan     |
| Q4      | Jan–Mar | **31 May** |

**TDS deposit (separate from return):** by **7th of following month**; March deductions by 30 Apr.

**Threshold note (verified 2026-06-05):** the §194J professional/technical threshold rose ₹30,000 → **₹50,000/FY** from FY 2026-27 (per payment-type); §194O stays at ₹5,00,000/FY for resident individuals/HUF. See [doc 01](./01-tds-overview.md).

**Penalties (section numbers shown 1961-Act → 2025-Act equivalent; the ₹/day mechanics are unchanged):**

- Late filing: ₹200/day under **Sec 234E** (→ §427 of the 2025 Act), capped at the TDS amount.
- Non-filing > 1 year: ₹10,000–₹1,00,000 under **Sec 271H** (→ penalty provisions consolidated in the 2025 Act).
- Wrong PAN / mis-quoted: separate Sec 271H penalty.

🟡 _The 271H/234E → 2025-Act mappings are penalty-provision equivalents; cite the 1961-Act numbers for any return/period up to 31-Mar-2026, and verify the exact 2025-Act penalty section before quoting it in a notice. The ₹-amounts are unchanged._

## When it applies

### B2B (org-sponsored)

- **Applies** for org → consultant payouts where TDS was withheld. `OrganizationPayout.tdsAmountPaise` records what was withheld from the disbursement, and since #1354 the payout also writes a `TDSRecord` when it completes, so the return is built from `TDSRecord` on both rails rather than from the payout tables.
- Resident consultant → 26Q. Non-resident → 27Q.
- Form 16A is issued by the **deductor** (the platform) to the consultant, even though the org "paid" via its wallet/invoice. The platform is the legal deductor because we run the payout.

### B2C (consumer marketplace)

- **Applies** for every consultant payout that crossed the 194O threshold and had TDS withheld. `Payout.tdsAmount` (B2C side) is the source of truth.
- Same 26Q (resident) / 27Q (non-resident) split.

### Cross-cutting

- The same consultant may have earnings on **both rails** in a quarter. The quarterly return should aggregate **all TDS** for that consultant (both `OrganizationPayout` and `Payout` rows), not file them separately.

## Current code

| File                                           | What it does                                                                                                                                  | State           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `TDSRecord` (schema)                           | Per-payout TDS row with FY, quarter, cumulative, deducted, rate, `reportedInForm26Q` flag                                                     | ✅ schema-final |
| `lib/payments/tax/tds-service.ts:268, 298–312` | `getUnreportedRecordsForQuarter`, `markAsReported`                                                                                            | ✅ basic CRUD   |
| `lib/payments/tax/pan-crypto.ts:53`            | "Only needed for Form 26Q admin filing" comment — PAN encryption helper                                                                       | ✅              |
| FVU file generator                             | **Missing**                                                                                                                                   | 🔴              |
| 27Q file generator (non-resident)              | **Missing**                                                                                                                                   | 🔴              |
| Form 16A PDF                                   | **Missing**                                                                                                                                   | 🔴              |
| `jobs/compliance/tds-26q-draft-export.ts`      | Quarterly draft builder: aggregates the quarter's `TDSRecord` rows on both rails, prints the masked draft, writes the full-PAN CSV to storage | ✅              |
| `.github/workflows/tds-return-draft.yml`       | Runs that job at 01:20 UTC on the 5th of January, April, July and October, and on manual dispatch                                             | ✅              |
| `app/api/admin/compliance/tds-return/route.ts` | ADMIN-only hop that exchanges an FY and quarter for a short-lived signed URL to the CSV                                                       | ✅              |
| Quarterly dashboard                            | **Missing**                                                                                                                                   | 🔴              |
| TRACES / NSDL e-filing integration             | **Missing**                                                                                                                                   | 🔴              |

## Running the quarterly draft

The draft is produced by the **TDS quarterly return draft** workflow (`.github/workflows/tds-return-draft.yml`). It runs on its own schedule at 01:20 UTC on the fifth of January, April, July and October, which is 06:50 IST on the fifth day after each fiscal quarter closes, and it can also be dispatched by hand from the Actions tab. A manual dispatch takes two optional inputs, `financialYear` in the `2026-27` form and `quarter` as a digit from 1 to 4; leaving both blank builds the quarter that closed, which is what the scheduled run does and what filing means, so a run on the fifth of April builds the January-to-March quarter of the financial year that has just ended rather than the five days of the new one. To look at a quarter that is still open you have to name it explicitly. A malformed input fails the job rather than emitting a mislabelled compliance artifact.

The job produces two things. The first is a **masked** draft, printed as JSON in the workflow log and safe to read, copy and quote: it carries each deductee's type, name, section, §393 payment code, credited amount and net TDS, together with the last four characters of their PAN and never more. The second is the **full-PAN CSV** the chartered accountant actually imports, written to the private Supabase bucket `org-invoices` at `compliance/tds/<FY>-Q<quarter>.csv`. The job logs only that path. There is deliberately no Actions artifact upload, because an artifact is downloadable by anyone with repository read access and this file is the one place a decrypted PAN exists outside the database.

That bucket provisions itself. Until September 2026 the `org-invoices` bucket had never actually been created on the live Supabase project, so the first end-to-end run of this job failed with `Bucket not found`, and the organization invoice PDF route shared the same latent fault because both write through the same helper. The upload path now calls `ensurePrivateFinanceBucket` in `lib/storage/private-finance-object.ts` before every write. That function asks Supabase for the bucket and creates it as a private bucket with a 25MB per-object limit only when it is genuinely absent, then remembers the answer for the rest of the process. No operator has to create anything by hand, and re-running the job against a fresh project is safe. Note that the separate `invoices` bucket visible in the Supabase dashboard is an unrelated March 2026 leftover that no current code path reads or writes, and it should not be confused with this one.

To fetch the CSV, an admin calls `GET /api/admin/compliance/tds-return?financialYear=2026-27&quarter=2`. The route is ADMIN-only rather than merely privileged, because the object it hands out carries decrypted PANs and that is the same bar `/api/admin/tds?view=form26q` has always applied. Both query parameters are validated as a canonical April-to-March pair and a single digit from 1 to 4, so a malformed period is answered with a 400 rather than a redirect to some other quarter's file. The route answers 404 when no CSV exists for that quarter, which means the workflow has not been run for it yet, and otherwise redirects to a signed URL that expires after ten minutes. That short window is intentional: a URL left in a browser history or a chat message is dead long before anyone else finds it.

The CSV has one row per deductee and section, with the columns `deductee_type`, `pan`, `deductee_name`, `section`, `payment_code`, `amount_credited_paise`, `tds_deducted_paise`, `quarter`, `financial_year` and `is_reversal`. A deductee whose withholding was reversed during the quarter gets a second row with `is_reversal` set to true, a zero credited amount and the negative reversal figure, because the portal treats a reversal as an adjustment against a previously reported credit rather than as a new credit of its own. Values are escaped against spreadsheet formula injection, but a cell that is a plain number is left alone, so the negative figures import as numbers rather than as text.

**The FVU step is still a human one.** The CSV is an input to the official NSDL Return Preparation Utility, not a replacement for it: nothing in this pipeline generates or validates an FVU file, and nothing files anything with TRACES. The workflow also deliberately does not stamp `reportedInForm26Q`, so re-running it for the same quarter is safe and idempotent, and the flag continues to mean "a human filed this" rather than "a job exported this".

Two warnings on the draft deserve attention before filing. A deductee with no PAN on file has to be withheld at the punitive rate under §397(2), so the draft names how many lines are affected and the withheld amount should be checked before the return goes out. From FY 2026-27 the draft also flags any section with no §393 payment code, which means no effective-dated `TdsRate` row covers that section as at the quarter end.

## Gap

1. No FVU file generator — TRACES requires a specific text-format file generated by the official RPU utility or a GSP.
2. No 27Q for non-resident consultants — currently the code can't produce a return for them at all (and the B2C TDS code skips deduction for them entirely; see [doc 01](./01-tds-overview.md)).
3. No Form 16A PDF generator — consultants cannot get their TDS certificates from us.
4. No admin dashboard at `/dashboard/admin/tds/quarterly-returns` — no way to see "what's pending for this quarter, what's filed, what's missing PAN".
5. No PAN-mismatch / mis-quote validation pre-filing — risk of penalty if a consultant gave a wrong PAN.
6. **Both rails not aggregated** at the consultant level for filing — risk of duplicate or missing entries.

## Required

In commit order:

1. **Quarterly aggregator query**: a single SQL/Prisma query that, given a consultant and an FY quarter, returns the list of all TDS withholdings from both `OrganizationPayout` and `Payout` rows. Test with mixed-rail consultants.
2. **FVU generator** for 26Q→**Form 140** (resident): output a `.txt` file in NSDL FVU format. Include the fields (deductor TAN, deductee PAN, section code, rate, amount, deduction date, deposit challan refs). **For FY 2026-27+ the section field must carry the §393 numeric payment code, not the `194O`/`194J`/`194C` string** — add a label→code mapping at the export boundary (the code stores the old labels on `TDSRecord.tdsSection`; see [doc 01](./01-tds-overview.md) §393 renumbering note). An upload with a literal old section string will be rejected by the portal/FVU validator.
3. **FVU generator** for 27Q→**Form 144** (non-resident): same shape, §393(2) Table Sl.17 (code 1057, the old Sec 195) + DTAA fields (treaty country, treaty rate, Form 10F ref).
4. **Form 16A PDF generator**: per-consultant per-quarter PDF using the standard 16A template. Include all withholdings for that quarter aggregated across rails.
5. **Admin dashboard** `/dashboard/admin/tds/quarterly-returns`:
   - Pending (current quarter, not filed)
   - Filed (return reference + filing date)
   - Issues (missing PAN, mis-quoted PAN, mismatched cumulative)
6. **Filing automation**: either upload the FVU manually via TRACES, or auto-submit via a GSP (ClearTax / KDK SoftwareSpanner). Phase 2.
7. **Cron `jobs/tds/quarterly-return-prep.ts`**: runs on the 1st of the month following quarter end (1 Jul / 1 Oct / 1 Jan / 1 Apr). Generates the FVU + 16A artifacts; emails admin a "Q ready for filing" notification.
8. **Email Form 16A to consultants**: within 15 days of return due date — automated email with the PDF attached. Uses Novu / Resend.

## Acceptance

- Q1 FY26-27 (Apr–Jun 2026) generates a FVU file by 1 Jul that passes the NSDL validation utility offline.
- Form 16A PDFs generated for every consultant who had TDS in Q1; emailed to each within 15 days of filing.
- Mixed-rail test case: consultant earns ₹10L on B2B + ₹4L on B2C in Q1 — Form 16A shows aggregated TDS across both rails.
- Non-resident consultant generates 27Q file with DTAA refs.
- Admin dashboard shows the per-consultant breakdown + flags PAN issues.

## Don't build

| Don't build                      | Reason                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Internal NSDL portal scraper     | TRACES requires DSC + 2FA; portal scraping breaks regularly. Use a GSP.               |
| Custom 16A template font-by-font | Standard PDF template ships with the income-tax dept's RPU. Use the canonical layout. |

## References

- [Form 26Q (ClearTax)](https://cleartax.in/s/tds-return-non-salary)
- [TDS return due dates (SAG Infotech)](https://blog.saginfotech.com/due-date-filing-tds-tcs-return) — _quarterly due dates unchanged for FY 2026-27; verified 2026-06-05_
- [New TDS/TCS forms under IT Act 2025 — 26Q→140, 27Q→144, 16A→131 (TDSMan, Mar 2026)](https://blog.tdsman.com/2026/03/new-tds-tcs-forms-it-act-2025-mapping-with-old-forms/) — _verified 2026-06-05_
- [12 key tax forms changing from 1-Apr-2026 (Business Today)](https://www.businesstoday.in/personal-finance/tax/story/new-income-tax-act-2025-explained-12-key-tax-forms-changing-from-april-1-2026-530661-2026-05-10) — _verified 2026-06-05_
- [Income-tax e-filing portal](https://www.incometax.gov.in/iec/foportal/)
- [NSDL TRACES](https://contents.tdscpc.gov.in/)
- See also: [01](./01-tds-overview.md) (sections + rates + §393 codes), [07](./07-cross-border-flows.md) (27Q→144 for non-residents), [05](./05-refund-and-chargeback-tax-adjustments.md) (refund-of-quarter-already-filed handling).
