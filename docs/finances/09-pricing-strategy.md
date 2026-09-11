# Familiarise — Pricing Strategy

**Last updated:** 2026-04-22
**Owner:** CEO
**Status:** Living document — review monthly until Phase 2, then quarterly
**Scope:** B2C marketplace commission, B2B enterprise tier, creator premium add-ons, payment gateway routing, unit economics

---

## 1. Executive summary

Familiarise monetizes through **three revenue streams**:

1. **B2C marketplace commission** — primary (~80-90% of revenue at launch).
2. **B2B enterprise subscriptions** — secondary (~10-20% of revenue post-month-6), unlocks higher-margin ACVs.
3. **Creator premium add-ons** — tertiary, launches Phase 3 (month 10+), targets ~5-10% of revenue.

The pricing architecture has three non-negotiable principles:

1. **UPI-first in India.** Razorpay UPI fees are ~0%; creators net more than on Topmate/Preplaced (which route through Stripe + currency conversion at 15-17% effective). This is the platform's single biggest economic moat. Don't undermine it with unnecessary international routing.
2. **Minimum price floors protect the marketplace.** Sub-₹299 consultations, sub-₹199 webinars, etc. — because below these thresholds, gateway + infrastructure costs exceed the commission. Reference: `docs/finances/03-pricing-calculator.md`.
3. **B2B enterprise pricing is inverted** (sponsor pays more per seat than B2C gets per session) because sponsors bundle value: analytics, sponsorship reporting, invoice-level billing, SSO, HRIS.

Three-sentence summary:

1. **B2C:** 10% commission at launch; inverse-tiered (20%→12% by rate band) from month 10+. Minimum prices enforced server-side.
2. **B2B:** 3 tiers (Starter / Growth / Scale) with monthly/annual LICENSED_SEAT or CREDIT_POOL options; invoiced-monthly mode for enterprise.
3. **Unit economics:** break-even at ~₹1.1L GMV/month pre-Stream-cliff, ~₹3.4L GMV/month post-cliff. Plan to cross the cliff only when commission revenue justifies the infrastructure jump.

---

## 2. Revenue stream overview

| Stream | % of revenue (at launch) | % of revenue (month 12 target) | Who pays | What they get |
|---|---|---|---|---|
| B2C marketplace commission | 95% | 70% | Creators (deducted from GMV) | Platform + payment rails |
| B2B enterprise subscriptions | 5% | 25% | Enterprise orgs (direct) | Org dashboard + SSO + compliance + bulk sessions |
| Creator premium add-ons | 0% | 5% | Creators (opt-in) | Analytics, priority support, featured listing, branding |

The goal isn't to diversify for diversification's sake — it's that enterprise tier reduces GMV-dependency and creator add-ons lock in power users. The **first revenue dollar at launch is a B2C commission**. Everything else layers on.

---

## 3. Current SaaS cost baseline

Fixed-cost per month across the three stages (Stream costs from `docs/stream/00-pricing-overview.md`):

| Stage | Trigger | Monthly SaaS (with GST) | Notes |
|---|---|---|---|
| Stage 1 — Pre-launch | Today | ~₹12K | Claude Max + Apple Developer + domain; all other tools on free tiers |
| Stage 2 — Early launch | First 100 MAU | ~₹25K | Add Resend (email), Supabase Pro (when free tier exhausted) |
| Stage 3 — Growth | ₹8.5L GMV OR 5+ team OR $100K funding | ~₹67K | **Stream.io cliff** kicks in: Maker → paid tier adds ~₹36K/month |

**Critical line in the sand:** the Stream.io cliff is a step-function increase of ~5-6x in fixed costs. Plan the commission curve + enterprise tier to clear well above it before triggering.

FX assumption: ₹90.7/$1 (Feb 2026). Revisit quarterly.

---

## 4. B2C marketplace — commission model

### 4.1 Commission curve (4 phases)

Already committed in `docs/finances/01-business-model.md` and `docs/competition/04-pricing-strategy.md`. Reproduced here for convenience:

