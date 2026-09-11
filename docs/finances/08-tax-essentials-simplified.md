# Tax Essentials — Simplified Guide

> Beginner-friendly explanation of GST, TDS, and compliance for technical founders with zero finance background. For comprehensive technical references, see [06-tax-compliance-india.md](./06-tax-compliance-india.md) and [07-tax-compliance-marketplace-obligations.md](./07-tax-compliance-marketplace-obligations.md).

**Last Updated**: March 2026

---

## Part 1: GST (Goods and Services Tax)

### What Is GST?

GST is a tax the **buyer** pays, but **you collect** and forward to the government. You are a tax collector, not a taxpayer.

When a consultee pays Rs 1,180 for a session:

| Item | Amount |
|------|--------|
| Actual service price | Rs 1,000 |
| GST (18%) | Rs 180 |

That Rs 180 was **never your money**. You hold it temporarily and send it to the government.

**Rate for your services: always 18%.**

### CGST vs SGST vs IGST — Do I Need to Worry?

**No, not in your code.** The total is always 18%. The split determines which government gets the money:

| Scenario | Split | Total |
|----------|-------|-------|
| Same state (both in Karnataka) | 9% CGST + 9% SGST | 18% |
| Different states | 18% IGST | 18% |
| International buyer | 0% (zero-rated export) | 0% |

Your accounting software (Zoho Invoice, ClearTax) handles the split based on billing addresses. **Your code just needs: domestic = 18%, international = 0%.** That's already built.

### When Does GST Registration Become Mandatory?

For normal businesses: when turnover crosses Rs 20 lakh/year.

**But for marketplaces:** E-commerce operators must register regardless of turnover. Since you collect payments on behalf of consultants, you're likely classified as an e-commerce operator.

> **The single most important question to ask your CA before launch:**
> "Are we an e-commerce operator under Section 2(45) of the CGST Act?"

- **If YES:** GST registration from Day 1, TCS obligations, monthly GSTR-8 filing
- **If NO:** GST registration only after Rs 20 lakh, simpler compliance

### GST on International Transactions

Export of services = **zero-rated** (0% GST).

This is not the same as "exempt." Zero-rated means:
- You charge 0% to international buyers (good)
- You can still claim Input Tax Credit on your expenses (also good)
- You can even get refunds of accumulated ITC from exports (great)

**Conditions for export of services** (all must be met):
1. You are in India
2. Buyer is outside India
3. Payment received in foreign currency (not INR)
4. You and buyer are not the same entity
5. Place of supply is outside India

**Finance Bill 2026 — game changer:** Section 13(8)(b) of IGST Act has been deleted. Even if you're classified as an "intermediary" (someone who connects consultants with buyers), international services are now zero-rated regardless. This eliminates the biggest tax risk for Indian marketplaces.

### What Is LUT?

**Letter of Undertaking.** A simple form filed on the GST portal that says: "I promise to meet export conditions, so let me skip paying GST upfront on exports."

| Scenario | Effect |
|----------|--------|
| Without LUT | You pay 18% IGST on exports, then wait months for a refund |
| With LUT | You pay 0% from the start — no cash lockup |

File it before your first international transaction. No fee. Valid one year.

### Input Tax Credit (ITC)

When you pay GST on business expenses (hosting, SaaS tools), you deduct that from the GST you collected:

| Item | Amount |
|------|--------|
| GST collected from customers | Rs 18,000/month |
| GST paid on expenses | Rs 5,000/month |
| **Net GST you owe government** | **Rs 13,000/month** |

For foreign SaaS tools (Claude, Supabase, Stream.io): you must pay 18% IGST under Reverse Charge Mechanism, but you claim it back as ITC. It's a cash flow timing issue, not an actual cost.

### GST TCS (Tax Collected at Source) — Section 52

If you're an e-commerce operator, you must collect TCS from consultants:

| Parameter | Value |
|-----------|-------|
| Rate | 0.5% on net value of taxable supplies |
| Split | 0.25% CGST + 0.25% SGST (or 0.5% IGST) |
| Threshold | None — applies from the first rupee |

**Example:**

| Item | Amount |
|------|--------|
| Consultee pays | Rs 1,000 |
| Platform commission (10%) | Rs 100 |
| Consultant share | Rs 900 |
| TCS @ 0.5% | Rs 5 |
| Consultant receives | Rs 895 |

