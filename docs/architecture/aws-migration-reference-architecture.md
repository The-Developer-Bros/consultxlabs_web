# Reference Architecture: AWS Migration Plan (Next.js → Spring Boot + AWS)

> Migrated from GitHub Issue #410 (2026-02-01). This is a **forward-looking reference architecture**, not an immediate action item. Useful for understanding how the current managed SaaS stack maps to AWS-native services, and as a blueprint if the platform ever needs enterprise compliance (SOC 2, HIPAA, data residency) or scaling beyond 100K users.

---

## Overview

This issue documents the complete architecture plan for migrating the Familiarise platform from the current managed SaaS stack (Next.js + Supabase + Stream.io + Novu + Resend + ConvertKit + Directus) to a **Spring Boot + AWS-native** architecture.

> **Decision context**: This is a forward-looking reference architecture, not an immediate action item. The current stack is appropriate for MVP and early growth. This migration would be justified when the platform needs enterprise compliance (SOC 2, HIPAA, data residency), predictable scaling beyond 100K users, or the team shifts to Java-heavy.

---

## Current Stack → AWS Equivalent Mapping

```
CURRENT STACK → AWS EQUIVALENT MAPPING
═══════════════════════════════════════

┌──────────────────────────────┬────────────────────────────────────────────┐
│  CURRENT                     │  AWS REPLACEMENT                          │
├──────────────────────────────┼────────────────────────────────────────────┤
│  Next.js (fullstack)         │  Spring Boot (backend)                    │
│                              │  + React SPA on S3/CloudFront (frontend)  │
│  Prisma ORM                  │  Spring Data JPA + Hibernate              │
│  Prisma Migrate              │  Flyway or Liquibase                      │
│  Supabase PostgreSQL         │  Amazon RDS Aurora PostgreSQL             │
│  Supabase Storage            │  Amazon S3                                │
│  Supabase Realtime           │  API Gateway WebSockets + Lambda          │
│  BetterAuth / NextAuth       │  Amazon Cognito (OAuth, SAML, OIDC)      │
│  Directus CMS                │  Self-hosted on ECS or Amplify CMS       │
│  ConvertKit                  │  Amazon Pinpoint (email marketing)        │
│  Resend                      │  Amazon SES (transactional email)         │
│  Novu                        │  EventBridge + SNS + SQS + Lambda        │
│  Stream.io Video             │  Amazon Chime SDK                         │
│  Stream.io Chat              │  AppSync GraphQL Subscriptions            │
│  Stream.io Recordings        │  Chime media pipelines → S3              │
│  Stripe / Razorpay           │  Stripe / Razorpay (no AWS equivalent)   │
│  Upstash Redis               │  Amazon ElastiCache (Redis)              │
│  Netlify (hosting)           │  S3 + CloudFront + ECS Fargate           │
│  PostHog (analytics)         │  Amazon Pinpoint + CloudWatch             │
│  Sentry (errors)             │  AWS X-Ray + CloudWatch Logs             │
│  Intercom (support chat)     │  Amazon Connect                          │
│  Cron Jobs (Netlify)         │  EventBridge Scheduler + Lambda          │
│  Vercel Edge / Middleware     │  CloudFront Functions + Lambda@Edge      │
└──────────────────────────────┴────────────────────────────────────────────┘
```

---

## Full AWS Architecture

### Clients → Edge → Routing

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                      CLIENTS                                                  │
│                                                                                               │
│    Browser (React SPA)        Mobile App (Flutter)        Enterprise IdP (Okta/Azure AD)     │
└──────────┬────────────────────────┬─────────────────────────────┬────────────────────────────┘
           │                        │                             │
           ▼                        ▼                             │
┌──────────────────────────────────────────────────┐              │
│              AMAZON CLOUDFRONT (CDN)              │              │
│                                                   │              │
│  • Serves React SPA from S3                      │              │
│  • Caches API responses at edge                  │              │
│  • CloudFront Functions (redirects, headers)     │              │
│  • Lambda@Edge (auth token validation, A/B test) │              │
│  • WAF integration (rate limiting, IP blocking)  │              │
└──────────────────┬───────────────────────────────┘              │
                   │                                              │
                   ▼                                              │
