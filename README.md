# Familiarise

> **Note:** This project was formerly known as **ConsultX** (2022-2023) and is planned to be rebranded as **Elluminar** in the future.

## What is Familiarise?

Familiarise is a **B2B/B2C marketplace platform** that connects world-class experts—mentors, consultants, coaches, and instructors—with learners seeking personalized guidance, mentorship, and education.

Think of it as the "Airbnb for expertise": a platform where professionals can monetize their knowledge through one-on-one sessions, ongoing mentorship programs, structured courses, and live webinars, while learners get direct access to industry experts who can accelerate their careers and skill development.

### Who is it for?

**For Experts (Consultants):**

- Industry professionals looking to monetize their expertise
- Career coaches and mentors
- Subject matter experts and educators
- Entrepreneurs sharing startup knowledge
- Specialists in tech, business, design, marketing, and more

**For Learners (Consultees):**

- Career changers breaking into new fields
- Professionals seeking advancement
- Students wanting industry guidance
- Entrepreneurs needing business mentorship
- Anyone seeking personalized skill development

### Key Features

| Feature                  | Description                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| **1-on-1 Consultations** | Single sessions for career advice, mock interviews, code reviews, design feedback |
| **Subscriptions**        | Ongoing 4-12 week mentorship programs with recurring sessions                     |
| **Classes**              | Structured multi-week courses with materials, recordings, and certifications      |
| **Webinars**             | Live group learning events with Q&A and waitlist management                       |
| **Video Calls**          | HD video via Stream.io with screen sharing and recording                          |
| **In-App Messaging**     | Direct communication and document sharing between sessions                        |
| **Document Review**      | Upload resumes, portfolios, or code for expert feedback                           |
| **Smart Scheduling**     | Timezone-aware booking with weekly and custom availability                        |
| **Secure Payments**      | Razorpay (primary, INR settlement) and Stripe (request→approve bookings), with escrow protection. **Consultees book from anywhere; consultants must be able to receive INR in India** — see below. |
| **Earnings Dashboard**   | 80/20 revenue split with transparent payout tracking                              |
| **Referral System**      | Viral growth via referral links, credit rewards for referrer and referee          |
| **Collaborators**        | Multi-creator webinars and classes with role-based revenue sharing                |

### Platform Stats

- 500+ verified expert mentors
- 8+ domains (Technology, Business, Design, Marketing, Career Coaching, Education, Startups, Languages)
- Multiple session types to fit any learning style
- Money-back guarantee for unsatisfied sessions

## Who can use this, and from where

This distinction is load-bearing and easy to get backwards, so it is stated up
front rather than buried in the payments docs.

**Consultees can be anywhere in the world.** International cards are accepted,
Razorpay converts at the buyer's bank and settles INR to the platform, and the
FIRC needed under FEMA is generated automatically. Nothing blocks a foreign
buyer and nothing should — this is live and working.

**Consultants must be able to receive INR into an Indian bank account.** This is
not a preference, it is what is currently built. TDS is withheld under Section
194-O, which by definition applies only to residents; paying a non-resident
instead requires Section 195 withholding, treaty relief against a tax residency
certificate and Form 10F, and a Form 15CA/15CB filing per remittance, none of
which exists yet. RazorpayX also cannot pay a foreign bank account at all. The
payout pipeline enforces this: `processSinglePayout` throws rather than
half-paying someone, and the UI says so during consultant onboarding.

If you are changing payout code and wondering why the non-resident branch
refuses instead of falling through — that is deliberate, and removing it would
create a statutory withholding failure, not a feature.

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- OR Node.js 20+ and npm

### Option 1: Docker (Recommended)

```bash
# 1. Clone the repository
git clone <repository_url>
cd familiarise_web

# 2. Create environment file
cp .env.sample .env
# Edit .env with your credentials (see Environment Variables section)

# 3. Start development server
docker compose up --build

# App runs at http://localhost:3000
```

### Option 2: Local Development

```bash
# 1. Clone and install
git clone <repository_url>
cd familiarise_web
npm install

# 2. Setup environment
cp .env.sample .env
# Edit .env with your credentials

# 3. Generate Prisma client
npx prisma generate

# 4. Start development server
npm run dev
```

## Environment Variables

Create a `.env` file based on `.env.sample`. Never commit `.env` or secrets to the repository.

