# International Payments Research

> **Research Date:** March 2026
> **Purpose:** Comprehensive research on how Indian marketplace platforms handle international payments, payouts, refunds, disputes, and tax compliance.

---

## Documents

| # | Document | Key Topic |
|---|----------|-----------|
| 01 | [TopMate Payment Infrastructure](./01-topmate-payment-infrastructure.md) | TopMate's payment stack, fees, payout methods, vulnerabilities |
| 02 | [RBI PA-CB & International Acceptance](./02-rbi-pa-cb-and-international-acceptance.md) | PA-CB license holders, FEMA compliance, IEC, export rules |
| 03 | [International Consultant Payouts](./03-international-consultant-payouts.md) | Stripe Connect, Wise, Payoneer, PayPal, wire transfers, Section 195 TDS, DTAA, Form 15CA/15CB |
| 04 | [International Refunds & Disputes](./04-international-refunds-disputes.md) | Cross-border refunds, forex loss allocation, chargebacks, dispute resolution |
| 05 | [GST/Tax Compliance International](./05-gst-tax-compliance-international.md) | Intermediary vs export classification, Finance Bill 2026 changes, GSTR-8 TCS, e-commerce operator obligations |
| 06 | [Discount Codes International](./06-discount-codes-international.md) | Currency conversion issues, fixed vs percentage discounts, best practices |
| 07 | [Competitor International Payments](./07-competitor-international-payments.md) | TopMate, Preplaced, Maven, Calendly, Superpeer analysis |
| 08 | [Should You Go International?](./08-should-you-go-international.md) | MVP approach, regulatory risks, tiered strategy, cost-benefit |

---

## Executive Summary

### Top Findings

1. **Razorpay has PA-CB license** (Dec 2025) -- Familiarise can accept international payments legally by simply enabling Razorpay international and getting an IEC (Rs 500).

2. **Finance Bill 2026 is a game-changer** -- Section 13(8)(b) deletion means even intermediary services to foreign clients are now zero-rated exports. This dramatically reduces GST risk for Familiarise's international operations.

3. **TopMate charges 16-18% effective** for international creators (hidden fees) -- Familiarise can undercut significantly with transparent pricing.

4. **International consultant payouts are the hard part** -- Accepting payments is easy (Razorpay handles it). Paying international consultants requires Section 195 analysis, 15CA/15CB forms, and PayPal/Wise integration.

5. **Tier 1 (accept international payments) is a no-brainer** -- 1 week of work, near-zero compliance cost, unlocks international revenue.

6. **Tier 2 (international payouts) should be demand-driven** -- Don't build until 5+ international consultants request it.

### Critical Action Items

| Priority | Action | Cost | Timeline |
|----------|--------|------|----------|
| P0 | Get CA opinion on e-commerce operator classification | Rs 5-10K | Before launch |
| P0 | Apply for IEC from DGFT | Rs 500 | 2 days |
| P1 | Enable Razorpay international payments | Free | 1 day |
| P1 | Update checkout for zero-rated GST on foreign currency | Already done | - |
| P2 | Add billing address verification for export qualification | Dev time | 1-2 days |
| P3 | Evaluate PayPal/Wise for international payouts | Dev time | When demand exists |

---

## Related Documents

- [International Payments Guide (Existing)](../payouts/04-international-payments.md)
- [Tax Compliance Guide (Existing)](../../finances/06-tax-compliance-india.md)
- [TopMate Competitor Analysis (Existing)](../../competition/competitors/01-topmate-io.md)
- [Multi-Currency Guardrails MVP](../../) (referenced in MEMORY.md but directory not found)
