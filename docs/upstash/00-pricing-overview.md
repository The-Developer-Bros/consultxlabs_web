# Upstash Pricing — Familiarise Reference

> **Verified:** April 23, 2026 via Chrome DevTools live page interaction
> **Exchange rate:** ₹90.7/$1 (Feb 2026 baseline — adjust for current rate)
> **Current status:** Free tier on Redis and QStash. Both well within free limits through Year 1.
> **Products used:** Redis (rate limiting, distributed locks, maintenance mode), QStash (cron jobs / scheduled tasks)
> **Products not yet used:** Vector DB, Workflow

---

## 1. Redis Pricing

Redis is the primary Upstash product in use. Familiarise uses it for:
- **Rate limiting** — 11 edge/handler limiters (auth, search, checkout, etc.)
- **Distributed locks** — payouts, approval-payments, appointment allocation
- **Maintenance mode** — cached flag checked by every middleware invocation

### 1.1 Redis Plans — Complete Table

All prices verified April 2026 from `upstash.com/pricing/redis` (combobox swept for all fixed sizes).

| Plan | Monthly cost | Monthly cost (₹) | Data size | Monthly bandwidth | Read region add-on |
|------|-------------|-----------------|-----------|------------------|--------------------|
| **Free** | $0 | ₹0 | 256 MB | 50 GB | — |
| **Pay as you go** | $0.20/100K cmds | Variable | 100 GB | Unlimited | +$5/region |
| **Fixed 250MB** | $10 | ₹907 | 250 MB | 50 GB | +$5/region |
| **Fixed 1GB** | $20 | ₹1,814 | 1 GB | 100 GB | +$10/region |
| **Fixed 5GB** | $100 | ₹9,070 | 5 GB | 500 GB | +$50/region |
| **Fixed 10GB** | $200 | ₹18,140 | 10 GB | 1 TB | +$100/region |
| **Fixed 50GB** | $400 | ₹36,280 | 50 GB | 5 TB | +$200/region |
| **Fixed 100GB** | $800 | ₹72,560 | 100 GB | 10 TB | +$400/region |
| **Fixed 500GB** | $1,500 | ₹136,050 | 500 GB | 20 TB | +$750/region |
| **Enterprise** | Custom | — | Unlimited | Unlimited | Custom |

**Read region cost = 50% of plan monthly cost per region** (pattern confirmed across all tiers).  
**Storage (PAYG only):** $0.25/GB beyond included data.  
**Commands (PAYG):** $0.20 per 100K commands, no monthly minimum.  
**No per-command pricing** on Fixed plans — flat rate regardless of command volume.

### 1.2 Prod Pack Add-on

+$200/month per database. Available on any Redis plan. Includes:
- Uptime SLA
- RBAC (Role-Based Access Control)
- Encryption at rest
- SOC-2 compliance
- Prometheus integration
- Datadog integration

### 1.3 Enterprise Plan

Custom pricing. Includes:
- 100K+ commands/second throughput
- Unlimited bandwidth and database count
- Professional support with SLA
- Dedicated resources for isolation
- HIPAA compliance

---

## 2. Redis Usage in Familiarise

### Rate Limiters (11 active limiters)

| Limiter | Endpoint | Window | Key | Layer |
|---------|----------|--------|-----|-------|
| `authLimiter` | POST `/api/auth/sign-in,sign-up,forget-password` | 10/15 min | IP | Edge |
| `searchLimiter` | GET `/api/user/consultants` | 60/min | IP | Edge |
| `eligibilityLimiter` | GET `/api/trials/check-eligibility` | 20/min | IP | Edge |
| `newsletterLimiter` | POST `/api/newsletter/subscribe` | 3/hr | IP | Edge |
| `availabilityLimiter` | GET `/api/slots/availability/[id]` | 30/min | IP | Edge |
| `checkoutLimiter` | POST `/api/checkout` | 5/min | user ID | Handler |
| `discountLimiter` | POST `/api/payments/discounts/validate` | 10/min | user ID | Handler |
| `referralApplyLimiter` | POST `/api/referrals/apply` | 3/24 hr | user ID | Handler |
| `spamLimiter` | Support tickets, feedbacks, reviews, reports | 5/hr | user ID | Handler |
| `waitlistLimiter` | POST `/api/waitlist` | 5/hr | user ID | Handler |
| `requestApprovalLimiter` | POST `/api/slots/request-for-approval` | 10/hr | user ID | Handler |