| Phase | Duration | Commission | Purpose |
|---|---|---|---|
| **Phase 0 — Founding** | 3 months (hand-picked cohort) | **0%** | Zero-friction entry for 30-50 founding creators; build loyalty + testimonials |
| **Phase 1 — Launch** | Months 1-3 of public | 10% baseline; 5% for Topmate-migrating creators | Matches Topmate headline; UPI-first makes effective rate superior |
| **Phase 2 — Growth** | Months 4-9 | 10% baseline; 8% for creators at > ₹50K/month GMV | Volume-reward kicks in at rolling 3-month average |
| **Phase 3 — Maturity** | Months 10+ | Inverse-tiered (20% → 12% by rate band) | High-volume / low-price creators pay more; high-price / low-volume creators pay less |

### 4.2 Phase 3 inverse tiering (month 10+)

| Tier | Hourly rate | Commission | Rationale |
|---|---|---|---|
| Budget | ₹299-₹999 | 20% | High volume; platform provides significant value at this price point |
| Everyday | ₹1,000-₹3,000 | 18% | Bread-and-butter; balanced |
| Premium | ₹3,000-₹10,000 | 15% | High-value transactions; retain top talent |
| Luxury | ₹10,000+ | 12% | C-suite / celebrities; flight risk; lowest commission to keep them on-platform |

**Why inverse?** Topmate and peers charge flat 10%. A C-suite creator at ₹25K/hour pays the same rate as a student consultant at ₹299. We invert: lower commission for high-price creators locks in premium supply, higher commission for budget creators captures more from high-volume low-margin bookings that stress infrastructure.

### 4.3 Minimum price floors (server-enforced)

From `docs/finances/03-pricing-calculator.md`. The schema should reject bookings below these thresholds:

| Service type | Duration | Minimum price (INR) | Platform earns (at 20%) | Creator earns | Why this floor |
|---|---|---|---|---|---|
| Consultation | 15 min | ₹299 | ₹58 | ₹183 | Below this, gateway + Stream.io costs exceed commission |
| Consultation | 30 min | ₹499 | ₹97 | ₹305 | Prevents race-to-bottom pricing |
| Consultation | 1 hour | ₹999 | ₹194 | ₹610 | Signals professional marketplace |
| Subscription | Monthly | ₹999 | ₹194 | ₹610 | Recurring revenue must justify infra |
| Webinar | Any | ₹199 | ₹39 | ₹122 | Accessible event price; covers per-session Stream.io cost |
| Class (per session) | Any | ₹399 | ₹77 | ₹244 | Multi-session requires more platform resources |
| Document review (async) | Per doc | ₹499 | ₹97 | ₹305 | Async flows still consume storage + reviewer bandwidth |
| Trial session | 15-30 min | ₹0 (free) | ₹0 | ₹0 | Conversion funnel; limited to 1 per consultee per consultant per 30 days |

**Enforcement:** these floors live in `schemas/checkout.ts` + server-side validation in the checkout route, not just client-side. A consultant cannot price below the floor even via direct API.

### 4.4 Topmate-migration discount (Phase 1 lever)

Creators who provide evidence of an active Topmate profile (screenshot + link + > 10 past bookings) get **5% commission** for the first 3 months. After 3 months, they revert to the standard tier.

**Why this works:** it's a targeted steal-from-competitor promotion. 5% vs Topmate's 15-17% effective rate = creators pocket an extra ₹750-1200 on every ₹10K booking. A creator at ₹50K/month GMV saves ~₹3,500-4,000/month in commission during the 3-month window.

**Cap:** 50 migrating creators in Phase 1 (budget: ~₹5L in foregone commission during the promo).

---

## 5. B2C — gateway routing + effective economics

### 5.1 Gateway fees (current)

| Gateway | Rail | Fee (effective with GST) | Used for |
|---|---|---|---|
| Razorpay | UPI | 0% | Indian domestic payments (default) |
| Razorpay | Card / net banking | 2% + 0.36% GST = 2.36% | Indian domestic card payments |
| Razorpay | International | 3% + 0.54% GST = 3.54% | Indian customer paying in INR, card issued abroad |
| Stripe | International | 3% + 0.54% GST = 3.54% | Non-INR payments; international-to-India remittance |

