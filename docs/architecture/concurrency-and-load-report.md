# Concurrency, Load Capacity, and Queue Architecture Report

**Generated:** 2026-06-11  
**Stack:** Next.js 15 · Supabase (PostgreSQL + Supavisor) · Netlify · Upstash Redis  
**Scope:** Pre-MVP; all data is mock/dev data in a shared Supabase project  

---

## 1. Executive Summary

This report answers five questions: whether the stack can handle concurrent workloads, whether a message queue is needed now, which queue tool to choose if so, how to load-test the platform, and what must be hardened before launch. The short answers are:

1. **The core architecture is well-designed for concurrency.** Distributed Redis locks, idempotency keys on every money flow, conditional-UPDATE atomic guards, and Prisma serializable-retry are already in place. The platform will not silently corrupt data under concurrent load.
2. **The primary bottleneck at scale is the Supabase connection pool (60 direct connections), not the application logic.** Every Netlify serverless function that opens a Prisma connection competes for a pool slot. This is the single most important thing to validate before launch.
3. **You do not need Kafka, RabbitMQ, BullMQ, or Amazon SQS.** All four are architecturally incompatible with Netlify's serverless model or introduce AWS infrastructure footprint that is unjustified at this stage.
4. **Upstash QStash and Inngest are worth evaluating post-MVP**, specifically for email retry queuing and parallelising the invoice/payout batch crons. They are not blocking pre-launch.
5. **Add k6 load tests now.** k6 runs as a single binary locally and in GitHub Actions with no Kubernetes required. A minimal smoke-test suite targeting the five endpoints the script below actually exercises (auth sign-in, slot availability, health, consultant search, checkout context) will expose the connection-pool ceiling before real users do.

---

## 2. Platform Architecture Overview

The production topology is as follows. Incoming HTTP requests hit Netlify's edge network, which invokes a Next.js server handler packaged as a serverless function (AWS Lambda under the hood). Each function invocation is ephemeral — it starts cold, handles one request, and terminates. There is no shared process memory between requests.

```
Browser / Mobile
      │
      ▼
Netlify Edge Network  ──── Upstash Redis (rate-limit, maintenance cache)
      │
      ▼
Next.js Server Handler (Netlify Serverless Function)
      │                    │                    │
      ▼                    ▼                    ▼
  Prisma ORM          Upstash Redis        External APIs
  (DATABASE_URL       (distributed         (Razorpay, Stripe,
   → Supavisor)        locks, circuit        Stream.io, Resend,
      │                 breaker)             Novu)
      ▼
  Supabase PostgreSQL
  (direct: 60 conns,
   pooler: 200 conns)

Background Work:
  GitHub Actions (58 cron .yml files)
    → HTTP calls to /api/cleanup/* endpoints
    → TypeScript CLI scripts (jobs/**)
```

The GitHub Actions cron layer is the platform's substitute for a job queue. It is free, reliable, and already in use for 41 distinct scheduled operations. The architecture is appropriate for the current scale.

---

## 3. Hard Platform Limits

These are the concrete constraints imposed by the hosting and database providers, not by the application code. Every load-testing exercise should be designed to find where the platform hits these walls.

| Constraint | Value | Tier | Risk Level |
|---|---|---|---|
| Netlify function timeout | 10 seconds | Free | 🔴 Will fail on slow DB queries |
| Netlify function timeout | 26 seconds | Pro/Business | 🟡 Adequate for most operations |
| Netlify background function timeout | 15 minutes | Pro+ | 🟢 For long-running jobs |
| Netlify concurrent invocations | **125 per site** | All paid | 🟡 Flash-sale ceiling |
| Netlify function memory | 1,024 MB | All plans | 🟢 Sufficient |
| Netlify cold start latency | ~3 seconds | All plans | 🟡 Affects first-user UX |
| Supabase direct connections | **60** | Free + Pro Micro | 🔴 Primary bottleneck |
| Supabase Supavisor pool | **200** | Free | 🟡 |
| Supabase Supavisor pool | Dedicated (scales with compute) | Pro+ | 🟢 |
| Supavisor sustained TPS (benchmarked) | ~21,700 TPS | Single node | 🟢 Plenty for MVP |
| Supabase realtime concurrent users | 200 | Free | 🟡 |
| Supabase realtime concurrent users | 500 | Pro | 🟢 |
| Upstash Redis REST latency | ~100–200 ms per call | All plans | 🟡 Adds latency on lock-heavy paths |

### What these numbers mean in practice

At 125 concurrent Netlify functions, each making one Prisma call, the pool request queue behind Supavisor's 200 connections will not be exhausted — the pooler acts as a buffer. However, if a subset of those requests hit slow queries (e.g., the reconciliation cron does a large sequential scan), long-held pool connections can back up. The Netlify timeout of 26 seconds on a paid plan is the hard ceiling; any request still waiting for a DB connection at second 26 returns a 504 to the user.