~2 Redis commands per `limit()` call.

### Commands Per User Per Month (blended average: ~55–60 cmds/MAU)

| User type | Key actions | Commands/month |
|-----------|-------------|----------------|
| Active consultee (7 visits, 1–2 bookings) | Browse (42) + availability (28) + login (2) + booking lock (5) + maintenance (2) | ~80 cmds |
| Active consultant (4–5 visits, no booking) | Browse (16) + logins (8) + maintenance (2) | ~26 cmds |

**Maintenance mode** (`getMaintenanceState()`): 2 Redis GETs per call, in-memory cached for 30 seconds per edge instance. Net Redis hits: ~1 per 10–20 middleware invocations.

---

## 3. Redis Growth Projections

Free tier: 500K commands/month. PAYG: $0.20 per 100K commands beyond free.

| Stage | MAU | Commands/month | Free tier used | PAYG cost | Monthly (₹) |
|-------|-----|---------------|----------------|-----------|-------------|
| Launch (M1) | 50 | ~3K | 0.6% | $0 | ₹0 |
| Early traction (M3) | 200 | ~12K | 2.4% | $0 | ₹0 |
| Growing (M6) | 700 | ~42K | 8% | $0 | ₹0 |
| Scale (M12) | 1,500 | ~90K | 18% | $0 | ₹0 |
| Strong growth (M18) | 5,000 | ~300K | 60% | $0 | ₹0 |
| **Free tier ceiling** | **~8,300** | **~500K** | **100%** | $0 | **₹0** |
| Post-ceiling | 10,000 | ~600K | — | $0.20 | ₹18 |
| | 20,000 | ~1.2M | — | $1.40 | ₹127 |
| | 50,000 | ~3M | — | $5.00 | ₹454 |
| | 100,000 | ~6M | — | $11.00 | ₹998 |

**Bottom line:** Redis stays free through all of Year 1 and most of Year 2. Even at 10K MAU, cost is ₹18/month — noise-floor compared to the Stream.io cliff (₹36K+/month).

### Data Size (rate limit keys are tiny sorted sets with short TTLs)

| Concurrent users | Est. live Redis data |
|-----------------|---------------------|
| 100 | ~200 KB |
| 1,000 | ~2 MB |
| 10,000 | ~15–20 MB |
| Free tier limit | 256 MB |

Free tier's 256 MB data limit is never the binding constraint — the 500K command ceiling is hit first (~8,300 MAU).

### Plan Decision Guide

| Plan | Price | Switch when |
|------|-------|-------------|
| **Free** | $0 | Up to ~8,300 MAU — stay here |
| **Pay-as-you-go** | $0.20/100K cmds | 8,300–165,000 MAU — cheapest option |
| **Fixed 1GB** | $20/mo (₹1,814) | ~165K MAU (≈10M cmds/mo, where PAYG also costs ~$20) |
| **Fixed 5GB** | $100/mo (₹9,070) | ~830K MAU (≈50M cmds/mo) |
| **Fixed 10GB** | $200/mo (₹18,140) | ~1.65M MAU |
| **Fixed 50GB** | $400/mo (₹36,280) | ~3.3M MAU |
| **Prod Pack add-on** | +$200/mo | Enterprise clients requiring SLA/HIPAA/SOC-2 |

Stay on PAYG until Fixed becomes cheaper. Crossover to Fixed 1GB is at ~165K MAU — unlikely before Series A.

**Note:** If query caching is added (consultant profiles, availability, search results), the command budget per user increases significantly and these projections will need updating.

### Monitoring

Set a Redis alert at **400K commands/month (80% of free tier)** in the Upstash dashboard.

| Metric | Alert threshold | Where |
|--------|----------------|-------|
| Monthly commands | 400K/month | Upstash Dashboard → Usage |
| Data size | 200 MB | Upstash Dashboard → Usage |
| Daily command spike | >20K/day (abuse signal) | Dashboard → Daily Commands chart |

---

## 4. QStash Pricing

QStash is the serverless message queue / HTTP scheduler. Familiarise uses it for:
- Scheduled cron jobs (payout batches, invoice generation, cleanup jobs, lifecycle events)
- Delayed task execution (booking reminders, expiry triggers)

### 4.1 QStash Plans

All prices verified April 2026 from `upstash.com/pricing/qstash`.