Blended effective rate across the marketplace (assuming 70% UPI, 25% cards, 5% international): **~0.8-1%**.

### 5.2 Creator net — concrete example

Creator sells a ₹10,000 consultation:

| Path | Gateway fee | Commission | Creator net | Creator net % |
|---|---|---|---|---|
| Familiarise via UPI, Phase 1 | ₹0 | ₹1,000 (10%) | ₹9,000 | 90% |
| Familiarise via card, Phase 1 | ₹236 | ₹1,000 (10%) | ₹8,764 | 87.6% |
| Topmate (Stripe international) | ~₹354 | ₹1,000 (10%) | ~₹8,646 | 86.5% (+ FX markup) |
| Topmate (with FX markup) | ~₹500-700 | ₹1,000 (10%) | ~₹8,300-8,500 | 83-85% |

**At ₹50K/month GMV via UPI on Familiarise, a creator keeps ₹45,000.** On Topmate (Stripe + FX), same GMV, they keep ~₹41,250-42,250. Differential: **₹2,750-3,750/month** (₹33K-45K/year). This is the single-biggest moat talking point.

### 5.3 Gateway consolidation (April 2026)

The April 2026 cleanup removed the two rejected gateways from the code, the UI, the webhooks and the seeds. The platform now routes exclusively through **Razorpay** for acceptance, with **Stripe** retained as a secondary rail for Connect transfers. Their labels survive in the `PaymentGateway` database enum because Postgres cannot drop an enum value in place; that residue is tracked in `prisma/sql/known-drift.json` and is what `scripts/ci/check-db-drift.ts` watches.

Rationale for the removal: two extra gateways increased integration surface area, support burden, and webhook-race complexity without a clear demand signal. Razorpay + Stripe covers > 99% of payment scenarios for the launch markets (India + cross-border).

---

## 6. B2C creator premium add-ons (Phase 3, month 10+)

These are optional subscriptions creators can purchase to accelerate their own business on-platform. Launch alongside Phase 3 commission tiering.

| Add-on | Price | Value proposition | Margin |
|---|---|---|---|
| Analytics Pro | ₹499/month | Session-level revenue + conversion analytics; cohort retention; funnel analysis | 95%+ (software-only, no marginal cost) |
| Priority Support | ₹299/month | 2-hour first-response SLA; dedicated support slack/WhatsApp | 70%+ (staffing cost) |
| Featured Listing | ₹999/month | Pinned placement on category pages; 5x search-weight boost | 95%+ (placement algorithm only) |
| Custom Branding | ₹1,499/month | Custom domain (yourname.familiarise.io); custom colors; logo on invoices | 85%+ (SSL + infra) |

**Target uptake:** 10-15% of active creators by month 18. At 500 active creators, ~50-75 paying add-on users × avg ₹800/month = **₹40-60K/month recurring**, high-margin.

---

## 7. B2B Enterprise tier (NEW — PR #682 goes live here)

This is the first time enterprise pricing is committed to a strategy doc. The schema (arch-4) already supports three billing modes — LICENSED_SEAT, CREDIT_POOL, INVOICED_MONTHLY — so pricing maps 1:1 to schema.

### 7.1 Target customer segments

| Segment | Employee count | Pain point | Our fit |
|---|---|---|---|
| Early-stage startups | 10-50 | Need to sponsor team mentorship but can't pay for expensive LMSes | LICENSED_SEAT Starter tier |
| Growth-stage tech | 50-200 | Need leadership coaching + specialist mentors, compliance-required invoice billing | LICENSED_SEAT Growth / CREDIT_POOL |
| Enterprise-scale | 200-1,000 | Need SSO, HRIS sync, audit compliance, dedicated CS | INVOICE mode with custom contract |
| Training / EdTech companies | Any | Need to provision sessions for THEIR learners (PROVIDER-org, not BUYER) | HYBRID org + custom rev-split |

### 7.2 Pricing tiers