### Required Variables

| Variable                        | Description                          | Local Value              | Production Value               |
| ------------------------------- | ------------------------------------ | ------------------------ | ------------------------------ |
| `DATABASE_URL`                  | Supabase pooled connection string    | From Supabase dashboard  | Same (or prod project)         |
| `DIRECT_URL`                    | Supabase direct connection (migrations) | From Supabase dashboard | Same (or prod project)        |
| `BETTER_AUTH_SECRET`            | Auth signing secret                  | Random 32+ char string   | Different secret for prod      |
| `BETTER_AUTH_URL`               | App base URL for auth callbacks      | `http://localhost:3000`  | `https://familiarisenow.com`   |
| `BETTER_AUTH_TRUSTED_ORIGINS`   | Allowed origins for auth             | `http://localhost:3000`  | `https://familiarisenow.com`   |
| `NEXT_PUBLIC_APP_URL`           | Public-facing app URL                | `http://localhost:3000`  | `https://familiarisenow.com`   |
| `NODE_ENV`                      | Runtime environment                  | `development`            | `production`                   |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL                 | From Supabase dashboard  | Same                           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key                    | From Supabase dashboard  | Same                           |

<details>
<summary>All Environment Variables</summary>

### Authentication

| Variable | Description | Notes |
|----------|-------------|-------|
| `BETTER_AUTH_SECRET` | Auth signing secret | Must be unique per environment |
| `BETTER_AUTH_URL` | Auth callback base URL | `localhost` for dev, production domain for prod |
| `BETTER_AUTH_TRUSTED_ORIGINS` | CORS origins for auth | Must match `BETTER_AUTH_URL` |
| `JWT_SECRET` | JWT signing key | Can match `BETTER_AUTH_SECRET` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | From Google Cloud Console |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID | Optional |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | Optional |
| `FACEBOOK_CLIENT_ID` | Facebook OAuth client ID | Optional |
| `FACEBOOK_CLIENT_SECRET` | Facebook OAuth client secret | Optional |

### Database & Cache

| Variable | Description | Notes |
|----------|-------------|-------|
| `DATABASE_URL` | Supabase pooled connection | Use `?pgbouncer=true` suffix |
| `DIRECT_URL` | Supabase direct connection | For migrations only |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin key | Server-side only, never expose |
| `SUPABASE_ACCESS_TOKEN` | Supabase management API | For CLI/admin operations |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL | Used for rate limiting and caching |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth token | Required for Redis access |

> **Note:** Do NOT set `REDIS_URL=redis://localhost:6379` on Netlify. The platform uses Upstash Redis via REST API (`UPSTASH_REDIS_REST_URL`), not a TCP Redis connection.

### Payments

| Variable | Description | Notes |
|----------|-------------|-------|
| `NEXT_PUBLIC_STRIPE_KEY` | Stripe publishable key | `pk_test_` for dev, `pk_live_` for prod |
| `STRIPE_SECRET_KEY` | Stripe secret key | `sk_test_` for dev, `sk_live_` for prod |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | Different per environment |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Razorpay key ID | `rzp_test_` for dev, `rzp_live_` for prod |
| `RAZORPAY_KEY_ID` | Razorpay key ID (server) | Same as public key |
| `RAZORPAY_SECRET` | Razorpay secret | Different per environment |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signing secret | **Required.** `/api/webhooks/razorpay` returns 500 before verifying anything when it is unset, so every gateway event is rejected — silently, since no live payment has exercised it. Absent from Netlify's deploy-preview context; confirm it exists for **production**. |

> **Reminder — Dodo Payments is schema-only.** `DODO_PAYMENTS` exists as a
> `PaymentGateway` enum value and nothing else: no client, no checkout path, no
> webhook handler, no payout submitter, and no timeline. The value is reserved
> only because Postgres cannot drop an enum value cheaply. It throws
> (`UnsupportedGatewayError`) if it ever reaches gateway routing, a refund, or a
> payout, so it cannot be used by accident — see
> [docs/payments/gateways/README.md](docs/payments/gateways/README.md).
>
> **For a finance or CA review:** the live rails are **Razorpay** (primary, INR
> settlement) and **Stripe** (the request→approve booking path only). Dodo has
> never moved money and appears in no reconciliation or filing. Lemon Squeezy
> and XFlow were evaluated in March 2026, rejected, and removed from the
> codebase; they are not options.

