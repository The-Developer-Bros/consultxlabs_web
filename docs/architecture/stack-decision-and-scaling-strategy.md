# Stack Decision & Scaling Strategy

> Why Next.js/Supabase/Vercel over Java/AWS Microservices, and the path to nationwide scale.
>
> Date: February 2026 | Stage: Pre-launch | Team: 2-3 engineers

---

## Table of Contents

1. [The Decision](#the-decision)
2. [Current Stack](#current-stack)
3. [What We Built With This Stack](#what-we-built-with-this-stack)
4. [Why This Stack Was the Right Call](#why-this-stack-was-the-right-call)
5. [The SaaS-as-Microservices Insight](#the-saas-as-microservices-insight)
6. [The Monolith vs Microservices Debate](#the-monolith-vs-microservices-debate)
7. [Why Google, Netflix, Amazon, and Flipkart Use Microservices — And Why That's Irrelevant to Us](#why-google-netflix-amazon-and-flipkart-use-microservices--and-why-thats-irrelevant-to-us)
8. [The Hidden Cost of Microservices Nobody Talks About](#the-hidden-cost-of-microservices-nobody-talks-about)
9. [Will This Stack Scale to Nationwide Users?](#will-this-stack-scale-to-nationwide-users)
10. [Where the Walls Will Appear](#where-the-walls-will-appear)
11. [What to Actually Worry About (Instead of the Stack)](#what-to-actually-worry-about-instead-of-the-stack)
12. [The Scaling Path: Monolith to Selective Microservices](#the-scaling-path-monolith-to-selective-microservices)
13. [India-Scale Reference Points](#india-scale-reference-points)
14. [Decision Framework: When to Re-evaluate](#decision-framework-when-to-re-evaluate)
15. [The Answer to "Will We Need to Rewrite Everything?"](#the-answer-to-will-we-need-to-rewrite-everything)
16. [Summary](#summary)

---

## The Decision

We chose **Next.js + Supabase + Vercel** over a **Java + AWS microservices** architecture. The primary reason was speed of execution — we needed to build a feature-rich marketplace with a 2-3 person team, not spend months on infrastructure before shipping a single feature.

This document explains why that decision was correct, what the trade-offs are, and what the path to nationwide scale looks like.

---

## Current Stack

| Layer              | Technology                                | Role                                                           |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------- |
| Frontend + Backend | Next.js 15 + React 18                     | Full-stack framework, API routes, SSR/ISR                      |
| Styling            | TailwindCSS + Radix UI                    | Component library, design system                               |
| Database           | PostgreSQL (Supabase)                     | Primary data store, connection pooling via pgbouncer           |
| ORM                | Prisma 7.3                                | Type-safe database access, migrations                          |
| Auth               | BetterAuth                                | Authentication and session management                          |
| Cache              | Upstash Redis                             | Distributed locks, maintenance state, rate limiting            |
| Video & Chat       | Stream.io                                 | Real-time video calls, messaging, presence                     |
| Payments           | Stripe + Razorpay                         | Multi-gateway payment processing (2 gateways)                  |
| Notifications      | Novu + Resend                             | Push notifications, transactional email                        |
| Storage            | Supabase Storage                          | File uploads, image hosting                                    |
| Hosting            | Vercel                                    | Edge network, serverless functions, CDN, automatic deployments |

---

## What We Built With This Stack

The current stack has enabled a single developer (with part-time help) to build:

- **60+ database models** with a 2000+ line Prisma schema
- **214 API routes** covering all business logic
- **102 page components** across 4 user role dashboards
- **4 user roles:** Consultant, Consultee, Staff, Admin
- **4 service types:** Consultations, Subscriptions, Webinars, Classes
- **4 payment gateways** with multi-currency support
- **Integrated video/chat** via Stream.io (not Zoom links — a key differentiator)
- **Document review system** (unique feature vs competitors)
- **Trial sessions** with conversion tracking
- **Request approval workflows**
- **25+ cron/cleanup jobs** for maintenance
- **35+ enums** managing complex business state

With a Java/AWS microservices architecture, this would have taken **3-4x longer** at minimum. We'd still be setting up Kubernetes, writing service boilerplate, and configuring inter-service communication instead of building features users care about.

---

## Why This Stack Was the Right Call

### The constraint that matters most: team size

The entire architecture discussion boils down to one variable: **how many engineers do you have?**

| Team Size       | Right Architecture           | Why                                                                  |
| --------------- | ---------------------------- | -------------------------------------------------------------------- |
| 1-5 engineers   | Monolith (framework-based)   | One person can understand and deploy the entire system               |
| 5-15 engineers  | Modular monolith             | Clear domain boundaries, but still one deployable unit               |
| 15-50 engineers | Selective service extraction | Extract only the components that need independent scaling/deployment |
| 50+ engineers   | Microservices                | Teams need independent deployment cycles, separate codebases         |

We have 2-3 engineers. A monolith built on a productive full-stack framework (Next.js) is objectively the correct choice at this stage. Choosing microservices would have been **premature architecture** — solving problems we don't have at the expense of velocity on problems we do have.

### Speed to market > theoretical scale

TopMate (our #1 competitor) didn't start on a "scalable enterprise stack." They started on what shipped fastest. By the time scale is a problem, they had revenue to fund engineering solutions. That's the playbook.

### The alternative would have looked like this

If we had chosen Java + AWS microservices:

```
Month 1-2: Setting up AWS (VPC, ECS/EKS, RDS, ElastiCache, S3, CloudFront, IAM roles)
Month 2-3: Kubernetes configuration, service mesh, CI/CD per service
Month 3-4: API gateway, service discovery, distributed tracing
Month 4-5: Authentication service, user service, basic CRUD
Month 5-6: Maybe one feature complete, zero users, money running out
```

What we actually did:

```
Month 1-2: Core models, auth, basic UI, first API routes
Month 2-4: All 4 service types, payments, video integration
Month 4-6: Dashboards, booking flows, notifications, polish
Result: Complete product, ready for users
```

---

## The SaaS-as-Microservices Insight

A key architectural insight that's easy to miss: **offloading to SaaS providers IS a microservices strategy.** We just didn't write the services ourselves.

| Domain        | What a DIY Microservice Looks Like                                                                                  | What We Did Instead                |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Video/Chat    | Build & host WebRTC infra, TURN/STUN servers, media servers, chat storage, presence system                          | Stream.io handles all of it        |
| Database      | Manage Postgres instances, configure replicas, handle backups, set up connection pooling, monitor query performance | Supabase handles all of it         |
| Payments      | PCI-DSS compliance, payment routing, reconciliation, refund handling, multi-currency                                | Stripe/Razorpay handle all of it   |
| Email         | SMTP infrastructure, deliverability optimization, bounce handling, spam compliance                                  | Resend handles all of it           |
| Notifications | Push notification infra, delivery tracking, preference management, multi-channel routing                            | Novu handles all of it             |
| CDN/Edge      | CloudFront/CloudFlare setup, origin configuration, cache invalidation, edge compute                                 | Vercel handles all of it           |
| File Storage  | S3 buckets, access policies, CDN integration, image transformation                                                  | Supabase Storage handles all of it |

We get the core benefits of microservices:

- **Fault isolation:** If Stream.io goes down, payments still work
- **Independent scaling:** Supabase scales the DB independently from Vercel's serverless functions
- **Specialized teams:** Stream.io has a dedicated team making video better; Stripe has thousands of engineers on payments

The trade-off is **cost at scale, not capability.** We're paying money (or using free tiers) instead of engineering time. At our stage, engineering time is worth infinitely more than the cost of these services.

---

## The Monolith vs Microservices Debate

### Every major company started as a monolith

This is the most important table in this document:

| Company            | What They Started With                     | When They Moved to Microservices                   | What Triggered the Move                                                                                                                         |
| ------------------ | ------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Amazon**         | Perl/C monolith                            | ~2001, after **7 years** of operation              | 200+ engineers couldn't deploy without conflicts. Jeff Bezos issued the "API mandate" — not for performance, but for team independence          |
| **Netflix**        | Java monolith running on a data center     | ~2008, after the DVD-to-streaming pivot            | Fundamentally different infrastructure needs (streaming video vs inventory management). Also, a data center outage took them offline for 3 days |
| **Google**         | Python/C monolith (original search engine) | Gradually, over many years                         | Billions of queries/day, thousands of engineers, services with wildly different resource profiles                                               |
| **Flipkart**       | Single PHP application on a shared host    | ~2011, after scaling past millions of orders       | Teams blocking each other on deployments, different parts of the system needing different scaling                                               |
| **Twitter**        | Ruby on Rails monolith                     | ~2010-2012, the "Fail Whale" era                   | 200M+ tweets/day, the monolith literally couldn't handle the write throughput                                                                   |
| **Shopify**        | Ruby on Rails monolith                     | **They never fully did.** Still a modular monolith | $7B+ revenue, 10,000+ engineers, and a monolith still works for them                                                                            |
| **Basecamp**       | Ruby on Rails monolith                     | **Never.** Still a monolith                        | Multi-million dollar business, small team, monolith is a feature not a bug                                                                      |
| **Stack Overflow** | ASP.NET monolith                           | **Never.** Still a monolith                        | Serves 100M+ monthly visitors on a few servers                                                                                                  |

**Not a single one chose microservices on day one.** They all started with the simplest thing that worked and evolved their architecture when real, measurable problems forced the change.

---

## Why Google, Netflix, Amazon, and Flipkart Use Microservices — And Why That's Irrelevant to Us

### The numbers tell the story

| Metric                             | Familiarise (Today) | When Microservices Make Sense                                                        |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| Engineers                          | 2-3                 | 50+ (teams need independent deployability)                                           |
| Daily Active Users                 | 0 (pre-launch)      | 100K+ (single DB can't handle the read/write mix)                                    |
| Deploys per day                    | 1-3                 | 50+ (teams blocking each other on deploys)                                           |
| Services needing different scaling | 0                   | 5+ (payments spike at month-end, search spikes at peak hours, video needs GPU infra) |
| Revenue                            | ₹0                  | Enough to afford the operational overhead of running 10-50 services                  |
| Downtime cost                      | Nobody notices      | Millions per minute (Amazon loses ~$220K/minute during outages)                      |

We are off by **multiple orders of magnitude** on every metric. Adopting microservices now would be like buying a commercial kitchen to make dinner for two people.

### Microservices solve organizational problems, not performance problems

This is the most common misconception in the industry. Here's what microservices actually solve:

**1. Team Independence (the primary reason)**

When Amazon had 200+ engineers working on one monolith, deploying took days. One team's change broke another team's feature. Merge conflicts were a full-time job. The "API mandate" (every team must expose functionality through APIs) was about **letting teams ship independently**, not about making the system faster.

With 2-3 people, we don't have deployment conflicts. We don't have merge conflicts between teams. We ARE the team. This problem literally doesn't exist for us.

**2. Independent Scaling**

Netflix scales their recommendation engine (CPU-intensive, needs GPUs) separately from video encoding (also GPU-intensive, but different GPUs) separately from user authentication (memory-intensive, needs fast lookups) separately from content delivery (bandwidth-intensive, needs edge servers). These components have **fundamentally different resource profiles** and need to scale on different axes.

Our marketplace doesn't have components with wildly different scaling profiles. Listing experts, showing programs, processing bookings — these are all "read from Postgres, render HTML" workloads. They scale the same way.

**3. Fault Isolation**

If Amazon's recommendation service crashes, you can still buy products. If their payment service is slow, search still works. Each failure is contained to one service.

For us, if the app goes down, the app goes down. At pre-launch with zero users, this is a complete non-issue. When we have paying users who depend on uptime, Vercel and Supabase's SLAs cover us better than we could cover ourselves.

---

## The Hidden Cost of Microservices Nobody Talks About

Microservices aren't free. They introduce enormous operational overhead that's rarely discussed honestly:

### What changes when you go from monolith to microservices

| What Was Simple                                                       | What It Becomes                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Function call** between modules                                     | HTTP/gRPC call with serialization, network latency, retries, timeouts, circuit breakers                                 |
| **Database transaction** (create user + profile + send welcome email) | Distributed saga pattern or two-phase commit across 3 services with compensation logic for failures                     |
| **Debugging** (read the stack trace)                                  | Distributed tracing (Jaeger/Zipkin), correlation IDs, centralized logging (ELK stack), service dependency maps          |
| **Deployment** (push to main)                                         | Per-service CI/CD pipelines, canary deployments, blue-green rollouts, service version compatibility matrices            |
| **Database query** (JOIN across tables)                               | API choreography — Service A calls Service B which calls Service C, each with its own DB                                |
| **Local development** (npm run dev)                                   | Docker Compose with 10+ services, or a shared staging environment, or service mocks                                     |
| **Monitoring** (check the logs)                                       | Service mesh (Istio/Linkerd), distributed metrics (Prometheus/Grafana per service), health checks, alerting per service |
| **Testing** (run the test suite)                                      | Contract testing between services, integration test environments, service virtualization                                |

### The time allocation shift

**In a monolith (current):**

- ~80% of time: Building features
- ~20% of time: Infrastructure, deployment, debugging

**In microservices (hypothetical):**

- ~30-40% of time: Building features
- ~60-70% of time: Infrastructure, inter-service communication, deployment pipelines, distributed debugging, operational overhead

Netflix has **entire dedicated teams** just for their deployment platform. Amazon has teams that do nothing but build internal infrastructure tooling. We'd be one developer doing all of that AND building features. The math doesn't work.

### What it would cost us

A rough estimate of the AWS infrastructure for a comparable microservices setup:

| Service                  | Monthly Cost (minimal)           |
| ------------------------ | -------------------------------- |
| EKS (Kubernetes)         | $73+ (control plane) + EC2 nodes |
| RDS (Postgres)           | $50-200+                         |
| ElastiCache (Redis)      | $25-100+                         |
| ALB (Load Balancer)      | $20+ per service                 |
| ECR (Container Registry) | $10+                             |
| CloudWatch (Monitoring)  | $50+                             |
| S3 + CloudFront          | $20+                             |
| NAT Gateway              | $32+ (often forgotten)           |
| **Total**                | **$300-600+/mo minimum**         |

Current cost on managed stack: **~₹10K/mo (~$110)** for all SaaS combined. The microservices approach would cost 3-5x more in infrastructure alone, before counting the engineering time to manage it.

---

## Will This Stack Scale to Nationwide Users?

**Yes. Further than you'd think — but not infinitely without optimization.**

### What scales fine as-is

| Component                                 | Approximate Ceiling             | Why It Scales                                                                      |
| ----------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| Vercel (Edge + Serverless)                | ~100K+ concurrent users         | Auto-scales serverless functions, CDN serves static assets from 70+ edge locations |
| Supabase Postgres (with pgbouncer pooler) | ~10K-50K concurrent connections | Already configured with connection pooling on port 6543                            |
| Stream.io                                 | Their infrastructure handles it | Dedicated video/chat platform designed for millions of concurrent connections      |
| Stripe/Razorpay                           | Effectively unlimited           | Battle-tested payment infrastructure processing billions of dollars                |
| Next.js with ISR/SSG                      | Very high                       | Static and ISR pages served from CDN edge — near-zero server cost per request      |
| Upstash Redis                             | ~100K+ commands/sec             | Serverless Redis, auto-scales with demand                                          |
| Supabase Storage                          | High                            | CDN-backed file storage                                                            |

For context, **Stack Overflow serves 100M+ monthly visitors on a few physical servers running a .NET monolith.** Our stack, which auto-scales and runs on global edge infrastructure, can handle far more than we'll see in the first several years.

---

## Where the Walls Will Appear

There are four scaling walls we'll eventually hit. Each has a known fix that doesn't require re-architecting:

### Wall 1: Serverless Cold Starts (~1K-5K concurrent users)

Vercel serverless functions have cold start latency of 100-500ms. Under sustained load, functions stay warm and this isn't a problem. Under bursty traffic (e.g., a marketing campaign drives a spike), users will experience inconsistent response times.

**Fix (no re-architecture needed):**

- Implement ISR/static generation for all public pages (landing, explore, expert profiles)
- Add server-side caching with `unstable_cache()` or Redis
- Use Vercel's edge runtime for lightweight hot paths
- These are the same fixes needed for the current performance issues (see GitHub Issue #450)

### Wall 2: Single Database Bottleneck (~10K-50K DAU)

This isn't a Supabase-specific issue — **any single Postgres instance** will eventually bottleneck when handling complex joins across 60+ models with high concurrent read/write traffic.

**Fix (no re-architecture needed):**

- Read replicas (Supabase Pro+ supports this) — route read-heavy queries to replicas
- Redis caching layer for frequently accessed data (expert lists, metadata, reviews)
- Query optimization — selective includes instead of deep nested joins
- Connection pool tuning
- Eventually, consider partitioning hot tables

### Wall 3: SaaS Cost Cliffs

Known cost inflection points:

- **Stream.io:** Free tier → ~₹36K/mo ($400/mo) when hitting ₹8.5L revenue, $100K funding, or >5 team members
- **Vercel:** Costs scale with serverless invocations, $500-2000+/mo at high traffic
- **Supabase:** Free → $25/mo Pro tier is manageable; higher tiers scale with usage

**Fix:** This is a business problem, not a technical one. If traffic is high enough to trigger these costs, revenue should be covering them. The unit economics were analyzed in `docs/finances/11-cfo-master-plan.md`.

### Wall 4: Vercel Costs Exceed Self-Hosting (~100K+ MAU)

At very high scale, managed platforms charge a premium over self-hosted alternatives. When the Vercel bill exceeds the engineering cost of managing your own infrastructure, it's time to move.

**Fix (no code rewrite needed):**

- Next.js runs anywhere — migrate to self-hosted on AWS (EC2/ECS), Railway, Fly.io, or a VPS
- No code changes required, just deployment configuration
- This is the correct time to consider AWS — when you have the traffic and revenue to justify the operational overhead

---

## What to Actually Worry About (Instead of the Stack)

The stack isn't the bottleneck. These things are:

### 1. Current Performance Issues (Immediate)

The pages are slow right now due to architectural patterns within the app (client-side rendering, over-fetching, no caching), not the stack itself. These affect user conversion today and are tracked in GitHub Issue #450. Fixing them is higher priority than any scaling concern.

### 2. No Mobile Story

Scaling nationwide in India means **mobile-first**. The majority of India's internet users are mobile-only. There's currently no mobile app — not even a PWA. This should be on the roadmap well before any discussion of microservices:

- **Phase 1:** PWA with offline support
- **Phase 2:** React Native / Expo wrapper (shares React knowledge from the current codebase)

### 3. Single Point of Failure on Supabase

If Supabase has an outage, the entire app goes down. This is the trade-off of managed infrastructure. Mitigations:

- Regular automated database backups (Supabase does daily backups on Pro)
- Have a disaster recovery plan: ability to point the app at a different Postgres instance
- Monitor Supabase status page proactively

### 4. Vendor Lock-in Assessment

Good news — vendor lock-in is actually minimal:

- **Supabase** = standard Postgres. Can migrate to any Postgres host (RDS, Neon, self-hosted) with `pg_dump`
- **Next.js** = runs anywhere. Not locked to Vercel (can deploy on AWS, Railway, Fly.io, Docker)
- **Prisma** = generates standard SQL. Can switch ORMs without changing the database
- **Stream.io** = this is the stickiest dependency. But it's a deliberate trade-off (building video/chat infra in-house would take 6+ months)
- **Stripe/Razorpay** = standard payment APIs. Can add or swap gateways (we already have 4)

---

## The Scaling Path: Monolith to Selective Microservices

```
Stage 1: Launch (Now)
│
│   Architecture: Monolith (Next.js full-stack)
│   Focus: Ship features, get users, validate product-market fit
│   Team: 2-3 people
│   Users: 0 → first 1,000
│   Key work: Launch, iterate on user feedback, fix critical bugs
│
▼
Stage 2: Optimized Monolith (~1K DAU)
│
│   Architecture: Same monolith, with performance optimizations
│   Focus: SSR/ISR for public pages, Redis caching, query optimization
│   Team: 3-5 people
│   Users: 1K → 10K
│   Key work: Convert client components to server components,
│             add caching layers, optimize Prisma queries,
│             implement proper HTTP cache headers
│
▼
Stage 3: Modular Monolith (~10K DAU)
│
│   Architecture: Clear domain boundaries within the monolith
│   Focus: Separate admin dashboard, read replicas, CDN optimization
│   Team: 5-10 people
│   Users: 10K → 50K
│   Key work: Organize API routes into clear domain modules,
│             add database read replicas, possibly separate
│             admin dashboard as its own deployment,
│             add PWA or mobile app
│
▼
Stage 4: First Service Extraction (~50K+ DAU)
│
│   Architecture: Extract the component that breaks first
│   Focus: Independent scaling for hot paths
│   Team: 10-15 people
│   Users: 50K → 100K+
│   Key work: Likely extract notifications or analytics as
│             independent services. Video/chat is already
│             external (Stream.io). Payments already external
│             (Stripe/Razorpay). Identify what's actually
│             bottlenecking and extract only that.
│
▼
Stage 5: Selective Microservices (~100K+ DAU, 15+ engineers)
│
│   Architecture: Services extracted as needed, not wholesale
│   Focus: Team independence, independent deployability
│   Team: 15+ people across multiple squads
│   Users: 100K+
│   Key work: Teams own services along domain boundaries.
│             NOT a rewrite — gradual extraction of pieces
│             that need independent scaling or deployment.
│             Many parts may stay as the original monolith.
```

**Critical principle: don't jump stages.** Each stage unlocks naturally when the previous stage's constraints become the bottleneck. Many successful companies (Shopify, Basecamp, Stack Overflow, Craigslist) never go past Stage 3 and operate profitably at massive scale.

---

## India-Scale Reference Points

Companies operating at significant scale in India, and what stacks they used:

| Company        | Starting Stack                | Current Stack                       | Scale                                    | Key Insight                                                                                                               |
| -------------- | ----------------------------- | ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Zerodha**    | PHP → Go + Postgres           | Go + Postgres + Kite platform       | 10M+ users, India's #1 broker            | Never adopted Java microservices. Go monolith handles millions of trades/day                                              |
| **Razorpay**   | Ruby on Rails                 | Gradually extracted services in Go  | Millions of transactions                 | Started as a Rails monolith. Extracted payment processing into Go services only when Rails couldn't handle the throughput |
| **TopMate**    | JS/TS stack (similar to ours) | Still JS/TS based                   | Direct competitor, Indian creator market | Our #1 competitor runs on a comparable stack                                                                              |
| **Freshworks** | Ruby on Rails monolith        | Gradually modularized               | $500M+ ARR, 5000+ employees              | Ran as a Rails monolith for years. Didn't adopt microservices until they had hundreds of engineers                        |
| **Postman**    | Node.js                       | Node.js + Electron + cloud services | 25M+ users                               | One of India's most valuable startups, built on Node.js                                                                   |
| **Unacademy**  | Python/Django                 | Gradually evolved                   | Millions of learners                     | EdTech at India scale, didn't start with microservices                                                                    |

**Common pattern:** Every single one started with the simplest stack that shipped product. They evolved their architecture in response to measured bottlenecks, funded by the revenue their working product generated. None of them sat at the whiteboard designing a microservices architecture before they had users.

---

## Decision Framework: When to Re-evaluate

Don't re-evaluate the architecture on a schedule. Re-evaluate when you observe these specific signals:

| Signal You'll Observe                                                                                                                             | What It Means                                                    | Appropriate Action                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Deploy conflicts between team members become a daily frustration                                                                                  | Team size has outgrown the monolith's deployment model           | Extract services along team boundaries                                                              |
| Database query latency consistently > 500ms under normal load                                                                                     | Single Postgres instance is the bottleneck                       | Read replicas, Redis caching, query optimization (not microservices)                                |
| Vercel monthly bill exceeds the cost of one engineer managing infra                                                                               | Managed platform pricing has crossed the self-hosting break-even | Migrate to self-hosted Next.js on AWS/Railway                                                       |
| A specific component needs fundamentally different infrastructure (e.g., ML-based recommendations need GPU, real-time search needs Elasticsearch) | Different scaling profile from the rest of the app               | Extract that one component as an independent service                                                |
| Multiple teams (3+) need to deploy different parts of the app on independent schedules                                                            | Organizational scaling has outgrown shared deployment            | Begin modular monolith → service extraction                                                         |
| A component's failure cascades to unrelated parts of the app and this causes real revenue loss                                                    | Fault isolation has become business-critical                     | Extract the problematic component behind an API boundary                                            |
| You're spending more than 50% of engineering time on operational issues                                                                           | Infrastructure overhead has overtaken feature development        | Evaluate whether managed services or service extraction would help (usually managed services first) |

**Until multiple of these signals appear simultaneously, optimizing the current architecture yields dramatically better ROI than re-architecting.**

---

## The Answer to "Will We Need to Rewrite Everything?"

**No.** Here's why:

1. **Monolith to microservices is a spectrum, not a binary switch.** You don't wake up one day and rewrite everything in Java. You identify the single component that's bottlenecking, extract it behind an API, and scale it independently. The rest stays as-is.

2. **Next.js API routes are already a modular monolith in practice.** The 214 API routes are organized by domain (`/api/user/`, `/api/plans/`, `/api/payments/`, `/api/dashboard/`). If `/api/payments/` becomes a bottleneck, you extract it into a standalone service. You don't rewrite the user dashboard.

3. **The SaaS approach already handles the hardest parts.** The components most likely to need independent scaling — video (Stream.io), payments (Stripe/Razorpay), email (Resend), caching (Upstash) — are already external services. What's left in the monolith is relatively straightforward CRUD and business logic.

4. **The database is portable.** Supabase is standard Postgres. Prisma generates standard SQL. If we need to move to RDS, Neon, or self-hosted Postgres, it's a connection string change plus minor configuration.

5. **The frontend is portable.** Next.js runs on Vercel, AWS, Railway, Fly.io, Docker, or bare metal. Leaving Vercel is a deployment config change, not a rewrite.

6. **The precedent is clear.** Shopify runs a $7B business on a Ruby on Rails modular monolith. Stack Overflow serves 100M+ users on a .NET monolith. Basecamp built a multi-million dollar business on Rails and explicitly chose NOT to adopt microservices. The monolith works until it doesn't, and "it doesn't" is a much higher bar than most engineers think.

---

## Summary

The Next.js/Supabase/Vercel stack was the correct choice for a pre-launch marketplace with a 2-3 person team. Choosing Java/AWS microservices would have been premature architecture — solving problems we don't have at the expense of velocity on problems we do have.

The stack will scale to tens of thousands of daily active users with standard optimizations (server-side rendering, caching, read replicas, query optimization). The path to nationwide scale is **incremental service extraction driven by real, measured bottlenecks** — not a speculative wholesale rewrite to microservices.

Every major tech company started as a monolith. They adopted microservices when they had thousands of engineers, billions of users, and services with fundamentally different scaling needs. When we have those problems, we'll have the revenue and team size to solve them. Until then, the architecture should match the team and stage, not the aspiration.

**The highest-ROI work right now is not re-architecting. It's shipping the product, getting users, and fixing the performance issues in the monolith we already have.** That's what will make users stay. And staying users are what create the need for scale — which is the best problem a startup can have.
