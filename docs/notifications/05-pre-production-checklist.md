# Pre-Production Checklist — Email, Notifications & Newsletter

> Everything needed before going live. Current state, free tier limits, when to pay, and the exact setup steps.

**Last Updated**: 2026-03-24
**Live Domain**: `familiarisenow.com` (Netlify)

---

## Table of Contents

- [Critical Blocker: Email Domain](#critical-blocker-email-domain)
- [Service Free Tier Limits](#service-free-tier-limits)
- [Pre-Launch Checklist (Free, $0/month)](#pre-launch-checklist-free-0month)
- [DNS Setup for Resend (Step-by-Step)](#dns-setup-for-resend-step-by-step)
- [Novu Dashboard Configuration](#novu-dashboard-configuration)
- [Cron Job Scheduling](#cron-job-scheduling)
- [Environment Variables](#environment-variables)
- [When You'll Need to Pay](#when-youll-need-to-pay)
- [Deferred Services (Post-Launch)](#deferred-services-post-launch)
- [Cost Projection Timeline](#cost-projection-timeline)
- [Sources](#sources)

---

## Critical Blocker: Email Domain

The codebase sends emails from `@familiarise.com`:

```
onboarding@familiarise.com
security@familiarise.com
payments@familiarise.com
notifications@familiarise.com
newsletter@familiarise.com
```

**Files using these `from:` addresses:**

- `lib/email.ts` — 6 functions (onboarding@, security@, payments@)
- `app/api/admin/newsletter/send/route.ts` — 1 function (newsletter@)

**The problem:** The live site is at `familiarisenow.com`, not `familiarise.com`. Resend requires you to verify the sending domain via DNS. You can only verify a domain you own and control.

**Two options:**

| Option                          | Pros                                                | Cons                                                                 |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| **A: Buy `familiarise.com`**    | Clean brand, matches existing code, no code changes | Domain may be taken/expensive                                        |
| **B: Use `familiarisenow.com`** | You already own it, free                            | Need to update all `from:` addresses in code (~11 places in 3 files) |

**Decision needed before launch.** Everything else can proceed regardless.

---

## Service Free Tier Limits

### Resend (Email Delivery)

| Feature                  | Free        | Pro ($20/mo)           | Scale ($90/mo)         |
| ------------------------ | ----------- | ---------------------- | ---------------------- |
| Emails/month             | 3,000       | 50,000                 | 100,000                |
| **Daily limit**          | **100/day** | No limit               | No limit               |
| Custom domain            | Yes         | Yes                    | Yes                    |
| Analytics (opens/clicks) | **No**      | Yes                    | Yes                    |
| API keys                 | 1           | Multiple               | Multiple               |
| Overage                  | Blocked     | Pay-as-you-go (5x cap) | Pay-as-you-go (5x cap) |

**What 100/day means in practice:**

- Each booking typically fires 2 emails (confirmation to both parties)
- 100/day = ~50 bookings/day, or ~50 unique user actions triggering emails
- Newsletter sends count against this — a blast to 200 subscribers = 200 emails = 2 days of quota
- **Workaround for newsletters:** Send admin newsletter blasts during off-peak hours, batch across days if >100 subscribers

**What you lose without analytics:**

- No open rate tracking
- No click tracking
- No bounce/complaint monitoring
- You're flying blind on deliverability until you upgrade

### Novu (Notification Orchestration)

| Feature                    | Free      | Pro (~$25-30/mo) |
| -------------------------- | --------- | ---------------- |
| Events/month               | ~10,000   | 30,000           |
| In-app notifications       | Yes       | Yes              |
| Email channel (via Resend) | Yes       | Yes              |
| Digest/batching            | Limited   | Full             |
| Activity feed retention    | 7 days    | 30 days          |
| Subscribers                | Unlimited | Unlimited        |
| Workflows                  | 20        | 20 (100 on Team) |

**What an "event" is:**

- 1 trigger call to 1 subscriber = 1 event
- `notifyAppointmentBooked([consultantId, consulteeId], payload)` = **2 events** (one per recipient)
- `notifyGeneralAnnouncement(payload)` (broadcast to 500 users) = **500 events**

**Capacity math:**

- 10K events/month = ~166 events/day
- At 2 recipients per notification, that's ~83 notification triggers/day
- Comfortable for the first few hundred active users

### Kit / ConvertKit (Newsletter — Deferred)

| Feature          | Free Newsletter | Creator ($39/mo)           |
| ---------------- | --------------- | -------------------------- |
| Subscribers      | **10,000**      | 1,000+ (scales with price) |
| Email sends      | Unlimited       | Unlimited                  |
| Automations      | 1               | Unlimited                  |
| Sequences (drip) | **No**          | Yes                        |
| Landing pages    | Yes             | Yes                        |
| Tags/segments    | Yes             | Yes                        |

**The free tier is very generous.** 10K subscribers with unlimited sends covers you well past launch. You only need Creator when you want automated drip sequences (welcome series, onboarding flows, re-engagement).

### Directus CMS (Blog — Deferred)

| Feature           | Self-Hosted          | Cloud ($25/mo) |
| ----------------- | -------------------- | -------------- |
| Cost              | Free (your infra)    | $25/mo         |
| Setup complexity  | Docker, VPS, backups | Managed        |
| Content API       | Full                 | Full           |
| Media storage     | Your S3/Supabase     | Included       |
| Revenue threshold | Free under $5M/yr    | No limit       |

**Recommendation:** Use Directus Cloud at $25/mo when ready for the blog. Skip self-hosting complexity at this stage.

---

## Pre-Launch Checklist (Free, $0/month)

### Step 1: Domain Decision

- [ ] Decide: `familiarise.com` (buy) or `familiarisenow.com` (already owned)
- [ ] If using `familiarisenow.com`: update `from:` addresses in `lib/email.ts` and `app/api/admin/waitlist/broadcast/route.ts`
- [ ] If buying `familiarise.com`: purchase and configure DNS

### Step 2: Resend Setup

- [ ] Create account at [resend.com](https://resend.com)
- [ ] Add sending domain (see [DNS Setup](#dns-setup-for-resend-step-by-step) below)
- [ ] Verify domain (DKIM + SPF)
- [ ] Copy API key → save for Step 5

### Step 3: Novu Setup

- [ ] Create account at [novu.co](https://novu.co)
- [ ] Add Resend as email provider in Novu → Integrations
- [ ] Sync the workflows (see [Novu Dashboard Configuration](#novu-dashboard-configuration))
- [ ] Copy Secret Key + App ID → save for Step 5

### Step 4: Prisma Migration

- [ ] Run `npx prisma migrate dev --name add-newsletter-unsubscribe-fields`
- [ ] Verify Newsletter model has `unsubscribed` and `unsubscribedAt` fields

### Step 5: Environment Variables

- [ ] Set all required env vars in Netlify dashboard (see [Environment Variables](#environment-variables))

### Step 6: Cron Jobs

- [ ] Set up GitHub Actions for appointment-reminders (every 15 min)
- [ ] Set up GitHub Actions for auto-complete-appointments (hourly)
- [ ] Verify both with manual trigger

### Step 7: Smoke Test

- [ ] Sign up as new user → verify welcome email arrives
- [ ] Subscribe to newsletter → verify DB record
- [ ] Unsubscribe via link → verify `unsubscribed = true`
- [ ] Trigger a test Novu workflow → verify in-app bell notification appears
- [ ] Check Resend dashboard → verify domain shows "Verified"

---

## DNS Setup for Resend (Step-by-Step)

1. Log into [Resend Dashboard → Domains](https://resend.com/domains)
2. Click **"+ Add Domain"**
3. Enter your domain: `familiarisenow.com` (or `familiarise.com`)
4. Select region: **us-east-1** (or closest to your users)
5. Resend will display DNS records to add:

| Type | Name                               | Value                                   | Purpose           |
| ---- | ---------------------------------- | --------------------------------------- | ----------------- |
| TXT  | `resend._domainkey.yourdomain.com` | `p=MIGfMA0GCSq...`                      | DKIM signature    |
| TXT  | `yourdomain.com`                   | `v=spf1 include:amazonses.com ~all`     | SPF authorization |
| MX   | `bounce.yourdomain.com`            | `feedback-smtp.us-east-1.amazonses.com` | Bounce handling   |

6. Go to your DNS provider (Netlify DNS or domain registrar)
7. Add each record exactly as shown
8. Back in Resend, click **"Verify DNS"**
9. Wait for verification (minutes to 48 hours for DNS propagation)
10. Status should change to **"Verified"** with green checkmarks

**If using Cloudflare DNS:** Resend has automatic Cloudflare integration — click "Sign in to Cloudflare" to auto-add records.

**Important:** Do NOT proxy the DNS records through Cloudflare (orange cloud). DKIM and SPF records must be DNS-only (gray cloud).

---

## Novu Dashboard Configuration

Use the template specs at `docs/notifications/03-novu-template-specs.md` for copy-paste-ready content.

### 1. Add Resend Email Provider

1. Go to **Novu Dashboard → Integrations**
2. Click **"Add Provider"** → select **Resend**
3. Enter your `RESEND_API_KEY`
4. Set default From: `Familiarise <notifications@yourdomain.com>`
5. Save and activate

### 2. Sync the workflows

The workflows are no longer created by hand. `lib/novu/templates/` is the source of truth, and `scripts/novu/sync-workflows.ts` writes it to the Novu environment with three commands:

- `npm run novu:sync -- --dry-run` prints the plan without writing anything.
- `npm run novu:sync` applies the plan. It retires the 19 legacy workflows first, because the environment's 20-workflow cap counts live workflows and a create on a full environment fails. This apply is a production operation: local development and production both point at the same Development environment, so running it writes to what customers see. Run it by hand after a merge, never from CI.
- `npm run novu:check` exits 1 if the live environment has drifted from the manifest. This is the drift guard CI runs on every pull request.

### 3. Preference categories and step conditions

Nothing to configure by hand. Each family carries its opt-out category as a tag and as a step condition (`subscriber.data.<categoryFlag> != false`, plus `routingBell != false`), both written by the sync from `FAMILIES` and `inAppSkipRule` in `lib/novu/templates/`. The family-to-category map is the table in `03-novu-template-specs.md`, and the runbook in `docs/enterprise/50-operations/09-novu-console-conditions.md` describes what the sync writes and how to verify it.

### 4. Gate the production deploy on the sync

The `prod` branch deploys on merge, and the code it carries triggers family ids. Before merging `dev` into `prod` after any change under `lib/novu/templates/`, run `npm run novu:sync` and then `npm run novu:check` and confirm it reports nothing to change; a deploy that lands before the sync drops every notification of a missing family silently. The same order applies in reverse for the first migration: merge, sync, then verify one event per changed family in an inbox.

--------------------- | -------------------------------------------------------------------------------------------------- |
| `appointments` | appointment-booked, appointment-cancelled, appointment-reminder, new-booking-request |
| `payments` | payment-success, payment-failed |
| `subscriptions` | subscription-started, subscription-cancelled |
| `trials` | trial-session-requested, trial-session-scheduled, trial-session-completed, trial-session-cancelled |
| `support` | support-ticket-created, support-ticket-response |
| `feedback` | new-review-received |
| (none — always sends) | verification-status-changed |

---

## Cron Job Scheduling

### GitHub Actions Workflow

Create `.github/workflows/cron-notifications.yml`:

```yaml
name: Notification Cron Jobs

on:
  schedule:
    # Appointment reminders - every 15 minutes
    - cron: "*/15 * * * *"
  workflow_dispatch: # Allow manual trigger

jobs:
  appointment-reminders:
    runs-on: ubuntu-latest
    steps:
      - name: Send appointment reminders
        run: |
          curl -s -f -X GET \
            "${{ secrets.APP_URL }}/api/cleanup/appointment-reminders" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

Create `.github/workflows/cron-auto-complete.yml`:

```yaml
name: Auto-Complete Appointments

on:
  schedule:
    # Hourly
    - cron: "0 * * * *"
  workflow_dispatch:

jobs:
  auto-complete:
    runs-on: ubuntu-latest
    steps:
      - name: Auto-complete expired appointments
        run: |
          curl -s -f -X GET \
            "${{ secrets.APP_URL }}/api/cleanup/auto-complete-appointments" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

**GitHub Secrets needed:**

- `APP_URL` = `https://familiarisenow.com`
- `CRON_SECRET` = same value as in Netlify env vars

---

## Environment Variables

Set these in **Netlify Dashboard → Site → Environment Variables**:

| Variable                  | Value                                     | Required                                |
| ------------------------- | ----------------------------------------- | --------------------------------------- |
| `NEXT_PUBLIC_APP_URL`     | `https://familiarisenow.com`              | Yes                                     |
| `RESEND_API_KEY`          | From Resend dashboard                     | Yes                                     |
| `NOVU_SECRET_KEY`         | From Novu dashboard → Settings → API Keys | Yes                                     |
| `NEXT_PUBLIC_NOVU_APP_ID` | From Novu dashboard → Settings → API Keys | Yes                                     |
| `CRON_SECRET`             | Generate: `openssl rand -hex 32`          | Yes                                     |
| `NEWSLETTER_HMAC_SECRET`  | Generate: `openssl rand -hex 32`          | Optional (falls back to RESEND_API_KEY) |
| `STREAM_WEBHOOK_SECRET`   | From Stream.io dashboard                  | Yes (for recording notifications)       |

**Generate secrets locally:**

```bash
# Run these and copy the output
openssl rand -hex 32  # → CRON_SECRET
openssl rand -hex 32  # → NEWSLETTER_HMAC_SECRET
```

---

## When You'll Need to Pay

### Resend: Free → Pro ($20/mo)

**Upgrade trigger:** Any of these:

- Consistently sending >80 emails/day
- Need open/click analytics for deliverability monitoring
- Planning a newsletter blast to >100 subscribers (daily limit)
- Getting "rate limit" errors in logs

**Expected timeline:** Month 2-3 post-launch

### Novu: Free → Pro (~$25-30/mo)

**Upgrade trigger:** Any of these:

- Exceeding 10K events/month
- Need activity feed retention >7 days
- Need advanced digest/batching rules

Note that Pro keeps the 20-workflow cap; only Team ($250/month) raises it to 100. The 16 workflow families exist so that the cap is not the reason to upgrade.

**Expected timeline:** Month 3-6 post-launch (when you have ~100+ DAU)

**Self-hosting alternative:** Novu is open-source. You can self-host for unlimited events if you want to avoid the cost, but it adds DevOps overhead.

### Kit (ConvertKit): Free → Creator ($39/mo)

**Upgrade trigger:**

- Need automated drip sequences (welcome series, onboarding flows)
- Need more than 1 automation rule
- The free tier supports 10K subscribers, so subscriber count won't be the trigger

**Expected timeline:** 6+ months post-launch

### Directus CMS: $0 → Cloud ($25/mo)

**Upgrade trigger:**

- Ready to launch the blog for SEO/content marketing
- Need a content management system for the team

**Expected timeline:** When content strategy kicks in (post-launch, when you have traction)

---

## Cost Projection Timeline

| Phase                               | Resend | Novu   | Kit  | Directus | Total           |
| ----------------------------------- | ------ | ------ | ---- | -------- | --------------- |
| **Launch (Month 1)**                | $0     | $0     | $0   | $0       | **$0/mo**       |
| **Early Growth (Month 2-3)**        | $20    | $0     | $0   | $0       | **$20/mo**      |
| **Active Users (Month 3-6)**        | $20    | $25    | $0   | $0       | **$45/mo**      |
| **Content + Newsletter (Month 6+)** | $20    | $25    | $0\* | $25      | **$70/mo**      |
| **Full Scale (Month 12+)**          | $20-90 | $25-50 | $39  | $25      | **$109-204/mo** |

_Kit free tier covers 10K subscribers. Creator ($39/mo) only needed for drip sequences._

**Note:** These costs are separate from your existing SaaS stack (Supabase, Stream.io, Upstash, etc.). See `docs/finances/08-saas-expenditures.md` for the full breakdown.

---

## Deferred Services (Post-Launch)

### ConvertKit (Kit) — Newsletter

**Current state:** Stubs in `lib/newsletter/convertkit.ts`. Newsletter subscribe/unsubscribe routes work via Resend batch API as interim.

**When to integrate:**

- 500+ newsletter subscribers
- Ready for drip sequences (welcome, onboarding, re-engagement)
- Blog is live and you want automated "new post" broadcasts

**What to do:**

1. Sign up at [kit.com](https://kit.com) (free tier)
2. Get API key + form ID
3. Set `CONVERTKIT_API_KEY` and `CONVERTKIT_FORM_ID` env vars
4. Replace stub functions in `lib/newsletter/convertkit.ts` with real API calls
5. Set up subscriber tags (consultant, consultee, tech, career, business)
6. Wire Directus webhook → `createBroadcast()` for blog post notifications

### Directus CMS — Blog & Community

**Current state:** Webhook stub at `app/api/webhooks/directus/route.ts`. Database schema isolation designed (`public` vs `cms` schema).

**When to integrate:**

- Ready for SEO-driven content marketing
- Have someone to write content (you, team member, or AI-assisted)

**What to do:**

1. Sign up for [Directus Cloud](https://directus.io/pricing/cloud) ($25/mo) or self-host
2. Point at your Supabase PostgreSQL database
3. Configure `DB_SCHEMA=cms` for isolation
4. Create content tables: `cms_posts`, `cms_categories`
5. Set up webhook to fire on `items.create` for `cms_posts`
6. Update `app/api/webhooks/directus/route.ts` to handle real events
7. Build blog frontend pages in Next.js

**Architecture docs:** the Directus CMS design was deleted with `docs/roadmap/` in #1535; the live question is tracked in #767.

---

## Sources

- [Resend Pricing](https://resend.com/pricing)
- [Resend Account Quotas and Limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- [Resend Domain Setup Guide](https://resend.com/docs/dashboard/domains/introduction)
- [Resend New Free Tier Announcement](https://resend.com/blog/new-free-tier)
- [Novu Pricing](https://novu.co/pricing/)
- [Novu Pro Tier Announcement](https://novu.co/blog/from-builders-for-builders-introducing-new-novu-pro-tier/)
- [Novu Free Tier Events Discussion](https://www.answeroverflow.com/m/1121163999606734989)
- [Directus Pricing (Self-hosting and Cloud)](https://directus.io/pricing)
- [Kit (ConvertKit) Pricing](https://kit.com/pricing)
- [Kit Pricing Analysis 2026](https://www.emailtooltester.com/en/reviews/convertkit/pricing/)
- [Resend SPF/DKIM/DMARC Setup Guide](https://dmarcdkim.com/setup/how-to-setup-resend-spf-dkim-and-dmarc-records)