| Plan | Monthly cost | Monthly (₹) | Messages/day | Monthly bandwidth |
|------|-------------|------------|-------------|-----------------|
| **Free** | $0 | ₹0 | 1,000 | 50 GB |
| **Pay as you go** | $1/100K messages | Variable | Unlimited | 50 GB |
| **Fixed 1M** | $180 | ₹16,326 | 1,000,000 | 1 TB |
| **Fixed 10M** | $420 | ₹38,094 | 10,000,000 | 5 TB |
| **Enterprise** | Custom | — | 100M+ | Unlimited |

**Prod Pack add-on:** +$200/month. Includes Uptime SLA, Encryption at Rest, SOC-2, Prometheus, Datadog.

### 4.2 QStash Plan Limits Comparison

| Feature | Free | PAYG | Fixed 1M | Fixed 10M | Enterprise |
|---------|------|------|---------|---------|----------|
| Max message size | 1 MB | 10 MB | 50 MB | 50 MB | Custom |
| Max URL groups | 1 | 100 | 1,000 | 2,000 | Custom |
| Max endpoints/URL group | 100 | 100 | 1,000 | 2,000 | Custom |
| Max delay | 7 days | 1 year | Unlimited | Unlimited | Custom |
| Max HTTP response duration | 15 min | 2 hr | 6 hr | 12 hr | Custom |
| Max DLQ retention | 3 days | 7 days | 30 days | 3 months | Custom |
| Max logs retention | 3 days | 7 days | 14 days | 14 days | Custom |
| Max active schedules | 10 | 1,000 | 10,000 | 50,000 | Custom |
| Max queue count | 10 | 100 | 1,000 | 1,000 | Custom |
| Max queue parallelism | 2 | 10 | 10 | 10 | Custom |
| Max parallelism | 10 | 100 | 200 | 1,000 | Custom |

### 4.3 QStash Usage at Familiarise

| Job category | Frequency | Messages/month |
|-------------|-----------|----------------|
| Payout batch (2×/week) | 8 runs | ~8 |
| Invoice generation (monthly) | 1 run | ~1 |
| Booking/slot cleanup (daily) | 30 runs | ~30 |
| Reminder dispatches (per-booking) | ~1,000 bookings × 2 reminders | ~2,000 |
| Lifecycle events (expiry, waitlist) | ~500 events | ~500 |
| Trial conversion checks (daily) | 30 runs | ~30 |
| Misc cleanup jobs (daily/weekly) | ~120 runs | ~120 |
| **Total estimate** | | **~2,700 messages/month** |

**Free tier:** 1,000 messages/day = **30,000 messages/month**. At 2,700 messages/month, using ~9% of free tier.

### 4.4 QStash Free Tier Ceiling

At 1,000 bookings/month (each triggering 2 reminder messages + 1 expiry check), messages ≈ 3,000/month. Free tier holds until:
- Booking volume exceeds ~10,000/month (if reminders scale linearly)
- Or schedule count exceeds 10 active schedules

When free tier is outgrown: **$1/100K messages PAYG** — at 100,000 messages/month = $1.00/month (₹91). Effectively free for years beyond the actual free tier.

---

## 5. Vector Pricing

Serverless vector similarity search. Relevant for future AI features (semantic search, expert matching, recommendation engine). **Not currently in use.**

### 5.1 Vector Plans

All prices verified April 2026 from `upstash.com/pricing/vector`.

| Plan | Monthly cost | Monthly (₹) | Daily queries | Max vectors | Max dims | Max data/metadata | Storage |
|------|-------------|------------|-------------|------------|---------|-----------------|---------|
| **Free** | $0 | ₹0 | 10,000 | 200M | 1,536 | 1 GB | free |
| **Pay as you go** | $0.40/100K requests | Variable | Unlimited | 2B | 3,072 | 50 GB | $0.25/GB |
| **Fixed** | $60 | ₹5,442 | 1,000,000 | 2B | 3,072 | 50 GB | $0.25/GB |
| **Pro (Enterprise)** | Custom | — | Unlimited | 100B | 5,000 | 1 TB | $0.03/GB |

**Uptime SLA:** 99.9% (Free/PAYG/Fixed), 99.99% (Pro/Enterprise)

**When to activate Vector:** Semantic expert search, content recommendations, or AI-powered matching. Free tier (10K queries/day) is sufficient for initial experiments and prototyping.

---

## 6. Workflow Pricing

Durable execution engine for long-running serverless processes. Relevant if cron jobs need retry guarantees and visibility beyond QStash's scheduler. **Not currently in use.**

