# Stream.io — Enterprise, Maker Account & Full Plan Details

> **Verified:** April 23, 2026 via Chrome DevTools (maker-account page, enterprise page, chat pricing, moderation pricing, SLA blog post)
> **Exchange rate:** ₹90.7/$1 (Feb 2026 baseline)
> **Purpose:** Deep-dive on the Maker Account (Familiarise's current tier), the full Chat feature matrix, AI Moderation pricing, SLA plans, and the Enterprise tier roadmap.
> **Companion docs:** `STREAM_PRICING.md` (rates + permutation tables), `UPSTASH_PRICING.md`

---

## 1. Maker Account — Complete Details

### 1.1 Eligibility Requirements

All **three** conditions must hold simultaneously:

| Condition | Threshold | Familiarise status (Apr 2026) |
|-----------|-----------|-------------------------------|
| Team members | **≤ 5** | ✅ 2–3 devs |
| Total funding raised | **< $100,000** | ✅ Bootstrapped |
| Monthly revenue | **< $10,000** (~₹9.07L/mo) | ✅ Pre-launch |

> **Critical:** The funding condition is often overlooked. Taking even a small angel round of $100K+ automatically disqualifies from the Maker Account — regardless of team size or revenue. Plan accordingly before any raise.

Availability is **limited** — apply early via the Stream dashboard. Eligibility is periodically re-checked.

### 1.2 What the Maker Account Includes

| Product | Maker gets | Standard equivalent |
|---------|-----------|---------------------|
| **Chat** | Modified Start Plan — **2,000 MAU**, 100 concurrent connections, hard limits | Start Plan at 10,000 MAU |
| **Video & Audio** | Build Plan — **$100 free credit/month** | Build Plan (identical) |
| **Activity Feeds** | Start Plan (standard) | Start Plan |
| **AI Moderation** | PAYG with **$100 monthly free credit** | PAYG |

**Key Chat difference vs standard Start:** The Maker Chat plan is capped at **2,000 MAU** (not 10,000). It has **hard limits** — when you hit the ceiling the service stops rather than billing overages. This protects against surprise bills.

### 1.3 Hard Limits vs Soft Limits

| Mode | What happens at the limit |
|------|--------------------------|
| **Maker (hard limits)** | Service pauses — no overages, no surprise billing |
| **PAYG / Start (soft limits)** | Continues, bills overages ($0.09/MAU, $0.99/concurrent) |

Hard limits make Maker ideal for pre-revenue stages. Once you hit 2,000 MAU you **must upgrade** or users start getting blocked.

### 1.4 Maker → Paid Transition Triggers

The Maker Account ends the moment **any** trigger fires:

| Trigger | Effect |
|---------|--------|
| Revenue crosses $10K/month | Must upgrade immediately |
| Funding raised crosses $100K | Must upgrade immediately |
| Team size crosses 5 members | Must upgrade immediately |
| MAU crosses 2,000 (hard limit) | Service pauses, must upgrade to continue |

**Recommended action:** Switch to annual billing on the day you upgrade — saves ~20% at the 10K tier ($1,200/year vs monthly).

---

## 2. Build / PAYG Plan (Video & Audio)

The "Build" plan and "PAYG" plan are effectively the same tier. Stream markets them with different names depending on context:

| Label | Context | Difference |
|-------|---------|-----------|
| **Build** | Marketing / Maker Account | Emphasises $100 credit = 333K Audio-Only PM |
| **PAYG** | Pricing page calculator | Emphasises per-PM cost starting at $0.30/1K |

Both are the same billing model — no monthly fee, $100 credit applied automatically each month, then PAYG above that.

### 2.1 Build / PAYG Plan Details

| Feature | Value |
|---------|-------|
| Monthly minimum | $0 |
| Monthly free credit | $100 (all PAYG accounts, all quality levels) |
| Credit card required | No (to start) |
| Support | Community only |
| SLA | None (Developer tier) |
| Participant limit | No hard limit (contrast: Maker Chat = hard limits) |
| Recording | Available (PAYG, quality-dependent rate) |
| Add-ons | All available at PAYG rates |

### 2.2 Enterprise vs PAYG (Video)

| Feature | PAYG | Enterprise |
|---------|------|-----------|
| Pricing model | Per participant-minute | Volume discounts (custom) |
| Threshold | Any usage | Starting at 1M PM/month |
| SLA | None | 99.999% |
| Support | Community | 24/7 phone + Slack channel |
| SOC 2 | ✅ | ✅ |
| HIPAA | Contact Us | Available |
| Dedicated region | ❌ | ✅ (option) |
| Annual discount | None (PAYG) | Bigger than 10% (custom) |
| Response time (critical) | Best-effort | 2 hours |

---

## 3. Chat — Full Feature Matrix

All data verified April 2026 at `getstream.io/chat/pricing/` with feature sections expanded.

### 3.1 Usage Limits by Tier

| Metric | Build (Free/Maker) | Start | Elevate | Enterprise |
|--------|--------------------|-------|---------|------------|
| MAU | 1,000 (Maker: 2,000 hard) | 10,000 | 10,000 | 1,000,000+ |
| MAU overage | — | $0.09/user | $0.09/user | Custom |
| Concurrent connections | 100 | 500 | 500 | 750,000+ |
| Concurrent overage | — | $0.99/concurrent | $0.99/concurrent | Custom |
| Message storage | Limited | Up to 2.5M | Up to 2.5M | Custom |
| Message overage | — | $0.000015/msg | $0.000015/msg | Custom |
| Channels | Limited | Up to 250K | Up to 250K | Custom |
| Channel overage | — | $0.0012/channel | $0.0012/channel | Custom |
| CDN Bandwidth | — | $0.17/GB | $0.17/GB | $0.17/GB |
| CDN Storage | — | $0.07/GB | $0.07/GB | $0.07/GB |
| Monthly resized images | — | $5.80/1K images | $5.80/1K images | $5.80/1K images |
| Campaigns | — | 30K msgs/mo incl. | 30K msgs/mo incl. | Custom |

> **At 50K MAU (Start):** message storage scales to 10M, channels to 1M, overage drops to $0.07/user and $0.79/concurrent.

### 3.2 Messaging Features

| Feature | Build | Start | Elevate | Enterprise |
|---------|-------|-------|---------|------------|
| 1:1 Direct Messaging | ✅ | ✅ | ✅ | ✅ |
| Group Chat Channels | ✅ | ✅ | ✅ | ✅ |
| Channels for Unlimited Scale | ✅ | ✅ | ✅ | ✅ |
| Message Reactions | ✅ | ✅ | ✅ | ✅ |
| Thread Replies | ✅ | ✅ | ✅ | ✅ |
| Auto Message Translation | — | $2.00/1K | $2.00/1K | Custom |
| Message Reminders | ✅ | ✅ | ✅ | ✅ |
| App Interface Localization | ✅ | ✅ | ✅ | ✅ |
| Offline Support | ✅ | ✅ | ✅ | ✅ |
| Push Notifications | ✅ | ✅ | ✅ | ✅ |
| URL Enrichment | ✅ | ✅ | ✅ | ✅ |
| User Presence | ✅ | ✅ | ✅ | ✅ |
| Slash Commands | ✅ | ✅ | ✅ | ✅ |
| Silent Messages | ✅ | ✅ | ✅ | ✅ |
| Unread Messages Count | ✅ | ✅ | ✅ | ✅ |
| Media Attachment & Resizing | ✅ | ✅ | ✅ | ✅ |
| @Mentions | ✅ | ✅ | ✅ | ✅ |
| Read Receipts | ✅ | ✅ | ✅ | ✅ |
| Typing Indicator | ✅ | ✅ | ✅ | ✅ |
| Message History | ✅ | ✅ | ✅ | ✅ |
| Custom Messages | ✅ | ✅ | ✅ | ✅ |
| Giphy Integration | ✅ | ✅ | ✅ | ✅ |
| Polls | ✅ | ✅ | ✅ | ✅ |
| Campaigns | — | 30K incl. | 30K incl. | Custom |

### 3.3 Moderation Features

| Feature | Build | Start | Elevate | Enterprise |
|---------|-------|-------|---------|------------|
| Moderation Dashboard | — | ✅ | ✅ | ✅ |
| Moderator User Roles | — | ✅ | ✅ | ✅ |
| Message Flagging | — | ✅ | ✅ | ✅ |
| Profanity Filter & Block List | — | ✅ | ✅ | ✅ |
| Pre-Send Message Hooks | — | ✅ | ✅ | ✅ |
| Mute, Ban & Block Users | — | ✅ | ✅ | ✅ |
| Commercial Spam AI | — | Add-on | Add-on | Add-on |
| Platform Circumvention AI | — | Add-on | Add-on | Add-on |
| Semantic Filters AI | — | Add-on | Add-on | Add-on |
| AI Image Moderation | — | Add-on | Add-on | Add-on |

### 3.4 Developer Experience (all tiers)

| Feature | Build | Start | Elevate | Enterprise |
|---------|-------|-------|---------|------------|
| SDKs for Leading Frameworks | ✅ | ✅ | ✅ | ✅ |
| Developer Dashboard | ✅ | ✅ | ✅ | ✅ |
| Documentation | ✅ | ✅ | ✅ | ✅ |
| UI Kits | ✅ | ✅ | ✅ | ✅ |
| Tutorials | ✅ | ✅ | ✅ | ✅ |

### 3.5 Platform & Infrastructure

| Feature | Build | Start | Elevate | Enterprise |
|---------|-------|-------|---------|------------|
| Global Edge Network | ✅ | ✅ | ✅ | ✅ |
| Global Fast Response (~9ms) | ✅ | ✅ | ✅ | ✅ |
| Webhooks Integration | ✅ | ✅ | ✅ | ✅ |
| Multi-Tenancy / Teams | — | — | ✅ | ✅ |
| Unlimited Participants | ✅ | ✅ | ✅ | ✅ |
| 2FA | ✅ | ✅ | ✅ | ✅ |
| SAML / SSO | — | — | — | ✅ |
| Datadog Integration | — | Add-on | Add-on | Add-on |
| 99.999% Uptime SLA | — | Add-on | Add-on | Add-on |
| Dedicated Region Stack | — | — | — | Add-on |
| Advanced Search | — | — | ✅ | ✅ |

### 3.6 Security & Compliance

| Feature | Build | Start | Elevate | Enterprise |
|---------|-------|-------|---------|------------|
| ISO 27001 | ✅ | ✅ | ✅ | ✅ |
| SOC 2 | ✅ | ✅ | ✅ | ✅ |
| GDPR & CCPA | ✅ | ✅ | ✅ | ✅ |
| HIPAA | — | — | ✅ | ✅ |

### 3.7 Support Tiers

| Feature | Build | Start | Elevate | Enterprise |
|---------|-------|-------|---------|------------|
| Community Support | ✅ | ✅ | ✅ | ✅ |
| Troubleshooting Portal | ✅ | ✅ | ✅ | ✅ |
| Ticketed Support (avg 30 min) | — | ✅ | ✅ | ✅ |
| Pre-Sale Premium Support | — | Add-on | Add-on | ✅ |
| Engineer Slack Channel | — | Add-on | Add-on | ✅ |
| 24/7 Emergency Phone | — | Add-on | Add-on | ✅ |

---

## 4. SLA Plans

Three tiers, applying across all Stream products (Chat, Video, Feeds, Moderation).

### 4.1 Enterprise SLA — 99.999% Uptime

> Designed for the most demanding production use cases.

| Dimension | Detail |
|-----------|--------|
| Uptime guarantee | **99.999%** |
| Credit acceleration | **100×** (7 min downtime = 700 min credit) |
| Max credit cap | Up to 30% of monthly bill |
| Critical issue response | **2 hours** (24/7) |
| Non-critical response | 48 hours |
| Support channels | Phone (24/7) + dedicated Slack channel |
| Global coverage | USA, Europe, Asia team members |
| Integration review | ✅ Included |
| Pricing | Custom (part of Enterprise contract) |

**99.999% = ~5.26 minutes downtime allowed per year.**  
**With 100× acceleration:** every minute of downtime = 100 minutes credit — strong incentive for Stream to maintain availability.

### 4.2 Business SLA — 99.95% Uptime

> For rapidly growing companies needing priority queuing.

| Dimension | Detail |
|-----------|--------|
| Uptime guarantee | **99.95%** |
| Credit acceleration | **25×** |
| Max credit cap | Up to 30% of monthly bill |
| Critical issue response | **4 hours** |
| Non-critical response | 72 hours |
| Support channels | Shared Slack channel |
| Pricing | Custom add-on |

**99.95% = ~4.38 hours downtime allowed per year.**

### 4.3 Developer Plan — No SLA

> For smaller apps, Build/PAYG tier.

| Dimension | Detail |
|-----------|--------|
| Uptime guarantee | None (same infrastructure, no contractual SLA) |
| Average ticket response | ~30 minutes |
| Support channels | Ticketed support portal |
| Reliability reference | `status.getstream.io` (public status page) |

Stream's actual reliability track record is publicly visible at the status page and has historically been excellent — the Developer plan is a contractual distinction, not an infrastructure one.

---

## 5. AI Moderation Pricing

### 5.1 Plans

| Plan | Monthly cost | Includes | Moderators |
|------|-------------|---------|-----------|
| **Build (Free)** | $0 ($100 credit) | $100/mo credit toward PAYG rates | 3 |
| **PAYG** | Usage-based | 40 AI harm engines, semantic filtering, dashboard | 3 |
| **Enterprise** | Custom (annual) | Everything + LLM review layer, discounted rates, SAML/SSO, 99.999% SLA | Unlimited |

### 5.2 PAYG Rates

| Content type | Rate | ₹ equivalent |
|-------------|------|-------------|
| Messages | $2.00 per 1,000 | ₹181/1K |
| Images | $4.00 per 1,000 | ₹363/1K |
| Video file (recorded) | $0.80 per minute | ₹73/min |
| Live video | $4.00 per 1,000 frames | ₹363/1K frames |

**$100 credit = approx:**
- 50,000 moderated messages, or
- 25,000 moderated images, or
- 125 minutes of recorded video moderation, or
- Any mix of the above

### 5.3 AI Harm Engines Included (PAYG+)

40 engines covering:
- Commercial spam detection
- Platform circumvention detection
- Semantic content filtering
- AI image moderation
- NLP engine
- Rule Builder
- Blocklist / Regex matching
- Facial recognition
- OCR (text in images)

Enterprise adds: **LLM review layer** (large language model secondary review on flagged content for higher accuracy).

### 5.4 Familiarise AI Moderation Path

At pre-launch, AI Moderation is included via the Maker Account ($100 PAYG credit). At current estimated volume (early consultations, low message volume), the $100 credit covers all AI moderation costs through early traction.

**When to consider paid AI Moderation:** When message volume exceeds 50,000/month (exhausts the $100 credit) or when regulatory/compliance requirements need the full 40-engine suite without credit constraints.

---

## 6. Auto Message Translation

Available on all paid Chat plans (Start, Elevate, Enterprise).

| Metric | Rate |
|--------|------|
| Per 1,000 translations | **$2.00** (₹181) |

**Familiarise use case:** Relevant when expanding beyond English-speaking consultants/consultees. Not needed at launch — defer until international expansion.

**Example:** 1,000 messages/day × 30 days × 20% needing translation = 6,000 translations/month = $12.00/month.

---

## 7. Enterprise Plan — All Products Summary

Enterprise applies per-product. You can be on Enterprise Video + PAYG Chat, or any combination.

### 7.1 Enterprise Video & Audio

| Aspect | Detail |
|--------|--------|
| Minimum scale | Starting at **1M participant-minutes/month** |
| Pricing | Custom — volume discounts larger than 10% annual |
| SLA | 99.999% uptime included |
| Support | 24/7 phone + Slack channel |
| Compliance | SOC 2, HIPAA available, ISO 27001 |
| Infrastructure | Dedicated AWS region stack option |
| Additional | 5M+ concurrent connections capacity, ~9ms API response |

At **HD 30fps ($1.50/1K PM)**, 1M PM/month = $1,500/month PAYG. Enterprise pricing kicks in at this scale and provides volume discounts — the exact breakpoint for savings depends on negotiated rate.

### 7.2 Enterprise Chat

| Aspect | Detail |
|--------|--------|
| MAU | 1,000,000+ (scales to hundreds of millions) |
| Concurrent | 750,000+ included, custom overage |
| SLA | 99.999% add-on |
| Support | 24/7 phone, dedicated Slack, shared engineering team |
| Compliance | HIPAA, SOC 2, ISO 27001, GDPR/CCPA |
| Features | SAML/SSO, Dedicated Region, Datadog, AI Moderation, Audit Logs |
| Pricing | Custom annual contract |

### 7.3 Enterprise Feeds

| Aspect | Detail |
|--------|--------|
| Scale | 100M+ users, activity-based pricing model |
| SLA | 99.999% |
| Features | SAML/SSO, Private Dedicated Servers, 24/7 support, Migration Guarantee |

### 7.4 Enterprise Package Options (À la carte add-ons)

These can be added to non-Enterprise plans as upgrades:

| Add-on | Applies to | Notes |
|--------|-----------|-------|
| 99.999% SLA | Chat, Video, Feeds | Includes credit acceleration |
| Dedicated Region Stack | Chat | Custom AWS region deployment |
| Datadog Integration | Chat | Monitoring/observability |
| Engineer Slack Channel | Chat | Direct access to engineering team |
| 24/7 Emergency Phone | All | Critical issue escalation |
| Pre-Sale Premium Support | All | White-glove onboarding |
| AI Moderation (full suite) | Chat | LLM layer + unlimited moderators |
| HIPAA Compliance | Video | Contact for pricing |
| Onboarding Services | All | Integration review and setup |
| SSO / SAML / 2FA | Chat | Enterprise auth |
| Audit Logs | Chat | Security audit trail |

---

## 8. Familiarise Tier Roadmap

### 8.1 Current (Maker)

| Product | Tier | Monthly cost |
|---------|------|-------------|
| Chat | Maker (modified Start — 2K MAU hard limit) | $0 |
| Video & Audio | Build ($100 credit) | $0 |
| Activity Feeds | Start Plan | $0 |
| AI Moderation | PAYG ($100 credit) | $0 |
| **Total** | | **$0** |

### 8.2 Post-Maker (first upgrade, annual billing)

Triggered by: revenue > ₹9.07L/mo OR team > 4 OR funding > $100K OR MAU > 2K.

| Product | Tier | Monthly cost (annual) | INR/mo |
|---------|------|----------------------|--------|
| Chat | Start 10K | $399 | ₹36,189 |
| Video & Audio | PAYG (above $100 credit) | ~$80–180 | ₹7K–16K |
| Activity Feeds | Start (if needed) | $499 | ₹45,269 |
| AI Moderation | PAYG (above $100 credit) | ~$0–20 | ₹0–1,814 |
| **Total (Chat + Video only)** | | **~$479–579** | **~₹43K–53K** |

### 8.3 Growth Stage (10K–25K MAU)

| Product | Tier | Monthly cost (annual) | INR/mo |
|---------|------|----------------------|--------|
| Chat | Start 25K | $1,049 | ₹95,144 |
| Video & Audio | PAYG | ~$500–800 | ₹45K–73K |
| **Total** | | **~$1,549–1,849** | **~₹140K–168K** |

### 8.4 Elevate Upgrade Decision (Chat)

Upgrade from Start → Elevate when **any** of these are needed:
- **HIPAA compliance** (healthcare consultants handling PHI)
- **Multi-Tenancy / Teams** (enterprise clients needing isolated workspaces)
- **Advanced Search** (message search across large history)
- **Message Translations** (international user base)

At 10K MAU: Start = $399/mo → Elevate = $599/mo (adds $200/mo = ₹18,140 extra).  
At 25K MAU: Start = $1,049/mo → Elevate = $1,299/mo (adds $250/mo = ₹22,675 extra).

### 8.5 Enterprise Trigger Points

| Signal | Recommended action |
|--------|--------------------|
| MAU approaching 1M+ | Contact Stream sales for custom pricing |
| Video PM approaching 1M/month | Contact for volume discount negotiation |
| Regulatory: HIPAA + SOC 2 + SLA required | Purchase 99.999% SLA add-on or upgrade to Enterprise |
| Enterprise B2B clients requiring SLA | Negotiate Enterprise contract |
| Shared Slack channel needed for ops | Add-on or Enterprise Chat |

---

## 9. Key Facts for Investor / Financial Discussions

| Fact | Detail |
|------|--------|
| Maker free tier threshold (revenue) | $10,000/month (~₹9.07L) |
| Maker free tier threshold (funding) | $100,000 raised |
| Maker free tier threshold (team) | 5 members |
| First paid Chat tier (annual) | $399/month = $4,788/year |
| First paid Chat tier (monthly) | $499/month = $5,988/year |
| Stream.io GMV cliff (Maker exit) | ~₹9.07L monthly revenue = ~₹1.09Cr annual run rate |
| Video cost at 1K bookings/month HD | ~$80/month above free credit |
| Enterprise SLA credit acceleration | 100× (7 min downtime → 700 min credit) |
| Concurrent users at Enterprise Chat | 750,000+ included |
| Stream end users globally | 1B+ (scale reference) |

---

## Related Documents

- `STREAM_PRICING.md` — Full rate tables, permutation tables for Video, Chat, Feeds
- `UPSTASH_PRICING.md` — Upstash Redis, QStash, Vector, Workflow pricing
- `docs/finances/11-cfo-master-plan.md` — Full financial plan
- `docs/stream/00-pricing-overview.md` — Stream pricing overview and cost cliff summary
- Screenshots: `docs/stream-maker-account-apr2026.png`, `docs/stream-enterprise-apr2026.png`, `docs/stream-ai-moderation-pricing-apr2026.png`
