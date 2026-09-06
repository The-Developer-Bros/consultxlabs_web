# Documentation Index

This documentation is organized into logical categories for easy navigation.

## File Naming Convention

All documentation files follow `NN-kebab-case.md` (e.g., `01-architecture.md`). `README.md` is the only uppercase exception.

---

## Implemented Systems

Documentation for working, production-ready systems.

### Architecture

- [distributed-systems-explained.md](./architecture/distributed-systems-explained.md) - Redis distributed locking and caching implementation

---

### Booking

Booking system, slot allocation, validation, and scheduling logic for all 5 event types.

- [README.md](./booking/README.md) - System overview, source code map, recommended reading order
- [01-architecture.md](./booking/01-architecture.md) - Services, data model, data flows, tentative lifecycle
- [02-event-types-and-validation.md](./booking/02-event-types-and-validation.md) - 5 event types, rules, 3 validation layers
- [03-slot-math-and-calculations.md](./booking/03-slot-math-and-calculations.md) - 30-min slots, week counting, consecutive validation
- [04-api-reference.md](./booking/04-api-reference.md) - 8 endpoints, Zod schemas, error codes
- [05-troubleshooting-and-changelog.md](./booking/05-troubleshooting-and-changelog.md) - Common errors, debugging, recent fixes
- [06-booking-lifecycle.md](./booking/06-booking-lifecycle.md) - End-to-end booking journey, per-event flows, status transitions
- [07-rescheduling-flow.md](./booking/07-rescheduling-flow.md) - Reschedule API, slot lifecycle, known issues
- [08-cancellation-flow.md](./booking/08-cancellation-flow.md) - Cancel API, cascading effects, refund triggers
- [09-trial-sessions.md](./booking/09-trial-sessions.md) - Trial session system, status lifecycle, conversion
- [10-checkout-payment-integration.md](./booking/10-checkout-payment-integration.md) - How bookings connect to payments
- [12-concurrency-and-locking.md](./booking/12-concurrency-and-locking.md) - Distributed locks, Prisma transactions, race condition prevention
- [13-cron-jobs-and-background-tasks.md](./booking/13-cron-jobs-and-background-tasks.md) - 6+ background jobs for lifecycle management
- [14-local-development-and-testing.md](./booking/14-local-development-and-testing.md) - Dev setup, mock payments, test scenarios, debugging

---

### Calendar

Calendar display, synchronization, and UI components.

- [display-analysis.md](./calendar/display-analysis.md) - Calendar display analysis
- [synchronization-refactor.md](./calendar/synchronization-refactor.md) - Calendar sync refactoring
- [responsive-appointments-system.md](./calendar/responsive-appointments-system.md) - Responsive design
- [visual-changes-summary.md](./calendar/visual-changes-summary.md) - Visual changes overview

---

### Payments

Payment system, checkout flows, gateway integrations, payouts, refunds, and more. See [payments/README.md](./payments/README.md) for full index.

- [01-architecture.md](./payments/01-architecture.md) - Payment architecture
- [02-setup.md](./payments/02-setup.md) - Payment system setup
- [03-status-enums-reference.md](./payments/03-status-enums-reference.md) - Status enums reference
- [04-abandoned-solutions.md](./payments/04-abandoned-solutions.md) - Abandoned payment handling

#### Checkout Flow

- [checkout-flow/01-overview-and-consultation.md](./payments/checkout-flow/01-overview-and-consultation.md) - System overview, consultation & subscription
- [checkout-flow/02-webinar-and-class.md](./payments/checkout-flow/02-webinar-and-class.md) - Webinar & class flows
- [checkout-flow/03-payment-processing.md](./payments/checkout-flow/03-payment-processing.md) - Checkout API, gateway integration
- [checkout-flow/04-edge-cases.md](./payments/checkout-flow/04-edge-cases.md) - Race conditions, timeouts, mock payments
- [checkout-flow/05-status-flows.md](./payments/checkout-flow/05-status-flows.md) - Status lifecycle
- [checkout-flow/06-known-issues.md](./payments/checkout-flow/06-known-issues.md) - Known issues and fixes

#### Gateways

- [gateways/razorpay/](./payments/gateways/razorpay/) - Razorpay setup, architecture, payout flow, KYC
- [gateways/stripe/](./payments/gateways/stripe/) - Stripe setup, architecture, payout flow

#### Approval Payments

- [approval-payments/](./payments/approval-payments/) - Consultant-approves-first workflow (7 docs)

#### Refunds & Disputes