TCS is **not** an additional tax on the consultant. It's a prepayment that they claim back when filing their own returns.

You must file GSTR-8 monthly by the 10th of the following month.

### Refunds and GST

When you refund a payment, the GST gets reversed too. You issue a "credit note" (opposite of an invoice):

| Step | Amount |
|------|--------|
| Original | Rs 1,000 + Rs 180 GST = Rs 1,180 |
| Refund credit note | Rs 1,180 |

Rs 180 is subtracted from your GST liability that month. Your refund system already works — you just need your accounting software to generate the credit note. This is accounting setup, not code.

---

## Part 2: TDS (Tax Deducted at Source)

### What Is TDS?

When **you** pay someone (a consultant), you deduct a portion of that payment and send it directly to the government on their behalf. The consultant gets credit for this when filing their income tax return.

Think of it like this: the government doesn't trust everyone to pay their taxes, so they make the **payer** collect a portion upfront.

### Which Section Applies to Us?

| Section | Rate | Threshold | Description |
|---------|------|-----------|-------------|
| **194J** | 10% (with PAN) / 20% (without PAN) | Rs 50,000/year per consultant | Payments for professional/technical services — **this is what our code implements** |
| **194-O** | 0.1% (with PAN) / 5% (without PAN) | Rs 5 lakh/year per participant | E-commerce operator paying participants — **may also apply** |

**Your CA needs to confirm** which section (or both) applies.

### How It Works in Practice

Consultant's annual earnings: Rs 1,00,000. TDS threshold under 194J: Rs 50,000.

| Month | Earnings | Cumulative | TDS |
|-------|----------|-----------|-----|
| Month 1 | Rs 10,000 | Rs 10,000 | None |
| Month 2 | Rs 8,000 | Rs 18,000 | None |
| Month 3 | Rs 12,000 | Rs 30,000 | None |
| Month 4 | Rs 15,000 | Rs 45,000 | None |
| Month 5 | Rs 12,000 | Rs 57,000 | **Rs 700** (10% of Rs 7,000 excess) |
| Month 6 | Rs 10,000 | Rs 67,000 | **Rs 1,000** (10% of full amount) |

Once the threshold is crossed, TDS applies on all subsequent payments.

### Will TDS Matter at Launch?

**No.** TDS kicks in at Rs 50,000/consultant/year. With the 80/20 split, a consultant needs Rs 62,500 in total sales to cross the threshold. At typical rates of Rs 500–2,000 per session, that's 31–125 bookings from one consultant. For a pre-launch startup, this could take months.

The code handles it gracefully: below threshold, `calculateTDS()` returns `tdsAmount = 0`. Nothing happens. No consultant even notices.

### What Our Code Does

1. Tracks cumulative payouts per consultant per financial year (April–March)
2. Checks if PAN is verified (10% rate) or not (20% rate)
3. Calculates TDS only on the excess above threshold (first time crossing)
4. Deducts TDS before sending payout to gateway
5. Creates `TDSRecord` only after gateway confirms payout (COMPLETED webhook)
6. Reverses TDS if refund happens after payout (negative reversal record)
7. Blocks non-resident consultants (Section 195 not implemented)
8. Persists financial year on Payout to prevent FY-boundary drift

### TDS Compliance Calendar

| Due Date | Action | Form |
|----------|--------|------|
| 7th of each month | Deposit TDS to government | Challan 281 |
| July 31 | Q1 return (Apr–Jun) | Form 26Q |
| October 31 | Q2 return (Jul–Sep) | Form 26Q |
| January 31 | Q3 return (Oct–Dec) | Form 26Q |
| May 31 | Q4 return (Jan–Mar) | Form 26Q |
| Quarterly | Issue TDS certificates to consultants — within 15 days of quarterly return due date (Aug 15, Nov 15, Feb 15, Jun 15) | Form 16A |

Your CA handles all of this. Your code provides the data via `GET /api/admin/tds?view=form26q` (decrypts PAN, shows all records).

---

## Related Documentation

- [06-tax-compliance-india.md](./06-tax-compliance-india.md) — Comprehensive tax compliance guide
- [07-tax-compliance-marketplace-obligations.md](./07-tax-compliance-marketplace-obligations.md) — Marketplace-specific obligations
- [Multi-Currency Architecture](../payments/multi-currency/) — IBT, gateway auto-routing, TDS implementation