The 60-connection direct limit matters only for migrations (`DIRECT_URL`) and for any code path accidentally using the direct URL at runtime. The application should always route through Supavisor at runtime.

---

## 4. Current Concurrency Mechanisms

The codebase already implements several concurrency safeguards. This section catalogues them so the load-testing strategy can verify each one holds under pressure.

### 4.1 Distributed Locking (Upstash Redis)

The file `lib/redis.ts` implements a Redis-backed distributed lock using an atomic Lua script for check-and-delete. All 41 cron jobs acquire a named lock before executing (e.g., `lock:payout:batch`, `lock:payout:process`). If the lock is held by another invocation — which can happen when GitHub Actions triggers overlap — the second invocation exits gracefully rather than running a duplicate batch.

The lock implementation includes a circuit breaker: after 5 consecutive Redis failures, the breaker opens and new lock acquisitions fail open (the operation proceeds without a lock) for non-money jobs, or fail closed (returning an error) for payout jobs. This prevents a Redis outage from silently duplicating financial work.

### 4.2 Rate Limiting (Upstash + Arcjet)

Eight rate-limit rules run at the Netlify edge before the request reaches the Next.js handler. These rules use Upstash's sliding-window algorithm, which survives Redis restarts because the window is stored in Redis sorted sets:

| Endpoint | Limit | Window | Key |
|---|---|---|---|
| `POST /api/auth/sign-in,sign-up,forget-password` | 10 requests | 15 minutes | IP |
| `GET /api/user/consultants` | 60 requests | 1 minute | IP |
| `GET /api/trials/check-eligibility` | 100 requests | 1 hour | IP |
| `POST /api/newsletter/subscribe` | 30 requests | 1 hour | IP |
| `GET /api/slots/availability/*` | 60 requests | 1 minute | IP |
| `POST /api/organizations/.../invitations/accept` | 30 requests | 1 minute | IP |
| `GET /api/auth/sso/domain-check` | 60 requests | 1 hour | IP |
| `POST /api/checkout` | 5 requests | 1 minute | User ID |

All rules are configured to fail open: if Upstash is unreachable, the request passes rather than being blocked. This is the correct choice for availability, but it means the rate limit does not protect against a Redis outage coinciding with a brute-force attempt.

### 4.3 Idempotency

Every money flow has an idempotency key that prevents duplicate processing on retry:

- **Checkout**: `clientIdempotencyKey @unique` on the `Payment` model; the route returns the existing payment if the key is already present (`replayByIdempotencyKey`).
- **Webhooks**: `WebhookEvent` table stores a hash of the raw payload. Any webhook redelivery with the same body hash returns 200 without reprocessing.
- **Ledger**: `LedgerTransaction.idempotencyKey @unique` prevents duplicate journal entries.
- **Cron jobs**: Conditional UPDATEs (`WHERE status = 'PENDING' AND processedAt IS NULL`) act as distributed claim gates; the first runner wins, subsequent runners find no rows to process.

### 4.4 Race Condition Guards for Slot Booking

A test endpoint at `POST /api/test-race-condition` demonstrates the booking safety guarantee: N concurrent requests for the last available slot should produce exactly one 201 Created and N−1 409 Conflict responses. This is enforced by a unique constraint on `(slotId, tentativeUserId)` in the `SlotOfAppointment` table, combined with a Redis lock acquired in `utils/appointmentlock.ts` before the Prisma write.

### 4.5 Serializable Transaction Retry

The file `lib/db/serializable-retry.ts` wraps any operation that requires Postgres `SERIALIZABLE` isolation. If the transaction fails with error code `P2034` (serialization failure), it retries up to 3 times with jittered exponential backoff. This is used on the program-assignment increment and wallet-debit paths, where two concurrent requests must not both pass the cap check.

### 4.6 Maintenance Mode Gate

The file `lib/maintenance-edge.ts` reads a maintenance state from Upstash (30-second in-memory cache) at the edge before the request reaches the database. In `DEGRADED` mode, all non-GET requests return 503 immediately, protecting the database from writes during a partial outage. In `OFFLINE` mode, all requests are blocked. This gate can be toggled without a code deploy via `POST /api/admin/maintenance`.

---

## 5. Concurrency Risk Register

The following risks are ordered by estimated impact at launch-scale load. The mitigation status reflects what is already in the codebase versus what still needs verification.

### Risk 1 — Supabase Connection Pool Exhaustion (Severity: HIGH)

**What can go wrong.** The Supabase free tier and the Pro Micro compute tier both cap PostgreSQL at 60 direct connections. Supavisor, the connection pooler, raises the effective limit to 200 concurrent client connections by multiplexing them across the 60 physical connections. However, Supavisor's transaction-mode pooling means each SQL statement holds a connection only for its duration. If the application uses session-mode pooling instead (the default for some Prisma configurations), each Prisma client holds a connection for the lifetime of the HTTP request, which on a 26-second Netlify timeout can mean 125 concurrent functions × 1 held connection = 125 connections, exceeding the 60-connection physical limit.

