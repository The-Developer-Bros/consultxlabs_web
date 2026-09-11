# International Consultant Payouts from India

> **Research Date:** March 2026
> **Key Question:** How can Familiarise (Indian entity) legally pay consultants in US, UK, Europe, etc.?

> **Status: dated research, not current guidance.** Written March 2026 and kept
> for the regulatory groundwork it records, which is still useful. Its gateway
> shortlist is not: **XFlow was evaluated and rejected** (it is cross-border B2B
> settlement infrastructure, not a payment gateway) and removed from the
> codebase in #984, and Lemon Squeezy was rejected for prohibiting services in
> its ToS. Neither is a current option. The live rails are Razorpay (primary,
> INR settlement) and Stripe (the request→approve booking path). See
> [../gateways/README.md](../gateways/README.md) for what is actually wired.

---

## 1. Available Payout Channels

### Option A: Stripe Connect (Recommended for Scale)

| Aspect              | Details                                               |
| ------------------- | ----------------------------------------------------- |
| Countries supported | 47+ countries (US, UK, EU, AU, CA, SG, etc.)          |
| Payout currencies   | Local currency in each country                        |
| Fees                | 0.25% per cross-border payout + Stripe standard fees  |
| Settlement          | T+2 days                                              |
| KYC                 | Stripe handles onboarding of connected accounts       |

**Critical limitation for India:**
- Stripe India can only pay out in **INR to Indian bank accounts**
- Cross-border payouts from India are **NOT available self-serve**
- Need to contact Stripe sales for custom cross-border payout arrangements
- Alternative: Use a Stripe account in US/UK/SG as the platform entity

**How Maven.com does it:**
- Instructors keep 90% of revenue minus Stripe fees
- Payouts via Stripe Connect to instructor's local bank account
- Available in all Stripe Connect-supported countries
- Maven collects/remits EU VAT on behalf of instructors

### Option B: Wise Business API

| Aspect              | Details                                               |
| ------------------- | ----------------------------------------------------- |
| Countries supported | 80+ countries                                         |
| Payout currencies   | 50+ currencies                                        |
| Fees                | 0.5-2% (varies by corridor)                           |
| Settlement          | 1 business day                                        |
| API                 | REST API for programmatic payouts                     |
| RBI status          | In-principle PA-CB approval (June 2025)               |

**Advantages:**
- Mid-market exchange rates (no hidden markup)
- API-driven for automation
- Lower fees than bank wire transfers
- Multi-currency accounts
- Transparent pricing

**Wise India developments (2025-2026):**
- RBI granted in-principle PA-CB export approval (June 2025)
- Launching multi-currency prepaid forex card for Indian users
- 75,000+ on waitlist for India card
- Growing adoption among Indian freelancer platforms

### Option C: Payoneer

| Aspect              | Details                                               |
| ------------------- | ----------------------------------------------------- |
| Countries supported | 190+ countries                                        |
| Payout currencies   | Multiple                                              |
| Fees                | 2% withdrawal fee + forex markup                      |
| Settlement          | 2-5 business days                                     |
| RBI status          | In-principle PA-CB approval (Jan 2026)                |

**How Upwork/Fiverr use it:**
- Upwork: Payoneer is default for non-US bank transfers ($0.99/transfer)
- Fiverr: Payoneer is primary payout for Indian users
- Conversion markup: 2-4% worse than mid-market rate

### Option D: PayPal Business

| Aspect              | Details                                               |
| ------------------- | ----------------------------------------------------- |
| Countries supported | 200+ countries                                        |
| Fees                | 3-5% total (commission + forex)                       |
| Settlement          | 3-5 business days                                     |
| RBI status          | In-principle PA-CB export approval (May 2025)         |

**How TopMate uses it:**
- PayPal is their only option for non-India/non-US creators
- Effective total fee: 16-18% for international creators (platform + gateway + forex + PayPal)

### Option E: Direct Bank Wire (SWIFT)

