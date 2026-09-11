# Stream.io — Pricing Overview

Quick-reference pricing guide for Stream.io (Video + Chat + Feeds). All data verified April 23, 2026 via live pricing calculator and Maker Account page.

For full rate tables and permutation matrices, see [`14-pricing-and-cost-model.md`](./14-pricing-and-cost-model.md).
For Enterprise plans, SLA tiers, AI Moderation, and the Maker-to-paid transition roadmap, see [`15-enterprise-and-maker-account.md`](./15-enterprise-and-maker-account.md).

---

## Current Status: Maker Account (Free)

Familiarise qualifies for Stream's [Maker Account](https://getstream.io/maker-account/) — a zero-cost tier for early-stage products.

### Eligibility (ALL three must hold simultaneously)

| Requirement            | Familiarise Status     | Holds? |
| ---------------------- | ---------------------- | ------ |
| ≤ 5 team members       | 2 (founder + 1 intern) | Yes    |
| < $10K monthly revenue | $0 (pre-revenue)       | Yes    |
| < $100K in funding     | $0 (bootstrapped)      | Yes    |

> **Critical:** The `< $100K in funding` condition is easy to miss. Any seed round — even a small angel cheque — likely triggers the cliff.

### What Maker Includes

| Feature        | Hard Limit                        | Normal Paid Value   |
| -------------- | --------------------------------- | ------------------- |
| Chat           | **2,000 MAU** (hard cap, pauses)  | $399/mo (10K MAU)   |
| Video          | 333,000 participant-minutes/month | $0.15–$9.60/1K PM   |
| Activity Feeds | 125,000 API calls/month           | $499/mo (Start)     |
| AI Moderation  | $100 in credits                   | $2/1K msgs (PAYG)   |

> The Chat 2K MAU cap is a **hard pause** — the service stops, it does not bill overages.

---

## Video Pricing (Post-Maker)

Rates per 1,000 participant-minutes (PM). 60fps = 2× the 30fps rate.

| Quality        | 30fps rate  | 60fps rate  | Common use      |
| -------------- | ----------- | ----------- | --------------- |
| Audio Only     | $0.30/1K PM | $0.60/1K PM | Voice calls     |
| SD (360p)      | $1.50/1K PM | $3.00/1K PM | Low-bandwidth   |
| HD (720p)      | $3.00/1K PM | $6.00/1K PM | Consultations   |
| Full HD (1080) | $4.50/1K PM | $9.00/1K PM | Webinars        |
| 2K (1440p)     | $6.00/1K PM | $12.00/1K PM| Premium         |
| 4K (2160p)     | $9.60/1K PM | $19.20/1K PM| Ultra           |

**Live Streaming mode** rates are 67% of the Video Calls rates above for SD through 4K, and 40% for Audio Only.

### Recording Add-on (Video Calls only, unavailable at 2K/4K)

| Quality    | Rate per 1K call-minutes |
| ---------- | ------------------------ |
| Audio Only | $1.50                    |
| SD         | $3.00 ¹                  |
| HD         | $6.00                    |
| Full HD    | $12.00                   |

¹ SD recording rate follows the confirmed doubling pattern (Audio Only $1.50 → SD $3.00 → HD $6.00 → FHD $12.00) but was not directly verified in the calculator — all other rows were.

### Other Add-ons

| Add-on              | Rate              |
| ------------------- | ----------------- |
| Noise Cancellation  | $0.30/1K PM       |
| Transcriptions      | $8.00/1K call-min |
| RTMP In/Out         | $15.00/1K call-min|
| HLS (Live mode only)| $0.96/1K PM       |

---

## Chat Pricing (Post-Maker)

Pricing as of April 2026. Annual = 2 months free.

| Plan       | MAU    | Annual/mo | Monthly/mo | Annual (INR @₹90.7) | Monthly (INR) |
| ---------- | ------ | --------- | ---------- | ------------------- | ------------- |
| Start      | 10K    | $399      | $499       | ₹36,189             | ₹45,259       |
| Start      | 25K    | $549      | $699       | ₹49,794             | ₹63,399       |
| Start      | 50K    | $749      | $949       | ₹67,934             | ₹86,074       |
| Elevate    | 10K    | $499      | $599       | ₹45,259             | ₹54,329       |
| Elevate    | 25K    | $649      | $799       | ₹58,864             | ₹72,469       |
| Elevate    | 50K    | $899      | $1,099     | ₹81,539             | ₹99,679       |
| Enterprise | 1M+ MAU| Custom    | —          | —                   | —             |

**Start vs Elevate:** Elevate adds push notifications, message search, content translation, message pinning, advanced moderation (shadow ban, bounce).

---

## Activity Feeds Pricing (Post-Maker)

| Plan     | Price (Annual) | Price (Monthly) |
| -------- | -------------- | --------------- |
| Start    | $499/mo        | $599/mo         |
| Elevate  | $899/mo        | $999/mo         |

---

## The Cost Cliff

| Trigger                     | Stream cost before | Stream cost after       | Net jump            |
| --------------------------- | ------------------ | ----------------------- | ------------------- |
| Any one Maker condition lost | ₹0/month           | ₹36,189/mo (Chat Start) | **+₹36,189/mo**     |

This is the single largest SaaS cost increase in the Familiarise stack. Budget for it before crossing ₹8.5L/month GMV or taking any outside funding.

### Monitoring

Set a **1,500 MAU alert** (75% of the 2K hard cap) in the Stream dashboard to get advance warning before the Chat service pauses.

---

## SaaS Cost by Growth Stage (Stream portion only)

| Stage              | MAU     | Stream cost/mo (pre-GST) | Notes                        |
| ------------------ | ------- | ------------------------ | ---------------------------- |
| Launch–early (M1–6)| < 2K    | ₹0 (Maker)               | Video 333K PM included       |
| Post-Maker         | 2K–10K  | ₹36,189 (Chat Start 10K) | Annual pricing, +GST 18% RCM |
| Growth             | 10K–25K | ₹49,794 (Chat Start 25K) | Annual pricing               |
| Scale              | 25K+    | ₹67,934+ (Chat Start 50K)| Consider Elevate for features|
| Enterprise         | 1M+     | Custom                   | Dedicated infrastructure     |

> **GST note:** If GST-registered, add 18% IGST under RCM on all Stream.io payments. This is claimable as ITC.

---

## Related Documents

- [`14-pricing-and-cost-model.md`](./14-pricing-and-cost-model.md) — Full rate matrix with participant-count permutation tables (all qualities × FPS × duration × session count)
- [`15-enterprise-and-maker-account.md`](./15-enterprise-and-maker-account.md) — Enterprise tiers, SLA details, AI Moderation PAYG rates, Familiarise tier roadmap
- [`docs/finances/09-pricing-strategy.md`](../finances/09-pricing-strategy.md) — Competitive pricing strategy and commission model