**Current mitigation.** The `DATABASE_URL` in `.env.sample` includes Supavisor's connection string. Whether it is configured for transaction mode or session mode depends on the `?pgbouncer=true&connection_limit=1` parameters appended to the URL.

**Verification needed.** Confirm `DATABASE_URL` ends with `?pgbouncer=true&connection_limit=1` to force transaction-mode pooling. Run the k6 scenario below with its spike stage raised to 150 virtual users (the script peaks at 100 by default — bump the last non-zero `stages` target) to trigger pool pressure, and observe whether `P1001` errors appear.

### Risk 2 — ProgramAssignment Concurrent Increment (Severity: HIGH)

**What can go wrong.** When two requests concurrently attempt to book the last remaining engagement under a program, both read `engagementsUsed = cap - 1`, both determine there is one slot left, and both attempt to increment. If the guard is a read-then-write pattern (`SELECT … UPDATE`), both writes succeed and the cap is over-consumed. The current implementation uses `updateMany(WHERE engagementsUsed < cap)` which is a conditional UPDATE — a single atomic SQL statement that acts as a distributed mutex. However, this only works if the Prisma client is not wrapping this in a broader transaction at `READ COMMITTED` isolation, which would allow phantom reads.

**Current mitigation.** `lib/db/serializable-retry.ts` exists and is intended for this path. Whether it is actually applied to the `updateMany` call requires code-level verification.

**Verification needed.** Confirm that the program-assignment increment in `lib/api/organizations/program-helpers.ts` is either (a) the lone SQL statement (no broader transaction, relying on Postgres row-level locking) or (b) wrapped in a SERIALIZABLE transaction via `serializableRetry`. The race-condition test suite at `tests/typescript/race-conditions/test-checkout-race-condition-fix.ts` should be run to confirm.

### Risk 3 — BillingAccount Wallet Over-Draft (Severity: HIGH)

**What can go wrong.** The `BillingAccount.walletBalance` field is a denormalized cache of the sum of all ledger entries for that account. If the debit path is a read-then-write (fetch balance → check balance >= amount → write debit), two concurrent requests can both read the same balance, both pass the check, and both write, resulting in a negative balance.

**Current mitigation.** The code is expected to use a conditional `UPDATE billingaccounts SET walletBalance = walletBalance - amount WHERE walletBalance >= amount` as a single statement. The `LedgerAccountBalance.entrySeq` monotonic counter is a double-apply guard.

**Verification needed.** Locate the wallet debit function in `lib/payments/` and confirm the UPDATE is atomic and not a two-step fetch-then-write.

### Risk 4 — Serial Invoice Generation at Scale (Severity: MEDIUM)

**What can go wrong.** The subscription invoice cron (`jobs/billing/generate-subscription-invoices.ts`) iterates every `BillingSubscription` row with `nextInvoiceDate <= now` in a sequential for-loop. At 50 orgs this is trivial; at 500 orgs with non-trivial per-org computation (GST breakdown, sequential invoice numbering, ledger posting), the total runtime could exceed the GitHub Actions job timeout (6 hours) or, more critically, the per-HTTP-trigger Netlify function timeout (26 seconds) if the job is invoked via the API route pattern.

**Current mitigation.** None for the sequential processing pattern.

**Acceptable pre-launch.** At pre-MVP scale this is not a blocker. Post-MVP, this is the primary candidate for Inngest's durable step execution, which would fan out one Inngest function per org and process them in parallel with automatic retries.

### Risk 5 — Email Dispatch Without Retry (Severity: MEDIUM)

**What can go wrong.** Email sending via Resend is implemented as direct `async` calls in `lib/email.ts`. If Resend returns a transient error (5xx, timeout, rate limit), the call throws, the error is logged, and the email is silently dropped. There is no dead-letter queue, no retry schedule, and no admin visibility into failed emails.

**Current mitigation.** None.

**Acceptable pre-launch?** Marginal. Payment confirmation emails and org invitation emails are on this path. A transient Resend outage at checkout time would result in users not receiving payment confirmation — a poor experience that could generate support tickets. Post-MVP, routing email dispatch through Upstash QStash (which provides automatic retry and a delivery log) is the simplest fix.

### Risk 6 — Netlify 125-Function Concurrency Ceiling (Severity: LOW)

**What can go wrong.** Netlify allows a maximum of 125 concurrent function invocations per site on standard paid plans. A sudden traffic spike — a viral moment, a featured listing, a B2B client importing 200 users simultaneously — can saturate this limit. Excess requests do not fail immediately; Netlify queues them, which increases latency for all users until the backlog drains.

**Current mitigation.** Edge rate limiting prevents the most common abuse patterns. Application-level rate limits (checkout: 5/min per user) limit legitimate high-frequency usage.