| Aspect              | Details                                               |
| ------------------- | ----------------------------------------------------- |
| Countries supported | Global                                                |
| Fees                | Rs 500-2,000 + Rs 300-1,000 SWIFT fee + 18% GST      |
| Settlement          | 2-5 business days                                     |
| Forex markup        | 1.5-2% bank markup on exchange rate                   |
| Intermediary fees   | $15-30 deducted by intermediary banks                  |

**Total cost per wire:** Rs 2,000-5,000 (~$22-55) per transaction
**Verdict:** Too expensive for frequent small payouts. Only viable for large, infrequent settlements.

### Option F: Xflow (Emerging Alternative)

| Aspect              | Details                                               |
| ------------------- | ----------------------------------------------------- |
| Focus               | Indian B2B cross-border payments                      |
| Volume              | ~$1B annualized (2025)                                |
| Funding             | $16.6M Series A (Stripe, PayPal Ventures, Gen Catalyst)|
| Settlement          | 1 business day to Indian bank                         |
| RBI status          | Final PA-CB authorization                             |
| Best for            | Receiving international payments INTO India            |

**Note:** Xflow is primarily for inward remittances (receiving USD/EUR into INR). Less relevant for outward payouts to international consultants.

---

## 2. Section 195 TDS on Payments to Non-Residents

### When TDS Applies

Any payment to a non-resident (other than salary) that is **chargeable to tax in India** requires TDS deduction under Section 195.

### TDS Rates

| Payment Type                 | Rate (Act) | DTAA Rate (US) | DTAA Rate (UK) |
| ---------------------------- | ---------- | -------------- | -------------- |
| Royalties                    | 20%        | 10-15%         | 10-15%         |
| Fees for technical services  | 10%        | 10-15%         | 10-15%         |
| Professional/consulting fees | 10%        | Varies by DTAA | Varies by DTAA |
| Interest                     | 20%        | 10-15%         | 10-15%         |

**Important nuance:** If the non-resident consultant does NOT have a Permanent Establishment (PE) in India, and the services are provided **outside India**, TDS may NOT apply under most DTAAs. However, this requires careful analysis.

### DTAA Benefits

To avail lower DTAA rates, the non-resident must provide:
1. **Tax Residency Certificate (TRC)** from their home country
2. **Form 10F** (self-declaration)
3. **PAN or special exemption**

**India has DTAAs with 90+ countries** including US, UK, Canada, Australia, Germany, Singapore.

---

## 3. Form 15CA / 15CB Requirements

### When Required

| Scenario                                    | Form 15CA | Form 15CB (CA Certificate) |
| ------------------------------------------- | --------- | -------------------------- |
| Remittance < Rs 5 lakh in FY               | Part A    | NOT required               |
| Remittance > Rs 5 lakh, taxable in India   | Part C    | Required                   |
| Remittance > Rs 5 lakh, covered by DTAA    | Part C    | Required                   |
| Remittance > Rs 5 lakh, NOT taxable        | Part D    | NOT required               |

### Cost of 15CB Certificate

| Provider        | Cost per certificate |
| --------------- | -------------------- |
| CA (individual) | Rs 1,500-3,000       |
| Online services | Rs 4,000-6,000       |
| CA firm         | Rs 3,000-5,000       |

### Penalty for Non-Filing

Rs 1,00,000 penalty under Section 271-I, **even if the payment wasn't taxable**.

### Practical Impact for Familiarise

- For small payouts (< Rs 5L per consultant per FY): Only Form 15CA Part A needed (self-filed, no CA required)
- For larger payouts: Need CA certificate for each remittance batch
- **Recommendation:** Batch international payouts monthly/quarterly to reduce compliance overhead

---

## 4. DTAA Country-wise Quick Reference