### 6.1 Workflow Plans

All prices verified April 2026 from `upstash.com/pricing/workflow`.

| Plan | Monthly cost | Monthly (₹) | Steps/day | Monthly bandwidth |
|------|-------------|------------|---------|-----------------|
| **Free** | $0 | ₹0 | 1,000 | 50 GB |
| **Pay as you go** | $1/100K steps | Variable | Unlimited | 50 GB |
| **Fixed 1M** | $180 | ₹16,326 | 1,000,000 | 1 TB |
| **Fixed 10M** | $420 | ₹38,094 | 10,000,000 | 5 TB |
| **Enterprise** | Custom | — | 100M+ | Unlimited |

**Prod Pack add-on:** +$200/month (Uptime SLA, Encryption at Rest, SOC-2, Prometheus, Datadog).

### 6.2 Workflow Plan Limits

| Feature | Free | PAYG | Fixed 1M | Fixed 10M |
|---------|------|------|---------|---------|
| Max steps/workflow run | 1,000 | 1,000 | 1,000 | 1,000 |
| Max concurrent steps | 10 | 100 | 200 | 1,000 |
| Max message size | 1 MB | 10 MB | 50 MB | 50 MB |
| Max sleep duration | 7 days | 1 year | Unlimited | Unlimited |
| Max HTTP response | 15 min | 2 hr | 6 hr | 12 hr |
| Max DLQ retention | 3 days | 7 days | 30 days | 3 months |
| Max logs retention | 3 days | 7 days | 14 days | 14 days |

**Note:** QStash and Workflow share identical plan pricing ($0/180/420) and PAYG rates ($1/100K messages/steps). Workflow adds durable execution semantics; QStash is better for simple fire-and-forget HTTP scheduling. Familiarise currently uses QStash; Workflow would be relevant if multi-step saga patterns or guaranteed exactly-once delivery become requirements.

---

## 7. Full Upstash Cost by Growth Stage

| Stage | MAU | Redis | QStash | Vector | Workflow | Total ₹/mo |
|-------|-----|-------|--------|--------|---------|----------|
| Pre-launch | 0 | ₹0 | ₹0 | ₹0 | ₹0 | **₹0** |
| Launch (M1–M6) | 50–700 | ₹0 | ₹0 | ₹0 | ₹0 | **₹0** |
| Early traction (M12) | 1,500 | ₹0 | ₹0 | ₹0 | ₹0 | **₹0** |
| Strong growth (M18) | 5,000 | ₹0 | ₹0 | ₹0 | ₹0 | **₹0** |
| Post-free ceiling | 10,000 | ₹18 | ₹91 (est.) | ₹0 | ₹0 | **~₹110** |
| Scale | 50,000 | ₹454 | ₹454 | ₹0 | ₹0 | **~₹910** |
| Enterprise | 100,000 | ₹998 | ₹1,800 | Custom | ₹0 | **~₹2,800+** |

**Upstash is effectively free through all of Year 2.** Even at 100K MAU, total cost is under ₹3,000/month — less than 1% of Stream.io at the same scale.

---

## 8. Upstash vs Alternatives

| | **Upstash Redis** | **Redis Cloud** | **AWS ElastiCache** | **Vercel KV** |
|---|---|---|---|---|
| Free tier | 500K cmds/mo | 30 MB | None | 30K cmds/day |
| PAYG | $0.20/100K cmds | $0.067/hr minimum | $0.023/hr minimum | $0.20/100K |
| Serverless/edge | ✅ | ❌ | ❌ | ✅ |
| HTTP API | ✅ (no TCP needed) | ❌ | ❌ | ✅ |
| Global replicas | ✅ | ✅ | ✅ | ✅ |
| Netlify/Vercel compat | ✅ | Partial | Partial | ✅ (Vercel only) |

**Verdict:** Upstash wins at our scale due to free tier generosity, serverless-first HTTP API, and Netlify/edge compatibility. No reason to switch before Series A.

---

## Related Documents

- `docs/upstash/redis/locking/00_README.md` — Distributed locking implementation
- `docs/stream/00-pricing-overview.md` — Stream.io pricing overview and cost cliff
- `docs/stream/14-pricing-and-cost-model.md` — Stream.io full rate tables (verified Apr 2026)
- Screenshots: `docs/upstash-redis-pricing-apr2026.png`, `docs/upstash-qstash-pricing-apr2026.png`