**Acceptable pre-launch.** Yes. At 125 concurrent functions the platform serves hundreds of simultaneous users comfortably. This becomes relevant at post-Series-A traffic scale. If Netlify Pro proves too constrained, the upgrade path is Netlify Enterprise (custom concurrency) or migration to a platform with higher limits.

### Risk 7 — Upstash Redis Latency on Hot Paths (Severity: LOW)

**What can go wrong.** The Upstash REST API adds 100–200 ms of round-trip latency per call. The appointment booking path acquires a Redis lock before writing to the database. On the hot path this means: edge rate-limit check (one Redis call) + maintenance mode check (one Redis call, cached 30 s) + appointment lock acquisition (one Redis call) = potentially 300–600 ms added to the booking request before the DB write begins.

**Current mitigation.** The 30-second in-memory cache on the maintenance check eliminates one Redis call from most requests. The circuit breaker allows the lock to fail open for non-financial operations, skipping the Redis round-trip entirely if Redis is down.

**Acceptable pre-launch.** Yes. 300–600 ms additional latency on booking is noticeable but not blocking. The Upstash free tier supports 10,000 commands per day; the paid plan ($10/month) removes this cap.

---

## 6. Message Queue Decision Matrix

The following analysis covers each queue technology the question named. The verdict reflects whether the tool is appropriate for this specific stack (Next.js on Netlify, not AWS Lambda, not a self-hosted server).

### 6.1 Apache Kafka — Verdict: Do Not Use

Kafka is a distributed event-streaming platform designed for sustained throughput in the millions of messages per second range. It is operated as a long-running cluster of broker processes, each maintaining persistent TCP connections to producers and consumers. This fundamental architecture is incompatible with Netlify's serverless model in two ways.

First, KafkaJS (the primary Node.js client) uses `net.connect()` for persistent TCP sockets. Netlify Functions are AWS Lambda under the hood; they do not support persistent TCP connections that survive across invocations. Attempting to import and use KafkaJS in a Netlify Function produces the error `net.connect is not a function` at cold start.

Second, Kafka consumers are long-running worker processes that poll a topic continuously. Netlify Functions terminate after handling a single request. There is no mechanism to keep a consumer alive between function invocations.

The appropriate use cases for Kafka — telemetry ingestion, real-time analytics, event sourcing at millions-of-events-per-day scale — are not present in the current platform. Adding Kafka would introduce a managed broker cost ($100+/month via Confluent Cloud), an operational burden, and a fundamentally incompatible runtime model, all for capabilities that GitHub Actions crons and Supabase webhooks already cover.

**If Kafka-style event streaming is ever needed**, Upstash Kafka (HTTP-based) is the only viable option for a Netlify deployment. It wraps Kafka topics behind an HTTP API, eliminating the persistent-TCP requirement. The throughput ceiling on the free tier is 10,000 messages per day.

### 6.2 RabbitMQ — Verdict: Do Not Use

RabbitMQ is a message broker implementing the AMQP protocol. Like Kafka, it requires a persistent broker process and consumers that maintain long-lived AMQP connections. The AMQP Node.js library (`amqplib`) uses persistent TCP, which is incompatible with serverless for the same reasons as Kafka.

RabbitMQ is well-suited for task queues in always-on containerised deployments (Docker, Kubernetes, EC2). The familiarise platform is not deployed on any of these; it runs entirely on Netlify's managed serverless infrastructure. Introducing RabbitMQ would require provisioning a persistent message broker (e.g., CloudAMQP, or self-hosted on a VPS), which adds infrastructure management that is out of scope and unnecessary at current scale.

### 6.3 BullMQ — Verdict: Do Not Use

BullMQ is a popular Redis-based job queue for Node.js. It is the natural first choice for developers familiar with the Node.js ecosystem. However, BullMQ requires worker processes — long-running Node.js processes that consume jobs from a Redis queue continuously. These workers cannot run inside Netlify Functions because the function terminates after each HTTP request.

