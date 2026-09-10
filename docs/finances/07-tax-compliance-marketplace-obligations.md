# Tax Compliance — Marketplace Obligations (March 2026)

> Comprehensive tax, compliance, and financial infrastructure requirements for Familiarise as an Indian services marketplace. Supplements [06-tax-compliance-india.md](./06-tax-compliance-india.md).

**Last Updated**: 2026-03-19

---

## The 3 Money Flows

### Flow 1: Consultee → Platform (Checkout)

| Question           | Indian Buyer         | International Buyer            |
| ------------------ | -------------------- | ------------------------------ |
| What do we charge? | Plan price + 18% GST | Plan price only (0% tax)       |
| Which gateway?     | Razorpay (domestic)  | Razorpay IBT                   |
| What currency?     | INR                  | INR (Razorpay converts for us) |

**Code's job**: Detect buyer country → apply correct tax → route to gateway. ✅ Built.

### Flow 2: Platform → Consultant (Payout)

| Question                          | Answer                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------ |
| How much do they get?             | 80% of original price (before tax)                                             |
| Do we deduct anything?            | Only if we've paid them > ₹50K total this financial year (Apr–Mar)             |
| How much to deduct?               | 10% if they gave us their PAN, 20% if they didn't                              |
| Where does the deducted money go? | We deposit it to the government (not our money, not theirs — it's prepaid tax) |

**Code's job**: Track cumulative FY payments → deduct TDS if over ₹50K → send net amount to Razorpay. ✅ Built.

### Flow 3: Platform → Government (Filing)

This is NOT code — it's CA/accountant work. Our code provides the data.

---

## GST for E-Commerce Operators

### Is GST Registration Mandatory?

**YES.** Under **Section 24(x) of the CGST Act**, every e-commerce operator (ECO) must register under GST irrespective of turnover. The normal Rs 20 lakh threshold does NOT apply. (Note: Section 24(ix) applies to suppliers selling _through_ an ECO; Section 24(x) applies to the ECO itself.)

The definition in **Section 2(45)** is broad: "any person who owns, operates or manages digital or electronic facility or platform for electronic commerce." Familiarise qualifies.

### Consultants on the Platform

Under **Notification 65/2017-C.T.**, service providers (consultants) with turnover below Rs 20 lakh are exempt from mandatory GST registration, **unless** their services fall under **Section 9(5)**.

Consulting/professional services are **NOT** in the Section 9(5) notified list (which covers only: passenger transport, accommodation, restaurant services, housekeeping). So consultants with turnover under Rs 20L don't need GST registration.

### TCS (Tax Collected at Source) — GST

| Parameter         | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| TCS Rate          | **0.5%** (reduced from 1% effective July 10, 2024)          |
| Intra-state split | 0.25% CGST + 0.25% SGST                                     |
| Inter-state       | 0.5% IGST                                                   |
| Calculated on     | Net value of taxable supplies (minus returns/cancellations) |
| Filing            | **GSTR-8** by 10th of following month                       |
| Annual statement  | By December 31 following the FY                             |
| Legal basis       | **Section 52 of CGST Act**                                  |

The consultant gets credit in their electronic cash ledger. The "Calculated on" row above is the correct base — TCS under Section 52 is 0.5% of the **net taxable value** of supplies (gross minus returns and cancellations), which is **GST-exclusive**, never the gross amount inclusive of GST. **Model decision (2026-09-03):** [ADR 26](../enterprise/70-design-decisions/26-gst-principal-model.md) locked the platform in as the Principal supplier of record for GST, under which this table does not apply at all — the platform charges GST on the full price and issues its own tax invoice, so there is no "supply by a registered consultant through an e-commerce operator" event to collect TCS on. This section stays in the document as regulatory reference for the facilitator reading that was considered and not chosen; the dormant `GstTcsBatch`/`GstTcsAdjustment` schema is CA-gated, not wired.

### GST on Platform Commission

| Item                     | Rate    | SAC Code                     |
| ------------------------ | ------- | ---------------------------- |
| Platform commission/fees | **18%** | 9962 (retail trade services) |
| Educational services     | **18%** | 999293                       |

Commission invoices to consultants should use SAC 9962 for marketplace commission.

---

## TDS Obligations

### Section 194-O (TDS by E-Commerce Operator)

| Parameter                       | Value                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| TDS Rate (from Oct 1, 2024)     | **0.1%** (reduced from 1%)                                                                        |
| Threshold (Individual/HUF)      | Rs 5 lakh gross sales/year (if PAN/Aadhaar furnished)                                             |
| Threshold (Companies/Firms/LLP) | **No threshold** — TDS from first rupee                                                           |
| No PAN/Aadhaar rate             | **5%** (per Section 206AA)                                                                        |
| Calculated on                   | Gross amount (including GST, shipping charges)                                                    |
| Filing                          | Quarterly in **Form 140** (formerly 26Q, residents) or **Form 144** (formerly 27Q, non-residents) |

### Section 194J (Professional Services TDS)

| Parameter                    | FY 2025-26                    |
| ---------------------------- | ----------------------------- |
| Threshold                    | Rs 50,000/year per consultant |
| Rate (Professional services) | **10%**                       |
| Rate (Technical services)    | **2%**                        |
| No PAN rate                  | **20%**                       |

### TDS Filing Calendar

| Due Date                                    | Action                | Form                    |
| ------------------------------------------- | --------------------- | ----------------------- |
| 7th of each month                           | TDS deposit           | Challan 281             |
| July 31                                     | Q1 return (Apr–Jun)   | Form 140                |
| October 31                                  | Q2 return (Jul–Sep)   | Form 140                |
| January 31                                  | Q3 return (Oct–Dec)   | Form 140                |
| May 31                                      | Q4 return (Jan–Mar)   | Form 140                |
| Within 15 days of quarterly filing due date | Issue TDS certificate | Form 131 (formerly 16A) |

Late filing penalty: Rs 200/day (capped at total TDS amount).

### Critical CA Question

**Do both 194-O (0.1% on gross e-commerce sales) AND 194J (10% on professional services above Rs 50K) apply simultaneously?** They are separate tax provisions (income tax vs e-commerce). Whether one supersedes the other for our specific marketplace model needs professional opinion.

---

## Section 44AD Risk

> **WARNING**: Commission/brokerage income may be excluded from Section 44AD presumptive taxation. Persons earning commission or brokerage income, or carrying on agency businesses, are specifically excluded from 44AD in some interpretations.

| Parameter         | Detail                                                          |
| ----------------- | --------------------------------------------------------------- |
| Turnover limit    | Rs 3 crore (if 95%+ digital receipts) or Rs 2 crore             |
| Deemed profit     | 6% (digital) or 8% (cash) of turnover                           |
| Lock-in           | 5 consecutive years once opted                                  |
| NOT available for | Companies, LLPs, persons earning commission/brokerage (debated) |

**Impact**: If a CA rules that marketplace commission income disqualifies us from 44AD, the "0% tax up to Rs 50L" advantage of Sole Proprietorship in the CFO Master Plan shrinks significantly. **This needs urgent CA verification before finalizing entity structure.**

---

## Cross-Border Payment Compliance

### FEMA Regulations

- All cross-border transactions must comply with **FEMA (Foreign Exchange Management Act), 1999**
- Must use RBI-authorized banks or payment aggregators (Razorpay qualifies)
- Export proceeds must be realized and repatriated within **15 months** from date of invoice for foreign currency invoices, or **18 months** for INR-invoiced exports (updated per RBI Notification FEMA 23(R)/(7)/2025-RB dated November 13, 2025; previously 9 months)
- Records must be kept for **5 years** (invoices, FIRA, contracts, bank advices)

### Export of Services — GST

- Export of services is **zero-rated** under IGST Act **Section 16**
- Conditions: supplier in India, recipient outside India, payment in convertible foreign exchange
- No GST charged on export value
- Exporter eligible to claim ITC refunds on inputs
- Current implementation (`currency !== "INR"` = zero-rated) is directionally correct but should add buyer location verification via billing address

### LRS (Liberalised Remittance Scheme) — For International Consultant Payouts

- Annual limit: **USD 250,000** per resident individual
- TCS threshold (from Budget 2025): **Rs 10 lakh** per FY (increased from Rs 7 lakh)
- LRS is for resident individuals, NOT for companies/partnerships/HUFs
- For a marketplace paying international consultants, use **business outward remittance through an AD bank** under normal FEMA guidelines, not LRS

### International Consultant Payouts

| Method     | Speed    | Cost                   | Notes                          |
| ---------- | -------- | ---------------------- | ------------------------------ |
| Wise       | 1–3 days | ~1.6–1.7% + $2         | Good UI, mid-market FX rate    |
| PayPal     | 1–3 days | Up to 4.4% + FX markup | Widest reach, highest cost     |
| Payoneer   | 2–5 days | 2% FX markup           | Popular for freelancer payouts |
| SWIFT/Wire | 3–7 days | Rs 1,000+ per transfer | Costliest, most traditional    |

For Section 195 TDS on payments to non-resident consultants, rates vary by DTAA (Double Taxation Avoidance Agreement). Requires 15CA/15CB certificates for outward remittances.

---

## Payment Aggregator License

### Does Familiarise Need One?

**Almost certainly NO**, as long as we use a licensed PA (Razorpay) rather than directly handling payment flows.

| Scenario                                                     | PA License Needed?          |
| ------------------------------------------------------------ | --------------------------- |
| Use Razorpay to collect payments, they settle to our account | **No** — we are a merchant  |
| Use Razorpay Route to split payments to sellers              | **No** — Razorpay is the PA |
| Collect payments into our own pool/escrow and distribute     | **Possibly YES**            |
| Directly handle card data or bank details                    | **YES**                     |

PA license requirements (for reference): Rs 15 crore net worth at application, Rs 25 crore within 3 years, escrow account with Scheduled Commercial Bank.

---

## Mandatory Compliance Summary

### From Day 1

| Obligation                                                                                                                                                                                                                                                                                               | Rate | Filing                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------- |
| GST Registration (as ECO, no turnover threshold)                                                                                                                                                                                                                                                         | N/A  | Must register before launch                     |
| TCS collection on net taxable supplies — **CA-gated, not applicable today.** The platform bills as principal under ADR 26, so Section 52 TCS does not apply and no TCS is collected; this row is a facilitator-model reference that only becomes live if a chartered accountant overturns that decision. | 0.5% | GSTR-8 by 10th monthly (facilitator model only) |
| TDS u/s 194-O on gross e-commerce payments                                                                                                                                                                                                                                                               | 0.1% | Form 140 quarterly                              |
| TDS u/s 194J on consultant payouts > Rs 50K/yr                                                                                                                                                                                                                                                           | 10%  | Form 140 quarterly                              |
| GST on platform commission                                                                                                                                                                                                                                                                               | 18%  | GSTR-1/GSTR-3B monthly                          |
| Export zero-rating (international buyers)                                                                                                                                                                                                                                                                | 0%   | Verify buyer location                           |

### For International Transactions

- FEMA compliance for all cross-border payments
- Export of services = zero-rated GST (with billing address verification)
- Section 195 TDS on payments to non-resident consultants (rate per DTAA)
- 15CA/15CB certificates for outward remittances

### Annual

- GSTR-9 annual return
- Income tax return (ITR-4 if 44AD, ITR-3 otherwise)
- TDS annual statement by December 31

---

## The Jargon Decoder

| Scary Term                  | What It Actually Means                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GST (18%)                   | Sales tax. We add it on top of the price for Indian buyers.                                                                                                                                                                          |
| Zero-rated export           | Fancy way of saying "no tax for international buyers"                                                                                                                                                                                |
| TDS (Section 194J)          | When we pay consultants, we hold back 10% as their prepaid income tax and send it to the government. Only kicks in after ₹50K/year.                                                                                                  |
| PAN                         | Like a tax SSN. If consultant doesn't give us one, we deduct 20% instead of 10% (penalty rate).                                                                                                                                      |
| eFIRC                       | A receipt proving we received foreign money legally. Razorpay generates this automatically. We don't write code for it.                                                                                                              |
| LUT (Letter of Undertaking) | A form filed with GST authorities saying "we export services, don't charge us GST on those." One-time filing, not code.                                                                                                              |
| SAC Code (999293)           | The consumer invoice model's default classification code (`ConsumerInvoice.sacCode`), with **998311** as the alternative pending the CA's answer (#1369) — both carry 18% GST. Goes on invoices.                                     |
| Form 140 (formerly 26Q)     | Quarterly report to government: "here's all the TDS we deducted." Our admin API provides the data, CA files the form.                                                                                                                |
| FEMA                        | Foreign exchange law. As long as we use Razorpay (RBI-licensed), we're compliant. Not our problem in code.                                                                                                                           |
| TCS                         | Tax Collected at Source — 0.5% the platform would collect from supplier on behalf of government under the facilitator model. CA-gated and not applicable today because the platform bills as principal (ADR 26). Different from TDS. |
| Section 194-O               | E-commerce specific TDS — 0.1% on gross sales. Separate from 194J.                                                                                                                                                                   |
| PA-CB                       | Payment Aggregator — Cross Border license from RBI. Needed to process international payments. Razorpay has one.                                                                                                                      |

---

## Recommended Financial SaaS Stack

| Need                  | Recommendation                                 | Cost               | Why                                                                                                                                 |
| --------------------- | ---------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Accounting            | Zoho Books                                     | Rs 1,249/mo        | GST-compliant, auto-reconciliation with Razorpay, TDS management, multi-currency                                                    |
| GST Filing            | ClearTax or Zoho Books built-in                | Varies             | Auto GSTR-1/3B filing, e-invoicing; GSTR-8 tooling is conditional on the facilitator model reversing ADR 26 and is not needed today |
| TDS Filing            | RazorpayX (auto-TDS) + ClearTax                | Included/varies    | RazorpayX auto-deducts/deposits TDS, generates Form 131                                                                             |
| Invoicing             | Zoho Invoice (free up to 1,000/yr) or built-in | Free–low           | GST-compliant invoices with SAC codes                                                                                               |
| Reconciliation        | Razorpay Dashboard + Zoho Books sync           | Included           | Auto-match payments to invoices                                                                                                     |
| International payouts | Wise Business (later)                          | ~1.6% per transfer | Best FX rates, API available, for paying international consultants                                                                  |

### Phased Approach

1. **Pre-launch to Rs 50L revenue**: Zoho Books + RazorpayX auto-TDS + hire CA for quarterly returns
2. **Growing**: Add ClearTax for GST/TDS filing automation
3. **50+ consultants**: Consider Firmway for 26AS reconciliation

---

## Before-Launch Checklist

### ✅ Already Done

- Detect buyer country at checkout
- Charge 18% GST for India, 0% for international
- Auto-route to Razorpay for all payments
- Track buyerCountry and isInternational on Payment record
- TDS calculation (₹50K threshold, 10%/20% rates)
- TDS auto-deduction at payout time
- Consultant PAN/GSTIN collection API
- Admin TDS dashboard API
- Currency validation on discounts and referral credits
- Invoice zero-rating for international

### ⬜ Before Launch (Non-Code — You + CA)

- [ ] Get CA opinion: are we an "e-commerce operator"? (affects GST registration)
- [ ] Get CA opinion: does 44AD apply to marketplace commission income?
- [ ] Get CA opinion: do 194-O and 194J both apply simultaneously?
- [ ] File LUT with GST authorities (one-time, enables zero-rating legally)
- [ ] Activate Razorpay IBT on dashboard (KYC process with Razorpay)
- [ ] Register for GST (likely mandatory from day 1)

### ⬜ After Launch (When Volume Grows)

- [ ] EU VAT registration (only if EU sales exceed thresholds)
- [ ] Australian GST (only if AU sales > AUD 75K/year)
- [ ] International consultant payouts (provider not yet selected; Section 195 withholding is unimplemented, see payout-service.ts)
- [ ] Form 131 (formerly 16A) auto-generation for consultants (annual TDS certificate)

### 🚫 NOT Our Problem

- 1099-NEC for US consultants — we're not a US company, doesn't apply
- Withholding tax on international consultants — not required from India
- Currency conversion — Razorpay handles forex, we always deal in INR
- FEMA compliance — handled by using an RBI-licensed gateway (Razorpay)
- PA license — not needed since we use Razorpay as PA
- PF (Provident Fund) — only when 20+ employees
- ESI (Employee State Insurance) — only when 10+ employees
- Gratuity — only when 10+ employees AND someone completes 5 years
- ROC filing — only for companies/LLPs, not Sole Proprietorship
- Angel tax — abolished from FY 2025-26
- ISO/SOC certifications — only for enterprise B2B
- Pvt Ltd conversion — only when seeking VC funding

---

## Employment Obligations (PF/ESI/Gratuity — Not Applicable)

These are **employment** obligations, not platform obligations. They have nothing to do with your SaaS code.

| Obligation   | What It Is                                                                     | When Mandatory | Applies to Consultants?      |
| ------------ | ------------------------------------------------------------------------------ | -------------- | ---------------------------- |
| **PF (EPF)** | Retirement savings — employer pays 12% of basic salary                         | 20+ employees  | No — independent contractors |
| **ESI**      | Health insurance for employees earning < Rs 21,000/month — employer pays 3.25% | 10+ employees  | No — independent contractors |
| **Gratuity** | Bonus after 5 years continuous service — 15 days salary per year of service    | 10+ employees  | No — independent contractors |

### Why Consultants Are Not Employees

Platform consultants are independent contractors because they:

- Set their own prices
- Set their own schedules
- Use their own expertise
- Are not under platform supervision for how they deliver service
- Can work on multiple platforms simultaneously
- Are not on the platform payroll

### Internal Team

- **Shubham** (Rs 10K base + Rs 5K bonus): Could be employee or contractor, but with 2 people none of PF/ESI/Gratuity applies
- **Shelu** (pure commission, Rs 200–300/conversion): Clearly a contractor — no fixed hours, no base pay

**Bottom line:** Forget about PF/ESI/Gratuity until you hire 10+ people. This is an HR/payroll problem for the future, not a code problem.

> **Warning about misclassification:** If someone works fixed hours, uses your tools, is under your day-to-day supervision, and works exclusively for you — calling them a "contractor" does not make them one. Labor courts look at the substance of the relationship, not the label.

---

## CA / Legal Action Items (Non-Code)

These items are for your CA or legal advisor, not engineering.

### Before Launch (Priority)

| #   | Action                                                           | Impact                                               | Estimated Cost            |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| 1   | CA opinion: "Are we an e-commerce operator under Section 2(45)?" | Determines GST registration, TCS, GSTR-8 obligations | Rs 5–10K one-time         |
| 2   | CA opinion: "Which TDS section — 194J or 194-O or both?"         | Different rates and thresholds                       | Part of same consultation |
| 3   | CA opinion: "Does 44AD apply to marketplace commission income?"  | Determines if Sole Prop tax advantage holds          | Part of same consultation |
| 4   | GST registration (if CA advises)                                 | Must be done before first payment                    | Rs 2–5K                   |
| 5   | LUT filing for export zero-rating                                | Must be done before first international transaction  | Free (online filing)      |
| 6   | Monthly CA retainer for GST filing                               | GSTR-1, GSTR-3B, GSTR-8 (if applicable)              | Rs 2–5K/month             |

### Immediate Non-Code Tasks

1. Run Prisma migration (`npx prisma migrate deploy`) — 1 minute
2. Set `PAN_ENCRYPTION_KEY` in environment (`openssl rand -hex 32`) — 1 minute
3. Get IEC (Import Export Code) — Rs 500, DGFT website, 3–5 days
4. Open business bank account (free)

---

## Related Documentation

- [06-tax-compliance-india.md](./06-tax-compliance-india.md) — Original tax compliance doc
- [Gateway Evaluation](../payments/gateways/gateway-evaluation-mar-2026.md) — Full gateway comparison
- [Multi-Currency Architecture](../payments/multi-currency/) — IBT, gateway auto-routing
- [11-cfo-master-plan.md](./11-cfo-master-plan.md) — Financial strategy and entity structure