- [refunds-disputes/](./payments/refunds-disputes/) - Two-phase refund pattern, dispute lifecycle (6 docs)

#### Cancellations & Rescheduling

- [cancellations-rescheduling/](./payments/cancellations-rescheduling/) - Refund triggers, payment reuse on reschedule

#### Payouts

- [payouts/](./payments/payouts/) - Earnings lifecycle, batch processing, gateway disbursement (8 docs)

#### Webhooks

- [webhooks/](./payments/webhooks/) - Webhook monitoring, Razorpay schema

---

### Stream (Chat & Video)

Stream.io integration for messaging and video calls. This is the implemented messaging system.

- [01-architecture.md](./stream/01-architecture.md) - Stream architecture
- [02-setup-configuration.md](./stream/02-setup-configuration.md) - Setup and configuration
- [03-provider-authentication.md](./stream/03-provider-authentication.md) - Provider authentication
- [04-chat-implementation.md](./stream/04-chat-implementation.md) - Chat implementation
- [05-video-implementation.md](./stream/05-video-implementation.md) - Video implementation
- [06-channel-management.md](./stream/06-channel-management.md) - Channel management
- [07-user-management.md](./stream/07-user-management.md) - User management
- [08-token-management.md](./stream/08-token-management.md) - Token management
- [09-background-sync.md](./stream/09-background-sync.md) - Background sync
- [10-api-endpoints.md](./stream/10-api-endpoints.md) - API endpoints
- [11-hooks-utilities.md](./stream/11-hooks-utilities.md) - Hooks and utilities
- [12-error-handling.md](./stream/12-error-handling.md) - Error handling
- [13-recording-webhooks.md](./stream/13-recording-webhooks.md) - Recording webhooks
- [troubleshooting.md](./stream/troubleshooting.md) - Troubleshooting

---

### Supabase

Supabase configuration and policies.

- [setup-guide.md](./supabase/setup-guide.md) - Supabase setup guide

#### RLS Policies & Triggers

- [rls-policies-triggers/readme.md](./supabase/rls-policies-triggers/readme.md) - RLS overview
- [rls-policies-triggers/quick-reference.md](./supabase/rls-policies-triggers/quick-reference.md) - Quick reference
- [rls-policies-triggers/changelog.md](./supabase/rls-policies-triggers/changelog.md) - Changelog
- [rls-policies-triggers/troubleshooting.md](./supabase/rls-policies-triggers/troubleshooting.md) - Troubleshooting

---

### Upstash

Redis distributed locking.

- [redis/locking/00_README.md](./upstash/redis/locking/00_README.md) - Locking overview
- [redis/locking/01_MIGRATION_GUIDE.md](./upstash/redis/locking/01_MIGRATION_GUIDE.md) - Migration guide
- [redis/locking/02_API_REFERENCE.md](./upstash/redis/locking/02_API_REFERENCE.md) - API reference
- [redis/locking/03_DISTRIBUTED_LOCKING_DEEP_DIVE.md](./upstash/redis/locking/03_DISTRIBUTED_LOCKING_DEEP_DIVE.md) - Deep dive

---

---

### Notifications

Notification system: Resend (transactional email) + Novu (multi-channel orchestration).

- [README.md](./notifications/README.md) - System overview, source code map, navigation hub
- [01-architecture.md](./notifications/01-architecture.md) - Dual-layer architecture, subscriber management, preferences, fire-and-forget pattern
- [02-workflows-and-api.md](./notifications/02-workflows-and-api.md) - 27 Novu workflows, 10 Resend email functions, API endpoints

---

### Support & Feedback

The `#support-hub` system: per-appointment support threads, stateless platform
intake, org triage, and private CSAT feedback.

- [support-hub.md](./support/support-hub.md) - Two-scope architecture, the error envelope + Sentry policy, authz gate, ticket references, the SLA model, the deflection counter, invariants, testing map
- [engineering-log-2026-08-29.md](./support/engineering-log-2026-08-29.md) - The support-drawer turn loss: eight causes, the schema they required, and two stale audit claims

---

### Storage

Storage management and document review system.

- [management-strategy.md](./storage/management-strategy.md) - Storage management strategy

---

### Performance

Implemented performance optimizations.

- [dashboard-prefetching.md](./performance/dashboard-prefetching.md) - Dashboard prefetching
- [optimization-checklist.md](./performance/optimization-checklist.md) - Optimization checklist

---

## Guides & Developer Resources

### Guides

Setup guides and how-to documentation.

