# RBI PA-CB License & International Payment Acceptance

> **Research Date:** March 2026
> **Status:** Current as of March 2026

> **Status: dated research, not current guidance.** Written March 2026 and kept
> for the regulatory groundwork it records, which is still useful. Its gateway
> shortlist is not: **XFlow was evaluated and rejected** (it is cross-border B2B
> settlement infrastructure, not a payment gateway) and removed from the
> codebase in #984, and Lemon Squeezy was rejected for prohibiting services in
> its ToS. Neither is a current option. The live rails are Razorpay (primary,
> INR settlement) and Stripe (the request→approve booking path). See
> [../gateways/README.md](../gateways/README.md) for what is actually wired.

---

## 1. What is PA-CB?

**Payment Aggregator -- Cross Border (PA-CB)** is an RBI-mandated license for entities facilitating cross-border online payments for import/export of goods and services in India.

- **Issued under:** RBI circular dated October 31, 2023
- **Consolidated:** September 15, 2025 Master Direction unified PA-Online, PA-Physical, and PA-Cross Border into one framework
- **Categories:**
  - PA-CB Inward (export payments -- money coming into India)
  - PA-CB Outward (import payments -- money going out of India)
  - PA-CB Inward + Outward (both directions)

---

## 2. Capital Requirements

| Requirement         | Amount        | Deadline         |
| ------------------- | ------------- | ---------------- |
| Minimum net worth   | Rs 15 crore   | At application   |
| Growth requirement  | Rs 25 crore   | By March 31, 2026|
| Transaction limit   | Rs 25 lakh    | Per transaction  |

**This means:** PA-CB is for payment aggregators (like Razorpay), NOT for merchants (like Familiarise). Merchants use licensed PA-CB providers.

---

## 3. Licensed Entities (as of March 2026)

### Wave 1 (Mid-2024)
| Entity           | Date            | Type              |
| ---------------- | --------------- | ----------------- |
| Cashfree         | July 2024       | First ever PA-CB  |
| Amazon Pay India | Sep-Oct 2024    | Inward + Outward  |
| BillDesk         | Sep-Oct 2024    | Inward + Outward  |
| Adyen            | Sep-Oct 2024    | Inward + Outward  |

### Wave 2 (Mid-2025)
| Entity                  | Date       | Type              |
| ----------------------- | ---------- | ----------------- |
| Pay10 Services          | Mid-2025   | -                 |
| Worldline ePayments     | Mid-2025   | Exports + Imports |
| PayPal (in-principle)   | May 2025   | Exports only      |

### Wave 3 (Nov-Dec 2025)
| Entity           | Date             | Type              |
| ---------------- | ---------------- | ----------------- |
| PayGlocal        | Nov 18, 2025     | Inward + Outward  |
| Pine Labs        | Late Nov 2025    | Full stack        |
| Easebuzz         | Late Nov 2025    | -                 |
| PayU Payments    | Late Nov 2025    | Full stack        |
| Airpay           | Late Nov 2025    | -                 |
| **Razorpay**     | **Dec 2, 2025**  | **Full stack (PA-O + PA-P + PA-CB)** |
| Paytm            | Dec 17, 2025     | Online + Offline + CB |
| Mswipe           | Dec 2025         | -                 |

### Wave 4 (Jan-Feb 2026)
| Entity           | Date             | Type              |
| ---------------- | ---------------- | ----------------- |
| Skydo            | Jan 9, 2026      | -                 |
| BriskPe          | Jan 2026         | -                 |
| Unlimit          | Jan 2026         | -                 |
| Payoneer (in-principle) | Jan 22, 2026 | -              |
| Xflow            | By Feb 2026      | PA-CB authorized  |

**Total: ~25 entities authorized by March 2026.**

---

## 4. What This Means for Familiarise

### You DON'T Need a PA-CB License