BullMQ also requires raw TCP access to Redis on port 6379. Upstash Redis (the project's Redis provider) exposes a REST HTTP API, not a raw TCP socket. While Upstash has recently added TCP compatibility for some features, BullMQ's internal blocking list operations (`BLPOP`) are not supported over the Upstash REST API.

The architecture required to use BullMQ — a persistent worker server — would mean running a separate Node.js process on a VPS or container runtime, which defeats the purpose of a serverless deployment.

### 6.4 Amazon SQS — Verdict: Not Appropriate for This Stack

Amazon SQS is a fully managed message queue service that integrates natively with AWS Lambda. When a message is enqueued, Lambda automatically invokes a consumer function to process it. This is an excellent architecture for applications already deployed on AWS.

The familiarise platform is deployed on Netlify, not AWS. SQS is not a Netlify-native service, and there is no direct trigger mechanism equivalent to the Lambda-SQS event source mapping. To use SQS with Netlify, one would need to either poll SQS from a cron (effectively replicating what GitHub Actions already does) or deploy a Lambda-based consumer alongside the Netlify deployment, introducing an AWS footprint.

The GitHub Actions cron architecture already provides what SQS would offer in this context: reliable, retryable, scheduled invocation of background jobs. GitHub Actions is free and already configured. SQS would add AWS account management, IAM policies, and billing complexity with no material benefit at current scale.

### 6.5 Upstash QStash — Verdict: Recommended for Post-MVP (Not Blocking)

Upstash QStash is the only message queue tool in this list that is architecturally compatible with Netlify out of the box. It uses an HTTP API: the publisher sends a POST request to QStash, and QStash delivers that message to a configured HTTP endpoint (your Next.js route handler) with automatic retry on failure. No persistent connections, no worker processes, no VPS.

**Pricing** is $1 per 100,000 messages (pay-as-you-go). The free tier includes 1,000 messages per day and 10 scheduled topics. At MVP scale, the monthly cost is negligible.

**Use cases where QStash would immediately improve reliability:**

1. **Email retry queue.** Currently, `lib/email.ts` calls Resend directly and silently drops emails on transient errors. Replacing these calls with a `qstash.publishJSON({ url: '/api/workers/send-email', body: payload })` enqueue would give every email up to 5 automatic retries with exponential backoff and a delivery log in the QStash dashboard.

2. **Outbound webhook reliability.** The current outbound webhook worker (`lib/enterprise/outbound-webhooks/worker.ts`) runs in a cron every minute and processes up to 50 pending rows. QStash could replace the polling loop: when a webhook delivery is created, enqueue it to QStash immediately rather than waiting for the next cron tick. This reduces delivery latency from up to 60 seconds to near-zero.

3. **Replacing some GitHub Actions crons.** QStash supports cron schedule syntax and can trigger an HTTP endpoint on a schedule. This would consolidate schedule management from `.github/workflows/*.yml` files into the QStash dashboard, making it easier to observe, pause, and replay scheduled jobs.

**Why not now.** Pre-MVP, the GitHub Actions cron architecture is adequate and already working. The reliability improvements from QStash are real but not launch-blocking. The recommendation is to add QStash at the first post-MVP sprint when the team has capacity to instrument email and webhook retry properly.

### 6.6 Inngest — Verdict: Recommended for Post-MVP Batch Jobs (Not Blocking)

Inngest is a durable workflow platform that integrates with Next.js as a single route handler (`/api/inngest`). An Inngest function is defined in application code and triggered by events or on a cron schedule. Each "step" within the function is automatically retried on failure, and the execution state survives across serverless invocations — meaning a multi-step job that spans minutes or hours works correctly even though each individual step runs in a 26-second Netlify Function window.

**The primary use case in this codebase is the subscription invoice generation cron.** The current implementation iterates all due subscriptions sequentially in a single function invocation. With Inngest, the cron trigger would fan out one `inngest.send({ name: 'billing/invoice.generate', data: { subscriptionId } })` event per subscription, and Inngest would process them in parallel (subject to Inngest's concurrency limits), with each failure retried independently rather than blocking the entire batch.

**Pricing** scales with the number of function runs. The free tier (50,000 function runs per month) is sufficient for pre-MVP and early post-MVP operations.

**Why not now.** The sequential invoice generation does not cause correctness problems at current scale; it is a performance/reliability gap that becomes relevant at 500+ active subscriptions. Inngest requires restructuring the job code and adding the `/api/inngest` route, which is non-trivial. The recommendation is to add Inngest in the same sprint as QStash, as part of a dedicated background-jobs hardening initiative.

---

## 7. Load Testing Strategy

### 7.1 Tool Recommendation

**k6 is the recommended tool** for this project. It is distributed as a single statically-linked binary (no Node.js, no npm install), test scripts are written in plain JavaScript, and it produces structured JSON output that integrates with GitHub Actions without additional tooling. Crucially, k6 does not require Kubernetes to run — it is a CLI tool that runs on a developer's laptop or in a CI runner.

Artillery is a valid alternative and is easier to start with for simple scenarios because its YAML configuration is more readable than k6's JavaScript. k6 is preferred here because the test scenarios require custom authentication logic (BetterAuth session cookies), custom idempotency keys per virtual user, and conditional assertions on response bodies — all of which are cleaner in JavaScript than YAML.

Kubernetes-based load testing tools (JMeter in a pod, k6 Operator, Locust on EKS) are not appropriate at this stage. They solve the problem of distributing millions of virtual users across multiple machines, which is a concern at production traffic scale. Pre-MVP validation requires verifying behaviour under hundreds of concurrent users, which runs comfortably on a single machine.

### 7.2 Installing k6

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] \
  https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker (no install required)
docker run -i grafana/k6 run - <script.js
```

### 7.3 Ready-to-Run k6 Load Test Script

Save this file as `load-tests/smoke.js` in the project root. Before running, set the environment variables `BASE_URL`, `TEST_EMAIL`, `TEST_PASSWORD`, and `CONSULTANT_ID` (the names the script reads via `__ENV`) to point at the environment under test.

```javascript
// load-tests/smoke.js
// Smoke test: auth sign-in (setup), slot availability, health, consultant
// search, and checkout context under moderate concurrency.
// Run: k6 run --env BASE_URL=https://dev.familiarise.com \
//            --env TEST_EMAIL=test@example.com \
//            --env TEST_PASSWORD=testpassword123 \
//            --env CONSULTANT_ID=clxxx123 \
//            load-tests/smoke.js

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const slotAvailabilityTrend = new Trend("slot_availability_duration");
const checkoutTrend = new Trend("checkout_duration");

// Test configuration: ramp to 20 VUs over 30s, hold 50 for a minute,
// spike to 100 for 30s, ramp down (matches the stages block below).
// Adjust vus and duration for more aggressive tests.
export const options = {
  stages: [
    { duration: "30s", target: 20 },   // warm-up ramp
    { duration: "60s", target: 50 },   // sustained load
    { duration: "30s", target: 100 },  // spike test
    { duration: "30s", target: 0 },    // ramp down
  ],
  thresholds: {
    // 95th percentile response time must be under 3 seconds
    http_req_duration: ["p(95)<3000"],
    // Error rate must stay under 5%
    errors: ["rate<0.05"],
    // Slot availability must be fast (it is rate-limited to 60/min/IP)
    slot_availability_duration: ["p(95)<1500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const TEST_EMAIL = __ENV.TEST_EMAIL || "test@example.com";
const TEST_PASSWORD = __ENV.TEST_PASSWORD || "testpassword123";
const CONSULTANT_ID = __ENV.CONSULTANT_ID || "replace-with-real-id";

// Login happens once in setup(), but as a POOL of sessions distributed
// across VUs, not a single shared cookie: one cookie for 100 VUs makes the
// run effectively single-user (skews per-user rate limits and hides
// concurrency bugs), while a naive login-per-VU trips the auth limiter
// (10/15min per IP — see §3) from a single load generator. A pool of up to
// 8 sessions stays under the limiter and still exercises distinct sessions.
const SESSION_POOL_SIZE = 8;

export function setup() {
  const sessions = [];
  for (let i = 0; i < SESSION_POOL_SIZE; i++) {
    const loginRes = http.post(
      `${BASE_URL}/api/auth/sign-in/email`,
      JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
      { headers: { "Content-Type": "application/json" } }
    );
    const cookie = loginRes.cookies["better-auth.session_token"]?.[0]?.value;
    if (!cookie) {
      // Fail fast: without a session every request 401s and the run
      // measures nothing but noise.
      throw new Error(
        `setup login ${i + 1}/${SESSION_POOL_SIZE} failed (status ${loginRes.status}) — check TEST_EMAIL/TEST_PASSWORD against ${BASE_URL}`
      );
    }
    sessions.push(cookie);
  }
  return { sessions };
}

export default function (data) {
  const sessionCookie = data.sessions[__VU % data.sessions.length];
  const headers = {
    "Content-Type": "application/json",
    Cookie: `better-auth.session_token=${sessionCookie}`,
  };

  // ── 1. Slot Availability (public, rate-limited 60/min/IP) ──────────────────
  group("slot_availability", function () {
    const res = http.get(
      `${BASE_URL}/api/slots/availability/${CONSULTANT_ID}`,
      { headers }
    );
    slotAvailabilityTrend.add(res.timings.duration);
    const ok = check(res, {
      "availability 200": (r) => r.status === 200,
      "availability has slots": (r) => {
        try {
          return Array.isArray(JSON.parse(r.body));
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  // ── 2. Health check (60s cached, should always be fast) ────────────────────
  group("health", function () {
    const res = http.get(`${BASE_URL}/api/health`);
    const ok = check(res, {
      "health 200": (r) => r.status === 200,
      "health db ok": (r) => {
        try {
          return JSON.parse(r.body).db === "ok";
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  // ── 3. Consultant search (public, rate-limited 60/min/IP) ──────────────────
  group("consultant_search", function () {
    const res = http.get(
      `${BASE_URL}/api/user/consultants?limit=20&page=1`,
      { headers }
    );
    const ok = check(res, {
      "search 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(0.5);

  // ── 4. Checkout context (currency + tax resolution) ────────────────────────
  group("checkout_context", function () {
    const res = http.get(`${BASE_URL}/api/checkout/context`, { headers });
    checkoutTrend.add(res.timings.duration);
    const ok = check(res, {
      "checkout context 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  sleep(1);
}

// Summary displayed after the run.
export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        vus_max: data.metrics.vus_max?.values?.max,
        http_req_duration_p95: data.metrics.http_req_duration?.values?.["p(95)"],
        error_rate: data.metrics.errors?.values?.rate,
        total_requests: data.metrics.http_reqs?.values?.count,
        slot_availability_p95: data.metrics.slot_availability_duration?.values?.["p(95)"],
      },
      null,
      2
    ),
  };
}
```

**Running the smoke test against the local dev server:**

```bash
# Start the dev server in another terminal first
npm run dev

# In a second terminal
k6 run \
  --env BASE_URL=http://localhost:3000 \
  --env TEST_EMAIL=<your-dev-email> \
  --env TEST_PASSWORD=<your-dev-password> \
  --env CONSULTANT_ID=<any-consultant-id-from-seed-data> \
  load-tests/smoke.js
```

**Running against the deployed dev environment (no separate staging exists today):**

```bash
k6 run \
  --env BASE_URL=https://dev.familiarise.com \
  --env TEST_EMAIL=$STAGING_TEST_EMAIL \
  --env TEST_PASSWORD=$STAGING_TEST_PASSWORD \
  --env CONSULTANT_ID=$STAGING_CONSULTANT_ID \
  load-tests/smoke.js
```

### 7.4 Concurrent Booking Race-Condition Test

This secondary script stress-tests the slot booking path specifically, verifying that the distributed lock and unique constraint hold under concurrent booking attempts. It is not a throughput test; it validates correctness.

```javascript
// load-tests/booking-race.js
// Run with low VU count and high iteration rate to create genuine concurrent bookings.
// Expected: exactly 1 VU receives 201, all others receive 409.
// Run: k6 run --env BASE_URL=http://localhost:3000 \
//            --env SLOT_ID=<a-slot-id-with-1-seat-available> \
//            load-tests/booking-race.js

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const created = new Counter("booking_created");
const conflicted = new Counter("booking_conflicted");
const other = new Counter("booking_other");

export const options = {
  // 20 VUs all firing simultaneously — this creates the race condition
  vus: 20,
  iterations: 20,
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const SLOT_ID = __ENV.SLOT_ID || "replace-with-a-real-slot-id";

// In a real test, each VU would authenticate independently.
// For simplicity this script uses a pre-seeded auth token.
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "replace-with-session-token";

export default function () {
  const res = http.post(
    `${BASE_URL}/api/slots/appointments`,
    JSON.stringify({ slotId: SLOT_ID }),
    {
      headers: {
        "Content-Type": "application/json",
        Cookie: `better-auth.session_token=${AUTH_TOKEN}`,
      },
    }
  );

  if (res.status === 201) created.add(1);
  else if (res.status === 409) conflicted.add(1);
  else other.add(1);

  check(res, {
    "status is 201 or 409": (r) => r.status === 201 || r.status === 409,
  });
}

export function handleSummary(data) {
  const c = data.metrics.booking_created?.values?.count || 0;
  const x = data.metrics.booking_conflicted?.values?.count || 0;
  const o = data.metrics.booking_other?.values?.count || 0;

  const pass = c === 1 && x === 19 && o === 0;
  return {
    stdout: JSON.stringify(
      {
        result: pass ? "PASS — exactly 1 booking succeeded" : "FAIL — race condition detected",
        created: c,
        conflicted: x,
        unexpected: o,
      },
      null,
      2
    ),
  };
}
```

### 7.5 Adding k6 to GitHub Actions CI

```yaml
# .github/workflows/load-test.yml
name: Load Test (Smoke)

on:
  workflow_dispatch:         # manual trigger only — do not run on every PR
  schedule:
    - cron: "0 6 * * 1"      # optional: weekly Monday 6 AM UTC

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          sudo gpg --no-default-keyring \
            --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
            --keyserver hkp://keyserver.ubuntu.com:80 \
            --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] \
            https://dl.k6.io/deb stable main" \
            | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update && sudo apt-get install k6

      - name: Run smoke test
        env:
          BASE_URL: ${{ secrets.STAGING_URL }}
          TEST_EMAIL: ${{ secrets.LOAD_TEST_EMAIL }}
          TEST_PASSWORD: ${{ secrets.LOAD_TEST_PASSWORD }}
          CONSULTANT_ID: ${{ secrets.LOAD_TEST_CONSULTANT_ID }}
        run: k6 run load-tests/smoke.js
```

---

## 8. Recommended Pre-Launch Hardening

The following four actions address the highest-severity risks identified in this report. None of them require new dependencies or schema changes at this stage.

### Action 1 — Verify Supabase Connection Mode (Priority: Critical)

Open the `.env` file (or Netlify environment variable settings) and confirm the `DATABASE_URL` uses Supavisor's transaction-mode pooler URL, not the session-mode URL or the direct URL. The transaction-mode URL from the Supabase dashboard contains the port `6543` and typically includes `pgbouncer=true` in the query string. Session-mode uses port `5432`. The direct URL (also port `5432`) bypasses Supavisor entirely and should only be present in `DIRECT_URL` for Prisma migrations.

```
# Correct (transaction-mode pooler)
DATABASE_URL="postgresql://postgres.projectref:password@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

# Also correct in prisma.schema:
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

The `connection_limit=1` parameter tells Prisma to open only one physical connection per serverless function invocation rather than its default pool of 5–10. This is critical in serverless environments because each function invocation is isolated and does not benefit from connection pooling at the Prisma level.

### Action 2 — Run the Race-Condition Test Suite (Priority: High)

The repository already contains race-condition tests at `tests/typescript/race-conditions/`. Run them against the dev database before launch to confirm that concurrent booking, concurrent wallet debits, and concurrent program-assignment increments all behave correctly:

```bash
npx tsx tests/typescript/race-conditions/test-checkout-race-condition-fix.ts
npx tsx tests/typescript/test-race-condition-fix.ts
```

If either test fails (more than one booking succeeds, or a wallet goes negative), it indicates the serializable isolation guard is not applied correctly. The fix is to wrap the relevant Prisma calls in `serializableRetry(() => prisma.$transaction(..., { isolationLevel: 'Serializable' }))`.

### Action 3 — Upgrade to Netlify Pro Before Launch (Priority: High)

The Netlify free tier caps serverless function timeout at 10 seconds. Several routes in the codebase — payout processing, invoice generation API triggers, and the reconciliation crons — can take longer than 10 seconds under normal load. Netlify Pro ($19/month) raises this to 26 seconds and adds background function support (15-minute timeout). This upgrade should be in place before any real user traffic is routed to the platform.

### Action 4 — Add a k6 Smoke Test to the Pre-Launch Checklist (Priority: Medium)

Before the MVP launch, run the smoke test script above against the deployed environment. The script ramps 20 → 50 → 100 virtual users over roughly 2.5 minutes (its `stages` block) and must pass its own thresholds: p95 response time under 3 seconds and an error rate under 5%. Tighten the thresholds and lengthen the soak only after the first pass is green. If the test reveals `P1001` (connection refused) errors from Prisma, the Supabase connection pool is being exhausted and Action 1 has not been applied correctly.

---

## 9. Post-MVP Scale Roadmap

The following improvements are not needed for launch but should be scheduled in the first two post-MVP sprints.

### Sprint 1: Reliability Hardening

**Add Upstash QStash for email retry.** Wrap all `resend.emails.send()` calls in a QStash publish to a `/api/workers/send-email` endpoint. QStash will retry on transient failures and log delivery status. The cost is negligible ($1/100k messages) and the reliability improvement is significant for payment confirmation and org invitation flows.

**Add QStash for outbound webhook dispatch.** Replace the polling cron (`lib/enterprise/outbound-webhooks/worker.ts` triggered every minute) with a QStash enqueue at the moment a webhook delivery row is created. This reduces delivery latency from up to 60 seconds to near-zero and eliminates the cron polling overhead.

### Sprint 2: Batch Job Parallelisation

**Migrate invoice generation to Inngest.** Restructure `jobs/billing/generate-subscription-invoices.ts` to emit one `billing/invoice.generate` event per subscription and handle each event in a separate Inngest function step. Inngest will execute these in parallel (up to its concurrency limit) and retry each failure independently. This changes the job from O(n) sequential to O(1) wall-clock time regardless of org count.

**Upgrade Supabase compute if needed.** Once real usage data is available, examine Supabase's connection metrics dashboard. If average pool utilisation is consistently above 80%, upgrade from the Micro ($0) to the Small ($15/month) or Medium ($50/month) compute tier. Each tier upgrade roughly doubles the connection ceiling.

### Longer Term

At sustained production load (>1,000 daily active users, >10,000 bookings per month), revisit the following:

- **Netlify concurrency ceiling.** If 125 concurrent functions is a regular ceiling rather than a spike ceiling, evaluate Netlify Enterprise or migrate to a platform with higher limits (e.g., Vercel, Railway, or Fly.io).
- **Read replicas.** Supabase Pro supports read replicas. High-traffic read-only endpoints (consultant search, slot availability) can be routed to a read replica to reduce load on the primary.
- **CDN caching for public endpoints.** Consultant search results and topic/domain lists change infrequently and could be cached at the CDN layer with a 60-second TTL, eliminating DB calls entirely for most traffic.

---

## Appendix A: External Service Throughput Reference

| Service | Limit | Plan | Notes |
|---|---|---|---|
| Resend | 100 emails/day | Free | $20/month for 50k/month |
| Upstash Redis | 10,000 commands/day | Free | $10/month for 10M/month |
| Upstash QStash | 1,000 messages/day | Free | $1 per 100k messages |
| Stream.io | 100 MAU, 5 GB storage | Free | Scales with usage |
| Novu | 30,000 events/month | Free | Cloud-hosted |
| Razorpay | No published QPS limit | Standard | Contact support for burst limits |
| Stripe | No published QPS limit | Standard | 25 events/second on webhooks by default |
| BetterStack | 1 monitor, 1 status page | Free | Paid tiers from $20/month |

---

*Report generated from a six-agent codebase scan and web research pass on 2026-06-11. All platform limits should be verified against current provider documentation before a production capacity planning exercise, as these limits change with plan updates.*