| Country   | Technical Services | Professional Fees | Interest | Notes                    |
| --------- | ------------------ | ----------------- | -------- | ------------------------ |
| USA       | 10-15%             | Per DTAA analysis | 10-15%   | No PE = likely no TDS    |
| UK        | 10-15%             | Per DTAA analysis | 10-15%   | Similar to US            |
| Canada    | 10-15%             | Per DTAA analysis | 15%      | Similar to US            |
| Australia | 10%                | Per DTAA analysis | 15%      | -                        |
| Germany   | 10%                | Per DTAA analysis | 10%      | -                        |
| Singapore | 10%                | Per DTAA analysis | 15%      | -                        |
| UAE       | -                  | -                 | -        | No income tax in UAE     |

**Key insight:** For consulting fees paid to non-residents without Indian PE, many DTAAs provide that the income is taxable ONLY in the consultant's country of residence. This means **no TDS** is required. But you need CA advice to confirm for each country.

---

## 5. Comparison: How Competitors Handle International Payouts

| Platform  | Method                    | Countries       | Effective Fee      |
| --------- | ------------------------- | --------------- | ------------------ |
| TopMate   | Bank (IN/US) + PayPal     | 100+ via PayPal | 16-18% total       |
| Upwork    | Payoneer + PayPal + Wire  | 180+            | 2-4% forex markup  |
| Fiverr    | PayPal + Payoneer         | 160+            | 20% platform + 2%  |
| Maven     | Stripe Connect            | 47+ countries   | 10% + Stripe fees  |
| Toptal    | Direct wire / Payoneer    | Global          | 0% commission      |
| Calendly  | Stripe/PayPal (user-managed) | 46+ (Stripe) | No platform fee    |

---

## 6. Recommended Approach for Familiarise

### Phase 1: India-Only (Current)
- Razorpay payouts to Indian consultants only
- Accept international payments via Razorpay (settle in INR)
- No international consultant support

### Phase 2: India + US Payouts (MVP International)
- Add PayPal Business payouts for US consultants
- Simple, covers largest international segment
- Cost: ~3-5% per payout via PayPal

### Phase 3: Global Payouts (Scale)
- Integrate Wise Business API for 80+ country payouts
- Better rates than PayPal (0.5-2% vs 3-5%)
- API-driven for automation
- Or: Stripe Connect if platform entity is moved/expanded

### Phase 4: Full Stack (Enterprise)
- Stripe Connect for seamless onboarding
- Wise for corridors Stripe doesn't cover
- Automated TDS/15CA compliance
- Multi-currency consultant wallets

---

## Sources

- [Wise Business API Documentation](https://docs.wise.com/)
- [Stripe Connect Cross-Border Payouts](https://docs.stripe.com/connect/cross-border-payouts)
- [Stripe India FAQ](https://support.stripe.com/questions/india-faq)
- [Section 195 TDS Guide (ClearTax)](https://cleartax.in/s/section-195)
- [Section 195 TDS on Non-Residents (TDSMan)](https://blog.tdsman.com/2026/01/section-195-tds-on-payments-to-non-residents/)
- [Form 15CA/15CB Guide (ClearTax)](https://cleartax.in/s/filing-e-form-15ca-and-15cb)
- [India-Briefing TDS Guide for NRI Payments](https://www.india-briefing.com/news/tds-on-nri-and-foreign-company-payments-39418.html/)
- [Wise Business India Review (InfinityApp)](https://www.infinityapp.in/blog/wise-(transferwise)-india-features-benefits-and-alternatives)
- [Xflow Series A (TechCrunch)](https://techcrunch.com/2026/02/23/stripe-paypal-ventures-bet-on-indias-xflow-to-fix-cross-border-b2b-payments/)
- [Upwork Payout Methods](https://support.upwork.com/hc/en-us/articles/211060918-How-to-get-paid-on-Upwork)
- [Fiverr Payments in India (KarbonCard)](https://www.karboncard.com/blog/how-to-get-paid-on-fiverr-in-india)
- [Maven Getting Paid](https://help.maven.com/en/articles/5593804-getting-paid)
- [Outward Remittance Charges India (FinCirc)](https://fincircindia.com/outward-remittance-charges-and-service-fees/)
- [SWIFT Transfer Fees (EximPe)](https://eximpe.com/blog/banking-payments/swift-transfer-fees-and-charges)