┌──────────────────────────────────────────────────┐              │
│          AWS WAF + SHIELD (Security)             │              │
│                                                   │              │
│  • Rate limiting (replaces Upstash rate limit)   │              │
│  • DDoS protection                               │              │
│  • SQL injection / XSS prevention                │              │
│  • Geo-blocking rules                            │              │
└──────────────────┬───────────────────────────────┘              │
                   │                                              │
                   ▼                                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                            APPLICATION LOAD BALANCER (ALB)                                    │
│                                                                                               │
│  Path-based routing:                                                                          │
│    /api/*           → Spring Boot (ECS Fargate)                                              │
│    /auth/*          → Amazon Cognito hosted UI                                                │
│    /ws/*            → API Gateway WebSocket                                                   │
│    /cms/*           → Directus (ECS Fargate)                                                 │
│    /chime/*         → Amazon Chime SDK endpoints                                             │
└───────┬─────────────────────┬────────────────────┬──────────────────────┬────────────────────┘
        │                     │                    │                      │
        ▼                     ▼                    ▼                      ▼
```

---

### The Core Backend Services

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                              ECS FARGATE CLUSTER (Serverless Containers)                      │
│                              (replaces Netlify serverless functions)                          │
│                                                                                               │
│  ┌───────────────────────────────────────────────────────────┐   ┌─────────────────────────┐ │
│  │              SPRING BOOT APPLICATION                       │   │   DIRECTUS CMS          │ │
│  │              (Main Backend Service)                        │   │   (Content Service)     │ │
│  │                                                            │   │                         │ │
│  │  ┌──────────────────────┐  ┌────────────────────────────┐ │   │  • Blog management     │ │
│  │  │  Spring Security     │  │  Controllers (REST API)    │ │   │  • Community threads   │ │
│  │  │  + Cognito JWT       │  │                            │ │   │  • Media uploads → S3  │ │
│  │  │                      │  │  /api/consultations/**     │ │   │  • Webhooks on publish │ │
│  │  │  • JWT validation    │  │  /api/subscriptions/**     │ │   │  • Admin panel UI      │ │
│  │  │  • Role extraction   │  │  /api/payments/**          │ │   │                         │ │
│  │  │  • RBAC filters      │  │  /api/organizations/**     │ │   │  Connects to:          │ │
│  │  │  • Method security   │  │  /api/recordings/**        │ │   │  Aurora (cms schema)   │ │
│  │  └──────────────────────┘  │  /api/support/**           │ │   │  S3 (media)            │ │
│  │                            │  /api/payouts/**            │ │   └─────────────────────────┘ │
│  │  ┌──────────────────────┐  │  /api/staff/**              │ │                               │
│  │  │  Spring Data JPA     │  │  /api/admin/**              │ │   ┌─────────────────────────┐ │
│  │  │  + Hibernate         │  └────────────────────────────┘ │   │   WORKER SERVICE        │ │
│  │  │                      │                                  │   │   (Spring Boot)         │ │
│  │  │  • Entity mappings   │  ┌────────────────────────────┐ │   │                         │ │
│  │  │  • JPA repositories  │  │  Service Layer             │ │   │  Consumes SQS queues:  │ │
│  │  │  • Query methods     │  │                            │ │   │  • Email queue          │ │
│  │  │  • Flyway migrations │  │  ConsultationService       │ │   │  • Notification queue   │ │
│  │  │  • Connection pool   │  │  SubscriptionService       │ │   │  • Payout queue         │ │
│  │  │    (HikariCP)        │  │  PaymentService            │ │   │  • Recording transfer   │ │
│  │  └──────────────────────┘  │  OrganizationService       │ │   │  • Webhook processing   │ │
│  │                            │  PayoutService              │ │   │                         │ │
│  │  ┌──────────────────────┐  │  RecordingService           │ │   │  Scheduled tasks:       │ │
│  │  │  AWS SDK for Java    │  │  NotificationService        │ │   │  • Auto-complete appts  │ │
│  │  │                      │  │  ModerationService          │ │   │  • Tentative cleanup    │ │
│  │  │  • S3 client         │  │  VerificationService        │ │   │  • Stale pending cleanup│ │
│  │  │  • SES client        │  └────────────────────────────┘ │   │  • Earning reconcile    │ │
│  │  │  • SNS client        │                                  │   │  • Recording transfer   │ │
│  │  │  • Cognito client    │  ┌────────────────────────────┐ │   └─────────────────────────┘ │
│  │  │  • Chime client      │  │  WebSocket Handlers        │ │                               │
│  │  │  • EventBridge client│  │  (STOMP over WebSocket)    │ │                               │
│  │  └──────────────────────┘  │                            │ │                               │
│  │                            │  • Chat messages            │ │                               │
│  │                            │  • Typing indicators        │ │                               │
│  │                            │  • Presence (online/offline)│ │                               │
│  │                            │  • Real-time notifications  │ │                               │
│  │                            └────────────────────────────┘ │                               │
│  └───────────────────────────────────────────────────────────┘                               │
│                                                                                               │
│  Auto-scaling: Min 2 tasks, max 10 (CPU/memory based)                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### Authentication and Authorization

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                           AMAZON COGNITO (Replaces BetterAuth)                                │
│                                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  USER POOL                                                                               │ │
│  │                                                                                          │ │
│  │  B2C Authentication:                    Enterprise SSO:                                   │ │
│  │  • Email/password signup               • SAML 2.0 federation (Okta, Azure AD, OneLogin) │ │
│  │  • Google OAuth                        • OIDC federation                                 │ │
│  │  • GitHub OAuth                        • Per-org identity provider mapping               │ │
│  │  • Facebook OAuth                      • Auto-provisioning to org on first SSO login     │ │
│  │  • MFA (TOTP, SMS)                     • JIT (Just-In-Time) user creation                │ │
│  │                                                                                          │ │
│  │  Custom attributes:                     Groups (→ RBAC):                                  │ │
│  │  • custom:role                          • CONSULTEE                                       │ │
│  │  • custom:consultantProfileId           • CONSULTANT                                      │ │
│  │  • custom:consulteeProfileId            • STAFF                                           │ │
│  │  • custom:organizationId                • ADMIN                                           │ │
│  │  • custom:orgRole (MemberRole)          • ORG_WORKSPACE                                       │ │
│  │    OWNER/MAINTAINER/MANAGER/            • (MemberRole scoped to Membership row,           │ │
│  │    EXPERT/LEARNER/SUPPORT                 not Cognito groups)                             │ │
│  │  Triggers (Lambda):                                                                       │ │
│  │  • Pre-signup: validate, block disposable emails                                          │ │
│  │  • Post-confirm: create User record in Aurora, sync to Pinpoint                          │ │
│  │  • Pre-token: inject custom claims (role, profileIds, orgId)                             │ │
│  │  • Post-auth: update lastLoginAt, log activity                                            │ │
│  └──────────────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                               │
│  Spring Security integration:                                                                 │
│    @EnableWebSecurity                                                                         │
│    JwtDecoder → Cognito JWKS endpoint                                                        │
│    @PreAuthorize("hasRole('CONSULTANT')") on controller methods                              │
│    Custom OrganizationPermissionEvaluator for org-level RBAC                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### The Data Layer

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    DATA LAYER                                                 │
│                                                                                               │
│  ┌────────────────────────────────────────────┐   ┌────────────────────────────────────────┐ │
│  │  AMAZON AURORA POSTGRESQL (Serverless v2)   │   │  AMAZON ELASTICACHE (Redis)            │ │
│  │  (Replaces Supabase PostgreSQL)             │   │  (Replaces Upstash Redis)              │ │
│  │                                             │   │                                        │ │
│  │  "public" schema (Spring Data JPA):         │   │  • Session cache                      │ │
│  │    User, ConsultantProfile,                 │   │  • Rate limiting counters              │ │
│  │    ConsulteeProfile, StaffProfile,          │   │  • Slot lock (distributed locking)     │ │
│  │    AdminProfile, Organization,              │   │  • API response cache                  │ │
│  │    OrgMember, Consultation,                 │   │  • Consultant availability cache       │ │
│  │    Subscription, Payment, Payout,           │   │  • User online presence                │ │
│  │    Recording, MeetingSession,               │   │                                        │ │
│  │    ...51+ entities (JPA @Entity)            │   │  Spring Boot integration:              │ │
│  │                                             │   │    spring-boot-starter-data-redis      │ │
│  │  "cms" schema (Directus):                   │   │    @Cacheable, @CacheEvict             │ │
│  │    cms_posts, cms_categories,               │   │    RedisTemplate for locks             │ │
│  │    cms_threads, cms_replies,                │   │                                        │ │
│  │    directus_* system tables                 │   └────────────────────────────────────────┘ │
│  │                                             │                                              │
│  │  Flyway migrations:                         │   ┌────────────────────────────────────────┐ │
│  │    V1__initial_schema.sql                   │   │  AMAZON S3 (Object Storage)            │ │
│  │    V2__add_enterprise_models.sql            │   │  (Replaces Supabase Storage)           │ │
│  │    V3__add_recording_collections.sql        │   │                                        │ │
│  │    ...                                      │   │  Buckets:                              │ │
│  │                                             │   │  • familiarise-profiles/               │ │
│  │  Features:                                  │   │  • familiarise-documents/              │ │
│  │  • Auto-scaling (0 → 64 ACUs)              │   │  • familiarise-recordings/             │ │
│  │  • Read replicas for dashboard queries      │   │  • familiarise-blog-media/             │ │
│  │  • Automated backups (35-day retention)     │   │  • familiarise-invoices/               │ │
│  │  • Global database for multi-region         │   │                                        │ │
│  │                                             │   │  • Pre-signed URLs for uploads         │ │
│  │  Connection:                                │   │  • CloudFront distribution for reads   │ │
│  │    HikariCP pool (min 5, max 20)            │   │  • Lifecycle rules (recording expiry)  │ │
│  │    IAM auth (no password in config)         │   │  • S3 Event → Lambda (post-processing) │ │
│  └────────────────────────────────────────────┘   └────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### The Notification and Email System (Replacing Novu + Resend + ConvertKit)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                    NOTIFICATION & EMAIL SYSTEM (All AWS)                                      │
│                    (Replaces Novu + Resend + ConvertKit)                                      │
│                                                                                               │
│                                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────────────────────┐    │
│   │                    AMAZON EVENTBRIDGE (Event Bus)                                    │    │
│   │                    (Replaces Novu's orchestration brain)                             │    │
│   │                                                                                      │    │
│   │  Spring Boot publishes events:                                                       │    │
│   │    "consultation.booked"    "payment.succeeded"     "org.member.invited"             │    │
│   │    "consultation.completed" "payout.completed"      "org.seat.threshold"             │    │
│   │    "subscription.approved"  "recording.ready"       "blog.post.published"            │    │
│   │    "trial.converted"        "dispute.opened"        "community.reply.created"        │    │
│   │                                                                                      │    │
│   │  EventBridge Rules route each event to appropriate targets:                          │    │
│   └──────┬──────────────────────┬────────────────────────┬───────────────────────────────┘    │
│          │                      │                        │                                    │
│          ▼                      ▼                        ▼                                    │
│   ┌──────────────┐   ┌──────────────────┐   ┌───────────────────────────────────────┐       │
│   │  SQS QUEUES  │   │  LAMBDA          │   │  EVENTBRIDGE SCHEDULER                │       │
│   │              │   │  (Event handlers) │   │  (Replaces cron jobs)                 │       │
│   │  email-queue │   │                  │   │                                       │       │
│   │  push-queue  │   │  Formats event   │   │  Every 15m: auto-complete-appointments│       │
│   │  chat-queue  │   │  data into       │   │  Every 30m: cleanup-tentative-slots   │       │
│   │              │   │  channel-specific │   │  Every 1h:  reconcile-earnings        │       │
│   │  DLQ for     │   │  payloads        │   │  Every 6h:  transfer-recordings       │       │
│   │  failures    │   │                  │   │  Every 24h: cleanup-stale-pending     │       │
│   └──────┬───────┘   └────────┬─────────┘   └───────────────────────────────────────┘       │
│          │                    │                                                               │
│          ▼                    ▼                                                               │
│   ┌─────────────────────────────────────────────────────────────────────────────────────┐    │
│   │                                                                                      │    │
│   │  ┌───────────────────────┐  ┌──────────────────────┐  ┌──────────────────────────┐  │    │
│   │  │  AMAZON SES           │  │  AMAZON PINPOINT     │  │  AMAZON SNS              │  │    │
│   │  │  (Replaces Resend)    │  │  (Replaces ConvertKit│  │  (Push + SMS)            │  │    │
│   │  │                       │  │   + Analytics)       │  │                          │  │    │
│   │  │  Transactional email: │  │                      │  │  Push notifications:     │  │    │
│   │  │  • Booking confirm    │  │  Email marketing:    │  │  • Mobile push (FCM/APNs)│  │    │
│   │  │  • Payment receipt    │  │  • Newsletter blast  │  │  • Topic subscriptions   │  │    │
│   │  │  • Password reset     │  │  • Drip sequences    │  │                          │  │    │
│   │  │  • Payout notify      │  │  • Segmentation      │  │  SMS:                    │  │    │
│   │  │  • Invoice email      │  │  • Enterprise onboard│  │  • OTP verification      │  │    │
│   │  │  • Org invitation     │  │  • A/B testing       │  │  • Appointment reminder  │  │    │
│   │  │                       │  │                      │  │                          │  │    │
│   │  │  Templates:           │  │  Segments:           │  │  In-App:                 │  │    │
│   │  │    SES v2 templates   │  │  • B2C consultees    │  │  • WebSocket push from   │  │    │
│   │  │    with handlebars    │  │  • B2C consultants   │  │    Spring Boot STOMP     │  │    │
│   │  │                       │  │  • Enterprise admins │  │  • Stored in DynamoDB    │  │    │
│   │  │  Deliverability:      │  │  • Enterprise members│  │    (notification inbox)  │  │    │
│   │  │  • DKIM/SPF/DMARC    │  │  • Churning users    │  │                          │  │    │
│   │  │  • Bounce handling    │  │  • High-value        │  │                          │  │    │
│   │  │  • Complaint tracking │  │                      │  │                          │  │    │
│   │  └───────────────────────┘  └──────────────────────┘  └──────────────────────────┘  │    │
│   │                                                                                      │    │
│   └─────────────────────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### Video, Chat, and Real-Time

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                       VIDEO, CHAT & REAL-TIME (All AWS)                                      │
│                       (Replaces Stream.io Video + Chat)                                       │
│                                                                                               │
│  ┌──────────────────────────────────┐  ┌──────────────────────────────────────────────────┐  │
│  │  AMAZON CHIME SDK                │  │  AWS APPSYNC + API GATEWAY WEBSOCKET            │  │
│  │  (Replaces Stream Video)         │  │  (Replaces Stream Chat)                          │  │
│  │                                  │  │                                                  │  │
│  │  Meetings:                       │  │  Option A: AppSync (GraphQL Subscriptions)       │  │
│  │  • 1:1 consultations            │  │    • Real-time chat messages                     │  │
│  │  • Group webinars (up to 250)   │  │    • Typing indicators                           │  │
│  │  • Class sessions               │  │    • Read receipts                               │  │
│  │  • Trial sessions               │  │    • Backed by DynamoDB                          │  │
│  │                                  │  │                                                  │  │
│  │  Features:                       │  │  Option B: API GW WebSocket + Lambda             │  │
│  │  • Screen sharing               │  │    • More control, more code                     │  │
│  │  • Recording → S3 automatically │  │    • Connection management in DynamoDB           │  │
│  │  • Noise suppression            │  │    • Message fan-out via Lambda                  │  │
│  │  • Background blur              │  │                                                  │  │
│  │  • Content sharing              │  │  Chat data stored in:                             │  │
│  │                                  │  │    DynamoDB: messages, channels, members         │  │
│  │  Recording pipeline:            │  │    S3: file attachments, media                   │  │
│  │  Meeting → Media Pipeline        │  │    ElastiCache: online presence, typing state   │  │
│  │    → S3 (raw recording)          │  │                                                  │  │
│  │    → MediaConvert (transcode)    │  └──────────────────────────────────────────────────┘  │
│  │    → S3 (processed recording)    │                                                        │
│  │    → CloudFront (playback)       │  ┌──────────────────────────────────────────────────┐  │
│  │                                  │  │  AMAZON DYNAMODB                                 │  │
│  │  Chime SDK pricing:             │  │  (NoSQL for real-time data)                      │  │
│  │  • $0.0017/min per attendee     │  │                                                  │  │
│  │  • Recordings: $0.004/min       │  │  Tables:                                         │  │
│  │                                  │  │  • ChatMessages (PK: channelId, SK: timestamp)  │  │
│  └──────────────────────────────────┘  │  • ChatChannels (PK: channelId)                 │  │
│                                        │  • NotificationInbox (PK: userId, SK: timestamp)│  │
│                                        │  • WebSocketConnections (PK: connectionId)      │  │
│                                        │  • UserPresence (PK: userId, TTL-based)         │  │
│                                        └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### Observability and Analytics

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                       OBSERVABILITY & ANALYTICS (All AWS)                                     │
│                       (Replaces PostHog + Sentry + Intercom)                                  │
│                                                                                               │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌────────────────────────────────────┐  │
│  │  AMAZON CLOUDWATCH   │  │  AWS X-RAY            │  │  AMAZON PINPOINT (Analytics)      │  │
│  │  (Logs + Metrics)    │  │  (Distributed Tracing) │  │  (Replaces PostHog)              │  │
│  │                      │  │  (Replaces Sentry)     │  │                                  │  │
│  │  • Application logs  │  │                        │  │  • User journey tracking         │  │
│  │  • Custom metrics    │  │  • Request tracing     │  │  • Funnel analysis               │  │
│  │  • Alarms → SNS      │  │    across services     │  │  • Retention cohorts             │  │
│  │  • Dashboard         │  │  • Error tracking      │  │  • Custom events                 │  │
│  │  • Log Insights      │  │  • Latency analysis    │  │  • Feature flag (via AppConfig)  │  │
│  │    (query logs)      │  │  • Service map         │  │  • A/B test results              │  │
│  └──────────────────────┘  └──────────────────────┘  └────────────────────────────────────┘  │
│                                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │  AMAZON CONNECT (Replaces Intercom)                                                      │ │
│  │                                                                                          │ │
│  │  • Live chat widget on the platform                                                      │ │
│  │  • Agent workspace for support staff                                                     │ │
│  │  • Chatbot (Amazon Lex) for FAQ auto-responses                                           │ │
│  │  • Integrates with SupportTicket model via Lambda                                        │ │
│  │  • Contact flows for routing (B2C vs Enterprise priority)                                │ │
│  └──────────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### The CI/CD and Infrastructure

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                         CI/CD & INFRASTRUCTURE                                                │
│                                                                                               │
│  ┌────────────────────────────────────────────────────────────┐  ┌─────────────────────────┐ │
│  │  AWS CDK or Terraform (Infrastructure as Code)             │  │  SECRETS MANAGER        │ │
│  │                                                            │  │                         │ │
│  │  Defines all resources: ECS, Aurora, S3, Cognito,         │  │  • DB credentials       │ │
│  │  ElastiCache, CloudFront, EventBridge, SQS, etc.          │  │  • Stripe API keys      │ │
│  │                                                            │  │  • Razorpay keys        │ │
│  └────────────────────────────────────────────────────────────┘  │  • Cognito secrets      │ │
│                                                                  │  • Chime credentials    │ │
│  ┌────────────────────────────────────────────────────────────┐  │  • Directus admin key   │ │
│  │  AWS CODEPIPELINE + CODEBUILD                              │  └─────────────────────────┘ │
│  │  (Replaces GitHub Actions / Netlify Build)                 │                               │
│  │                                                            │  ┌─────────────────────────┐ │
│  │  Pipeline:                                                 │  │  PARAMETER STORE        │ │
│  │  GitHub Push                                               │  │  (SSM)                  │ │
│  │    → CodeBuild (mvn test, mvn package)                    │  │                         │ │
│  │    → Docker build → push to ECR                           │  │  • Feature flags        │ │
│  │    → Deploy to ECS Fargate (blue/green)                   │  │  • App configuration    │ │
│  │    → Run Flyway migrations                                │  │  • Environment vars     │ │
│  │    → Smoke test                                           │  │                         │ │
│  │                                                            │  └─────────────────────────┘ │
│  │  Frontend:                                                 │                               │
│  │  GitHub Push → CodeBuild (npm build) → S3 → CloudFront   │  ┌─────────────────────────┐ │
│  │    invalidation                                            │  │  ECR (Container Reg.)   │ │
│  │                                                            │  │  Spring Boot images     │ │
│  └────────────────────────────────────────────────────────────┘  └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Request Flows

### B2C Flow: "Consultee books a consultation"

```
COMPLETE REQUEST FLOW: "Consultee books a consultation"
════════════════════════════════════════════════════════

Browser (React SPA on CloudFront)
  │
  ├─── GET /api/consultants?domain=tech ──────────────────────────────────────────┐
  │                                                                                │
  │    CloudFront → ALB → Spring Boot (ECS)                                       │
  │      → Spring Security validates Cognito JWT                                  │
  │      → ConsultantController.search()                                          │
  │      → ElastiCache check (cache hit? return cached)                           │
  │      → Spring Data JPA → Aurora PostgreSQL (public schema)                    │
  │      → Cache result in ElastiCache                                            │
  │      → Return JSON                                                             │
  │                                                                                │
  ├─── POST /api/consultations/book ──────────────────────────────────────────────┐
  │                                                                                │
  │    ALB → Spring Boot                                                           │
  │      → Validate JWT + extract userId, consulteeProfileId                      │
  │      → ConsultationService.book()                                             │
  │        → ElastiCache: acquire distributed lock on slot                        │
  │        → Aurora: create Consultation + Appointment + SlotOfAppointment        │
  │        → Stripe/Razorpay: create payment intent                               │
  │        → EventBridge: publish "consultation.booked" event                     │
  │        → Release lock                                                         │
  │      → Return { paymentUrl, consultationId }                                  │
  │                                                                                │
  │    EventBridge rule "consultation.booked" triggers:                            │
  │      → SQS (email-queue) → Lambda → SES: send booking confirmation email     │
  │      → SQS (push-queue) → Lambda → SNS: push notification to consultant     │
  │      → Lambda → DynamoDB: write to NotificationInbox (in-app bell)           │
  │      → Lambda → Pinpoint: track "consultation_booked" analytics event        │
  │                                                                                │
  ├─── After payment succeeds (Stripe webhook) ──────────────────────────────────┐
  │                                                                                │
  │    Stripe → ALB → Spring Boot /api/webhooks/stripe                            │
  │      → Verify webhook signature                                               │
  │      → PaymentService.handlePaymentSuccess()                                  │
  │        → Aurora: update Payment status, create ConsultantEarnings             │
  │        → Aurora: update Consultation status → SCHEDULED                       │
  │        → EventBridge: publish "payment.succeeded"                             │
  │          → SES: payment receipt to consultee                                  │
  │          → SES: new booking alert to consultant                               │
  │          → SNS: push to both parties                                          │
  │          → Pinpoint: track revenue event                                      │
  │                                                                                │
  ├─── Meeting time arrives ──────────────────────────────────────────────────────┐
  │                                                                                │
  │    Browser → Chime SDK (JavaScript)                                           │
  │      → Creates/joins Chime meeting                                            │
  │      → Video/audio streams via Chime                                          │
  │      → If recording enabled: Chime Media Pipeline → S3                       │
  │        → S3 Event → Lambda → MediaConvert (transcode)                        │
  │        → Transcoded video → S3 → Aurora: update Recording record             │
  │                                                                                │
  └────────────────────────────────────────────────────────────────────────────────┘
```

---

### Enterprise Flow: "Org admin invites team member"

```
ENTERPRISE FLOW: "Org admin invites team member"
═════════════════════════════════════════════════

Enterprise Admin (React SPA)
  │
  ├─── POST /api/organizations/{orgId}/invite ────────────────────────────────────┐
  │                                                                                │
  │    ALB → Spring Boot                                                           │
  │      → Cognito JWT: validate + check orgId claim                              │
  │      → @PreAuthorize("hasOrgRole('ADMIN')") ← custom evaluator               │
  │      → OrganizationService.inviteMember(email, role)                          │
  │        → Aurora: check seatsUsed < seatsTotal                                 │
  │        → Aurora: create OrgInvitation record                                  │
  │        → EventBridge: publish "org.member.invited"                            │
  │          → SES: invitation email with signup/SSO link                         │
  │          → DynamoDB: in-app notification for org admin ("Invitation sent")    │
  │          → Pinpoint: track enterprise event                                   │
  │                                                                                │
  ├─── Invitee clicks link → Cognito SSO (SAML with company IdP) ────────────────┐
  │                                                                                │
  │    Cognito: SAML assertion from Okta/Azure AD                                 │
  │      → Pre-signup Lambda: validate invitation token, auto-confirm             │
  │      → Post-confirm Lambda:                                                   │
  │        → Aurora: create User + link to Organization as OrgMember              │
  │        → Aurora: increment seatsUsed                                          │
  │        → EventBridge: publish "org.member.joined"                             │
  │          → Pinpoint: enterprise onboarding sequence triggered                 │
  │          → SES: welcome email with org-specific branding                      │
  │                                                                                │
  └────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Tradeoffs: Current Stack vs Full AWS

```
┌──────────────────────────┬──────────────────────────────────┬───────────────────────────────────────┐
│          Aspect          │   Current Stack (Managed SaaS)   │               Full AWS                │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Vendor lock-in           │ Spread across many vendors       │ Single vendor (AWS)                   │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Operational complexity   │ Low (managed services)           │ High (you manage everything)          │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Cost at small scale      │ Lower (free tiers of each SaaS)  │ Higher (Aurora, ECS, Chime, etc.)     │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Cost at large scale      │ Higher (per-seat SaaS pricing)   │ Lower (pay-per-use, volume discounts) │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Video/Chat quality       │ Stream.io is purpose-built       │ Chime SDK is good but less polished   │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Email marketing          │ ConvertKit is best-in-class UX   │ Pinpoint is powerful but complex      │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Notification             │ Novu has a visual workflow       │ EventBridge + Lambda requires custom  │
│ orchestration            │ builder                          │ code                                  │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Time to build            │ Weeks (SDKs + APIs)              │ Months (more infrastructure code)     │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Team skills needed       │ JavaScript/TypeScript fullstack  │ Java + AWS certifications + DevOps    │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Enterprise compliance    │ Varies per vendor                │ SOC 2, HIPAA, FedRAMP native          │
├──────────────────────────┼──────────────────────────────────┼───────────────────────────────────────┤
│ Data residency           │ Limited control                  │ Full control (pick regions)            │
└──────────────────────────┴──────────────────────────────────┴───────────────────────────────────────┘
```

The move to Spring Boot + AWS is typically justified when you need enterprise compliance (SOC 2, HIPAA, data residency), predictable scaling beyond 100K users, or your team is Java-heavy. For a pre-revenue consulting platform, the current managed SaaS stack has significantly faster time-to-market.

---

## When to Execute This Migration

This migration is justified when ANY of these conditions are met:

- **Enterprise compliance** requirements (SOC 2 Type II, HIPAA, data residency mandates)
- **Scale beyond 100K users** where per-seat SaaS pricing becomes expensive
- **Team composition** shifts to Java/Spring Boot expertise
- **Acquisition or funding round** requires single-vendor infrastructure
- **Latency requirements** need tighter control over infrastructure placement

Until then, the current managed SaaS stack (Next.js + Supabase + Stream + Novu + Resend + ConvertKit + Directus) provides significantly faster time-to-market and lower operational burden.

---

## Related Issues

- #367 — Enterprise Recording Library (B2B Marketplace Expansion)
- #338 — Feature Gap Analysis vs Competitors
- #312 — Directus CMS Integration
- #334 — Newsletter System with ConvertKit
- #378 — Product Analytics & Monitoring Stack
- #377 — Intercom Integration
- #402 — Maintenance Mode System
- #407 — Rate Limiting Strategy
- #373 — Scheduling Infrastructure Alternatives