PA-CB is for **payment aggregators**, not merchants. As a merchant/platform, you need to:
1. Use a **licensed PA-CB provider** (Razorpay already has it since Dec 2025)
2. Enable international payments on your Razorpay dashboard
3. Comply with FEMA documentation requirements

### Razorpay's PA-CB Capabilities for You

Since Razorpay holds all three RBI licenses (PA-O, PA-P, PA-CB):
- Accept payments in 130+ currencies
- Auto-converts to INR settlement
- Auto-generates FIRA/eFIRC for FEMA compliance
- Handles RBI purpose code mapping
- 95% success rate on international transactions
- 3% + GST fee for international transactions

### Requirements to Enable International on Razorpay

1. **IEC (Import Export Code)** from DGFT -- can apply online
2. **Business PAN** (or personal PAN for sole prop)
3. **Bank account** for INR settlements
4. **Website with clear refund/cancellation policy**
5. Enable international payments in Razorpay Dashboard

---

## 5. FEMA Compliance for Service Exports

### Key Rules

| Rule                        | Requirement                                           |
| --------------------------- | ----------------------------------------------------- |
| Repatriation                | Export proceeds must be repatriated within 9-12 months |
| Purpose codes               | Use correct code for service exports                  |
| Documentation               | FIRC for amounts >$25,000                             |
| Invoice                     | Must invoice each transaction                         |
| Service agreement           | Should have terms of service                          |

### Razorpay Auto-Compliance Features

- Auto-generates FIRA (Foreign Inward Remittance Advice)
- Auto-generates eFIRC for eligible transactions
- Handles RBI purpose code mapping
- Full audit trail with conversion rates for GST filing

### IEC (Import Export Code)

- **Required for:** Accepting international payments via Razorpay/Stripe
- **Cost:** Rs 500 (government fee)
- **Processing:** 1-2 days online via DGFT portal
- **Validity:** Lifetime (no renewal needed)
- **Apply at:** https://www.dgft.gov.in

---

## 6. Export of Services -- GST Treatment

Export of services is **zero-rated** under GST (IGST Act Section 16). Conditions:
1. Supplier located in India
2. Recipient located **outside** India
3. Payment received in **convertible foreign exchange**
4. Supplier and recipient are **not establishments of the same person**

**Current implementation in Familiarise:** GST is zero-rated when `currency !== "INR"` in checkout. For full compliance, add billing address verification.

---

## Sources

- [19 Firms Got RBI's PA-CB License (Winvesta)](https://www.winvesta.in/blog/businesses/19-firms-got-rbis-pa-cb-license-who-won-and-why)
- [Razorpay PA-CB License Announcement](https://razorpay.com/blog/razorpay-rbi-cross-border-licence-global-payments/)
- [Razorpay International Payments Docs](https://razorpay.com/docs/payments/international-payments/)
- [Cashfree First PA-CB License (Inc42)](https://inc42.com/buzz/cashfree-becomes-first-entity-to-get-cross-border-pa-licence-from-rbi/)
- [PayU PA-CB Approval (MediaNama)](https://www.medianama.com/2025/11/223-payu-rbi-approval-cross-border-payment-aggregator/)
- [RBI Consolidated PA Directions (Sep 2025)](https://www.fidcindia.org.in/wp-content/uploads/2025/09/RBI-PAYMENT-AGGREGATORS-DIRECTIONS-15-09-25.pdf)
- [PwC Cross-Border PA Analysis](https://www.pwc.in/industries/financial-services/fintech/payments/cross-border-payment-aggregators-regulations-and-business-use-cases.html)
- [Razorpay International Payment Gateway Guide (2026)](https://razorpay.com/blog/what-is-a-international-payment-gateway/)
- [Worldline India How Businesses Accept International Payments](https://worldline.com/en-in/home/main-navigation/resources/blogs/2025/december-2025/how-indian-businesses-accept-international-payments-seamlessly)
- [Skydo Inward Remittance Compliance Guide](https://www.skydo.com/blog/compliance-guideline-for-inward-remittance)