- [cleanup-setup.md](./guides/cleanup-setup.md) - Cleanup configuration
- [cron-setup.md](./guides/cron-setup.md) - Cron job setup
- [using-fallback-image.md](./guides/using-fallback-image.md) - Fallback image usage

---

### API

Mobile API integration documentation.

> The Familiarise mobile app uses a separate Dart Frog backend. These docs describe web API contracts.

- [cancellation-api-mobile.md](./api/cancellation-api-mobile.md) - Cancellation API for mobile
- [support-tickets-mobile.md](./api/support-tickets-mobile.md) - Support tickets API for mobile

---

### Prisma

Prisma operations and migration documentation.

- [prisma/README.md](./prisma/README.md) - **Full index**, and which document applies to the current posture
- [migrations-guide.md](./prisma/migrations-guide.md) - General-purpose Prisma Migrate reference
- [cutover-to-migrations.md](./prisma/cutover-to-migrations.md) - Launch-day runbook: `db push` to versioned migrations
- [pre-mvp-reset-runbook.md](./prisma/pre-mvp-reset-runbook.md) - The one-time reset that finalises the launch schema
- [schema-map.md](./prisma/schema-map.md) - Domain diagrams of the Prisma schema
- [prisma-7-migration.md](./prisma/prisma-7-migration.md) - Record of the Prisma 6 to 7 upgrade

---

### Education

Generic software architecture patterns and learning material (not Familiarise-specific).

- [education/README.md](./education/README.md) - **Full index**

---

## Business & Research

### Finances

CFO-level business documentation. See [finances/README.md](./finances/README.md) for full index.

- [01-business-model.md](./finances/01-business-model.md) - Revenue model
- [02-revenue-distribution.md](./finances/02-revenue-distribution.md) - Revenue splitting
- [03-pricing-calculator.md](./finances/03-pricing-calculator.md) - Pricing calculator
- [04-profitability-analysis.md](./finances/04-profitability-analysis.md) - Profitability
- [05-saas-metrics-monthly.md](./finances/05-saas-metrics-monthly.md) - SaaS metrics
- [06-tax-compliance-india.md](./finances/06-tax-compliance-india.md) - Tax compliance
- [07-tax-compliance-marketplace-obligations.md](./finances/07-tax-compliance-marketplace-obligations.md) - Marketplace obligations
- [08-tax-essentials-simplified.md](./finances/08-tax-essentials-simplified.md) - Simplified tax guide
- [09-pricing-strategy.md](./finances/09-pricing-strategy.md) - Competitive pricing strategy

---

### Team

Internal team documentation — onboarding, testing guides, and contributor resources.

- [platform-testing-playbook.md](./team/platform-testing-playbook.md) - Comprehensive platform feature walkthrough and testing checklists

---

### Competitors

Competitor analysis and research.

- [README.md](./competitors/README.md) - Competitors overview
- [01-topmate-io.md](./competitors/01-topmate-io.md) - Topmate analysis
- [02-preplaced-in.md](./competitors/02-preplaced-in.md) - Preplaced analysis
- [03-metvy-com.md](./competitors/03-metvy-com.md) - Metvy analysis
- [04-upgrad-com.md](./competitors/04-upgrad-com.md) - upGrad analysis
- [05-propeers-in.md](./competitors/05-propeers-in.md) - ProPeers analysis
- [06-growthschool-io.md](./competitors/06-growthschool-io.md) - GrowthSchool analysis

- [competitor-analysis.md](./competitor-analysis.md) - Consolidated competitor analysis

---

## Roadmap — Planned & Future Work

All documentation for features, integrations, and improvements that are **not yet implemented**.

- [roadmap/README.md](./roadmap/README.md) - **Full roadmap index**

### Highlights

- [Auth Migration (BetterAuth)](./roadmap/auth/betterauth-migration.md) - NextAuth → BetterAuth migration
- [Enterprise Subsystem](enterprise/00-foundations/01-overview.md) - SSO, org management, billing, payouts (canonical implementation docs)
- [Infrastructure Hardening](./roadmap/infrastructure/README.md) - Security, monitoring, scaling (14 audit documents)
- [Service Integration Architecture](./roadmap/content-strategy/README.md) - Directus, ConvertKit, Enterprise interlinking (planned)
- [Content Strategy](./roadmap/content-strategy/README.md) - CMS, blog, gated community
- [Navigation Mega-Menu](./roadmap/navigation/README.md) - Mega-menu design
- [15 Planned Features](./roadmap/features/) - AI summaries, smart matching, referrals, and more
- [Performance Improvements](./roadmap/performance/) - Caching, scaling, zero-downtime migrations