**Three packaged tiers + a Custom tier for enterprise-scale.**

| Tier | Who it's for | Monthly price | Annual price (10% off) | Seats included | Overage |
|---|---|---|---|---|---|
| **Starter** | 10-25 employee startups | ₹24,999/month | ₹269,892/year | Up to 25 | ₹1,200/additional seat |
| **Growth** | 25-100 employee companies | ₹74,999/month | ₹809,892/year | Up to 100 | ₹900/additional seat |
| **Scale** | 100-500 employees | ₹2,49,999/month | ₹2,699,892/year | Up to 500 | ₹700/additional seat |
| **Custom (Enterprise)** | 500+ employees or special needs | Custom contract | Custom | 500+ | Negotiated |

**What's included in every tier:**

- Unlimited org dashboard access
- Up to 4 consultations per member per month (Starter), 8 per member (Growth), 12 per member (Scale) — beyond that, overage rate per consultation.
- Member invitations + SSO support
- Audit log + basic analytics
- Email support (response within 1 business day)

**Tier add-ons (a-la-carte):**

| Add-on | Price | Notes |
|---|---|---|
| SSO (SAML/OIDC) | ₹15,000/month flat | Required for Growth+ tiers typically |
| HRIS sync (Workday / BambooHR / Rippling) | ₹25,000/month | Live when feature ships (Phase 2 epic #703) |
| Dedicated CS manager | ₹50,000/month | Named person, weekly review cadence |
| Custom branding (logos + email templates) | ₹20,000 setup + ₹5,000/month | Standard at Scale tier |
| White-label domain | ₹10,000 setup + ₹2,500/month | Optional for all tiers |
| Priority 2-hour support SLA | ₹15,000/month | Replaces email support |
| Consolidated billing across subsidiaries | ₹10,000/month | Uses the parent-org rollup cron |

### 7.3 Credit pool pricing (alternative to LICENSED_SEAT)

For orgs that want variable commitment without seat caps, CREDIT_POOL is the alternative. Pricing is per-credit, volume-discounted:

| Credit block | Price/credit | Total | Expiration |
|---|---|---|---|
| 10 credits | ₹1,200 | ₹12,000 | 6 months |
| 50 credits | ₹1,000 | ₹50,000 | 9 months |
| 200 credits | ₹850 | ₹170,000 | 12 months |
| 500 credits | ₹700 | ₹350,000 | 12 months |
| 1000+ credits | ₹600 | Custom | Custom |

1 credit = 1 hour consultation (or equivalent: 2 × 30-minute consultations, 4 × 15-minute consultations).

Compared to LICENSED_SEAT, CREDIT_POOL makes sense when:

- Monthly usage is unpredictable (can't commit to seat counts).
- The org only wants to sponsor a subset of employees on-demand.
- Seasonal or project-based usage patterns.

### 7.4 Invoice-monthly (enterprise mode)

For orgs with internal procurement processes (PO-driven, net-60 payment terms), invoicing is the default. **Not a separate tier — a billing modality on top of Scale or Custom.**

- No seat cap enforcement; bookings accrue to a monthly invoice.
- Creator commission is still 10% (or tier-appropriate) deducted at booking time; the org invoice captures the gross bookings.
- Net-60 payment terms (configurable).
- Credit limit enforced server-side: if outstanding accrual > credit limit, further bookings return 409.
- GST-compliant invoices with IRN (once the uploader is live — Phase 2 epic).

### 7.5 Why these numbers?

Benchmarks used:

- **LinkedIn Learning** ₹1,400-2,500/seat/month.
- **Coursera for Business** ~₹2,700/seat/month.
- **GrowthSchool Enterprise** (per sales inquiries): ₹2,000-4,000/seat/month for cohort-based learning.
- **MentorCruise Business**: $79-199/seat/month (~₹7,200-18,000).

Our **Starter at ~₹1,000/seat/month effective** (₹25K / 25 seats) is **aggressively below market** — deliberate, to win the first 10-15 enterprise customers as design partners. Raise rates in Phase 2 once enterprise case studies + testimonials exist.

Our **Scale at ~₹500/seat/month effective** (₹2.5L / 500 seats) reflects volume discount typical of enterprise SaaS.

---

## 8. Trial sessions + free entry points

| Entry point | Free? | Purpose | Cap |
|---|---|---|---|
| B2C trial session (15-30 min) | Yes | Consultee-consultant first contact; converts to paid | 1 per consultee per consultant per 30 days |
| B2C first session discount | Optional (creator-set) | Creator's marketing lever | Creator-defined |
| Enterprise POC (limited seats, 14 days) | Yes | Let prospect test dashboard + invite 5 members | 5 seats × 14 days |
| Referral credit (consultee → new consultee) | ₹500 per signup | Viral growth | Capped at 5 referrals per consultee in first 90 days |

**Trial economics:** a free trial session costs the platform: Stream.io video minutes (free on Maker tier), audit row, CS onboarding bandwidth. Marginal cost < ₹50/trial. Target conversion rate trial → paid: **> 25%**. If < 15%, the entry flow is broken.

---

## 9. Payment terms + escrow

### 9.1 Creator payouts

- Razorpay T+2 settlement (domestic). No TDS automatically withheld (creator responsible for own filings unless > ₹50L turnover).
- International: Stripe Connect, weekly settlement (standard).
- Minimum payout threshold: ₹500 (to avoid per-transaction bank fees).

### 9.2 Refund policy

- Cancellation > 24h before session: full refund, creator earnings reversed.
- Cancellation < 24h: 50% refund to consultee, creator earns 50% (protects supply).
- No-show (consultee): no refund; creator earns full.
- No-show (creator): full refund + creator strike (3 strikes = suspension).

Enforced via the `BookingUtilization.reversedAt` + `reversalReason` fields.

### 9.3 Enterprise payment terms

- LICENSED_SEAT monthly: Razorpay recurring charge on contract anniversary.
- LICENSED_SEAT annual: full-year upfront, 10% discount.
- CREDIT_POOL: upfront per-block, volume-discounted.
- INVOICE mode: net-60 from invoice date, with credit limit.

---

## 10. Unit economics + break-even

### 10.1 Current (Stage 1, pre-launch)

```
Fixed costs (SaaS + minimal payroll): ~₹25K/month
Effective commission on ₹10K average booking: ~9% (after UPI-blend and Phase 1 discount)
Break-even GMV: ₹25,000 / 0.09 = ₹278,000/month
  → ~28 bookings at ₹10K average
  → ~3 active creators at 10 bookings/month each
```

### 10.2 Stage 2 (early launch, ~100 MAU)

```
Fixed costs: ~₹50K/month (interns + expanded SaaS)
Effective commission: ~10%
Break-even GMV: ₹500,000/month
  → 50 bookings/month at ₹10K avg, OR 500 bookings at ₹1K avg
```

### 10.3 Stage 3 (growth, post Stream-cliff)

```
Fixed costs: ~₹1.5L/month (Phase 1 team + paid SaaS)
Effective commission: 12% (Phase 2 tiering active)
Break-even GMV: ₹1,250,000/month (₹12.5L)
  → 125 bookings/month at ₹10K, OR 1,250 bookings at ₹1K
  → Needs ~50-80 active creators doing meaningful volume
```

**The critical inflection:** ₹8.5L GMV triggers the Stream.io cliff, and at Stream-cliff break-even is ₹12.5L. There's a 4-month "cliff-danger zone" between ₹8.5L-12.5L where burn runs ahead of revenue. Mitigation: stay on Maker tier longer by keeping team < 5 full-time (incl. CEO) and funding < $100K.

### 10.4 Contribution margin per booking

For a ₹10K booking via UPI in Phase 1:

| Component | Value |
|---|---|
| Gross revenue (commission) | ₹1,000 |
| Gateway fee (UPI) | ₹0 |
| Stream.io per-session (Maker) | ₹0 |
| Support cost allocation | ~₹30 (1% of bookings generate a ticket; ₹3000/ticket support cost ÷ 100) |
| Payment infra overhead | ~₹10 |
| **Contribution margin** | **~₹960 (96%)** |

For the same booking in Stage 3 post-cliff:

| Component | Value |
|---|---|
| Gross revenue (commission) | ₹1,000 |
| Stream.io paid-tier allocation (₹36K ÷ 1000 bookings/mo) | ₹36 |
| Support + infra allocation | ₹50 |
| **Contribution margin** | **~₹914 (91%)** |

Margin is resilient — the marketplace is a software business with software margins even post-cliff. The fixed-cost tail (team salaries) is what determines profitability, not per-booking COGS.

### 10.5 B2B enterprise unit economics

Starter tier (₹25K/month):

| Component | Value |
|---|---|
| Gross revenue | ₹25,000 |
| Infra cost allocation (shared SaaS + per-seat storage) | ~₹2,000 |
| Creator commission on fulfilled sessions (covered separately via standard commission) | — |
| CS overhead (~10% of a CS Lead's time per starter customer) | ~₹4,000 |
| **Contribution margin** | **~₹19,000 (76%)** |

Scale tier (₹2.5L/month):

| Component | Value |
|---|---|
| Gross revenue | ₹2,50,000 |
| Infra cost (SSO + storage + compliance) | ~₹12,000 |
| Dedicated CS (pro-rated) | ~₹50,000 |
| **Contribution margin** | **~₹1,88,000 (75%)** |

Enterprise margins hold at 70-80% before accounting for customer acquisition cost. Expect CAC to be high (₹50K-₹1L per enterprise deal — sales time + demo + onboarding), so payback is ~2-3 months at Starter, ~0.5 months at Scale.

---

## 11. Competitive positioning

| Platform | Commission | Gateway fee | Gateway UX | Notes |
|---|---|---|---|---|
| Familiarise | 10% (Phase 1) | 0% UPI / 2.4% cards | Razorpay (India-native) | Effective rate ~10-12% |
| Topmate | 10% headline | ~2.9-3% Stripe + 2-3% FX markup | Stripe (international) | Effective 15-17% for Indian creators |
| Preplaced | ~20% (subscription % via mentor) | Mentor-set | Razorpay | Subscription-first model |
| GrowthSchool | Course sales ~30-40% | Razorpay | Platform-managed | Cohort-based, not 1:1 |
| Metvy | ~15-20% | Razorpay | Varies | Smaller marketplace |

**Positioning statement:** "The Indian creator platform where you actually keep more money. 10% commission + UPI settlement + instant payouts to your bank. No currency gotchas. No Stripe surprises."

---

## 12. Pricing governance

### 12.1 Rules of the road

1. **Never change prices mid-phase without a month of notice.** Creators and enterprise customers need predictability.
2. **Grandfather existing contracts on price changes.** Enterprise customers who signed at ₹25K/month stay at ₹25K/month for their current contract term. Raise on renewal.
3. **Server-enforce all floors.** A creator cannot manually bypass minimum price via direct API call.
4. **Log every price experiment.** A/B tests on webinar price floors, trial durations, etc., must be logged in a pricing changelog so institutional memory survives team turnover.

### 12.2 Review cadence

| Cadence | Review |
|---|---|
| Monthly | Blended effective commission (are we stuck at 10%, or drifting due to tier distribution?) |
| Monthly | Gateway-mix health (UPI share should be > 60%; alert if < 50%) |
| Monthly | Stream.io Maker usage against the 2K MAU / 333K participant-minutes cap |
| Quarterly | Enterprise tier uptake — are Starter deals converting to Growth at renewal? |
| Quarterly | Refund rate (should be < 5% of GMV) |
| Quarterly | FX rate assumption (₹90.7/$1 — update if > 5% drift) |
| Annually | Full pricing-vs-competitor re-benchmark |

### 12.3 Escalation triggers

Raise prices if:

- Stream.io cliff hits and enterprise MRR is not covering the ₹36K/month delta → immediately review enterprise tier pricing.
- Blended effective commission drifts below 7% (creator tier-shifts into low-rate bands) → adjust tier thresholds.
- Gross margin on enterprise tier falls below 60% → tier pricing under-priced.

Lower prices if:

- Creator churn > 10% monthly and exit-interviews cite commission.
- Enterprise competitive losses cite "too expensive" in 3+ consecutive deals.

---

## 13. Launch pricing announcement (draft copy)

### 13.1 B2C creators

> **Familiarise launches with 10% commission — the lowest in India for 1:1 expert services.**
>
> Plus: UPI settlement via Razorpay means you don't lose 5-7% to currency conversion like on international platforms. If you make ₹50,000/month, that's ₹3,500-5,000/month staying in YOUR pocket instead of Stripe's.
>
> **Topmate migration bonus:** show us your active Topmate profile (10+ past bookings) and you pay **just 5% commission for your first 3 months.** One-time, per creator. First 50 creators only.
>
> Launch pricing guaranteed until 2026-12-31. After that, standard tiers apply (inverse-tiered by rate band — see our [pricing page]).

### 13.2 B2B enterprise

> **Familiarise for Teams — the first India-native way to sponsor learning for your people without losing half the budget to platform fees.**
>
> **Starter** — ₹25K/month, up to 25 seats. For startups who want team coaching without the LinkedIn Learning bloat.
>
> **Growth** — ₹75K/month, up to 100 seats. For Series A-B companies scaling leadership.
>
> **Scale** — ₹2.5L/month, up to 500 seats. For product + engineering orgs with structured learning budgets.
>
> **Custom** — 500+ seats or compliance-heavy environments. Includes SSO, HRIS sync, dedicated success manager, invoice billing.
>
> **Launch offer:** first 10 enterprise customers get **3 months free** + **waived SSO setup** (normally ₹15K/month).

---

## 14. Appendix

### 14.1 Sources + related docs

- `docs/finances/01-business-model.md` — commission curve + revenue model.
- `docs/finances/03-pricing-calculator.md` — minimum price floors + creator-savings math.
- `docs/stream/00-pricing-overview.md` — Stream cost baseline + cliff detail.
- `docs/competition/04-pricing-strategy.md` — competitor pricing benchmarks.
- `docs/competition/01-threat-matrix.md` — competitor threat levels.
- `HIRING_PLAN.md` — headcount growth (fixed-cost side of the model).
- External: [Topmate pricing](https://topmate.io/pricing), [Stream.io Maker](https://getstream.io/blog/maker-account/), [Stream Chat pricing](https://getstream.io/chat/pricing/), [Preplaced pricing](https://www.preplaced.in/blog/preplaced-mentorship-fees).

### 14.2 Glossary

| Term | Meaning |
|---|---|
| GMV | Gross merchandise value — total money flowing through the platform before commission. |
| Effective commission | Actual % after blending tiers, discounts, and gateway fees. |
| LICENSED_SEAT | B2B billing mode: flat per-seat/month for unlimited bookings (up to cap). |
| CREDIT_POOL | B2B billing mode: pre-paid credits, deducted per booking. |
| INVOICED_MONTHLY | B2B billing mode: post-paid with net-60 terms and credit limit. |
| Stream cliff | Step-function cost increase at the 2K MAU / 333K min Stream.io threshold. |
| Inverse tiering | Lower commission for high-priced sessions (opposite of typical flat fees). |

### 14.3 Financial scenarios

Three 12-month revenue scenarios for planning. See `docs/finances/04-profitability-analysis.md` for full detail.

| Scenario | Month-12 MRR | B2C creators | B2B customers | Team size | Burn | Profitability |
|---|---|---|---|---|---|---|
| **Bear** | ₹2L | 50 active | 3 Starter | 5 | ₹2.5L | -₹50K/mo |
| **Base** | ₹5L | 150 active | 5 Starter + 1 Growth | 7 | ₹3.5L | +₹1.5L/mo |
| **Bull** | ₹12L | 400 active | 8 Starter + 3 Growth + 1 Scale | 10 | ₹6L | +₹6L/mo |

---

_End of document. Next review: 2026-05-22 (monthly in Phase 0/1)._