### Stream.io (Video & Chat)

| Variable | Description | Notes |
|----------|-------------|-------|
| `NEXT_PUBLIC_STREAM_API_KEY` | Stream public API key | Same for dev/prod (shared project) |
| `STREAM_API_SECRET` | Stream server secret | Never expose client-side |
| `STREAM_SYNC_SECRET` | Stream sync webhook secret | Usually same as `STREAM_API_SECRET` |

### Notifications & Email

| Variable | Description | Notes |
|----------|-------------|-------|
| `NOVU_SECRET_KEY` | Novu notification API key | From Novu dashboard |
| `NEXT_PUBLIC_NOVU_APP_ID` | Novu application ID | Public, safe to expose |
| `RESEND_API_KEY` | Resend email API key | For transactional emails |

### Monitoring & Observability

| Variable | Description | Notes |
|----------|-------------|-------|
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry error tracking DSN | Public, safe to expose |
| `SENTRY_AUTH_TOKEN` | Sentry release/sourcemap token | Build-time only |
| `SENTRY_DSN` | Sentry server-side DSN | Same as public DSN |
| `BETTERSTACK_API_KEY` | BetterStack uptime monitoring | For status page/alerts |
| `NEXT_PUBLIC_LOGO_DEV_TOKEN` | Logo.dev API token | For company logo rendering |

### Dev/Test Only (DO NOT set on production)

| Variable | Description | Notes |
|----------|-------------|-------|
| `SEED_PASSWORD` | Password for seeded test users | Local dev only |
| `NEXT_PUBLIC_TEST_USERID` | Test user ID for dev tools | Local dev only |

</details>

### Production vs Local Checklist

When deploying to production (Netlify), ensure:

- [ ] All `localhost:3000` URLs replaced with `https://familiarisenow.com`
- [ ] `NODE_ENV` set to `production`
- [ ] `SEED_PASSWORD` and `NEXT_PUBLIC_TEST_USERID` removed
- [ ] `REDIS_URL` removed (use `UPSTASH_REDIS_REST_URL` instead)
- [ ] Payment keys switched from `test` to `live` when going live
- [ ] `BETTER_AUTH_SECRET` is a unique production secret
- [ ] No credentials committed to the repository

## Docker Commands

### Development

```bash
# Start with hot-reload
docker compose up --build

# Start in background
docker compose up -d --build

# View logs
docker compose logs -f web

# Stop
docker compose down

# Rebuild from scratch
docker compose down -v && docker compose up --build
```

### Production

```bash
# Build and run production
docker compose -f docker-compose.prod.yml up --build -d

# View logs
docker compose -f docker-compose.prod.yml logs -f

# Stop
docker compose -f docker-compose.prod.yml down
```

## Development

### Available Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run ESLint
npm run format:write # Format with Prettier
npm run studio       # Open Prisma Studio
npm run db:push      # Push schema to database
```

### Database (Prisma)

```bash
# Generate client after schema changes
npx prisma generate

# Push schema changes to Supabase
npx prisma db push

# Open database GUI
npx prisma studio
```

## Architecture

- **Framework:** Next.js 15 with App Router
- **Database:** PostgreSQL via Supabase
- **ORM:** Prisma 6
- **Auth:** NextAuth.js
- **Payments:** Stripe, Razorpay
- **Real-time:** Stream.io
- **Styling:** Tailwind CSS

[View Entity Relationship Diagram](https://claude.site/artifacts/cba3bcba-1810-49d4-93f4-2e5c63bde35e)

## Troubleshooting

### Docker Issues

**Container won't start:**

```bash
# Check logs
docker compose logs web

# Ensure .env file exists and has required variables
cat .env | grep -E "^(DATABASE_URL|NEXTAUTH)"
```

**Hot reload not working:**

```bash
# Restart with fresh volumes
docker compose down -v
docker compose up --build
```

**Prisma errors:**

```bash
# Regenerate client inside container
docker compose exec web npx prisma generate
```

### Build Issues

**bcrypt/sharp errors:**
These require native compilation. In Docker, this is handled automatically. For local development:

```bash
npm rebuild bcrypt
npm rebuild sharp
```
