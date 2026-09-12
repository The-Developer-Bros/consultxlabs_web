# Hosting and architecture alternatives, with 2026 numbers

Compiled on 2026-09-12 to answer one recurring question — whether the pain catalogued in `issue-ledger.md` means the app should have been built on Spring Boot, hosted on Vercel, or split into services around a message broker. The numbers were gathered from vendor documentation and pricing pages by a research pass and the ones that carry the decision (Vercel's duration, memory, concurrency, and regions; Netlify's limits) were re-opened directly. Figures marked "agent-read" were taken from the named primary page without a second opening; figures marked "secondary" come from forums or third-party summaries. Re-open anything older than a quarter before relying on it.

## The shape of the problem

Every mechanism in the ledger is one property of the host showing through: one Node process per instance, started from nothing, at a fixed memory size, serving one request at a time, with its own database pool. The cold stall, the single connection, the request ceiling, the five-minute drain latency, and the build-memory ceiling are all that property. None of them is caused by the volume or complexity of background work, which at pre-launch traffic is small. The question is therefore where the Node process lives, not which language or framework produced it and not whether a broker sits beside it.

## Vercel Fluid Compute beside Netlify Functions

The table below compares the two platforms on the properties that the ledger's mechanisms depend on; Vercel rows were re-opened on 2026-09-12 (fluid-compute page dated 2026-08-24, memory page 2026-07-15, region page 2026-08-11), Netlify rows come from `platform-limits.md`.

| Property                                | Vercel Pro, Fluid Compute                                                                                                                                                                        | Netlify Pro                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Concurrent requests on one warm process | Yes — "multiple invocations share a single function instance"; errors are isolated per request                                                                                                   | No — Lambda-shaped; a burst spins up more instances, each with its own pool                                          |
| Effect on `PG_POOL_MAX=1`               | A normal pool can serve concurrent requests on the same instance; Vercel's own guide recommends reusing one                                                                                      | Structural at any memory size                                                                                        |
| Function duration                       | 300 s default, 800 s maximum on Pro, 1800 s in beta; set per function via `maxDuration`                                                                                                          | 60 s Lambda limit; ~26 s edge cut for a silent response; 15 min only in a Background Function                        |
| Memory and CPU                          | 2 GB / 1 vCPU default ("Standard"); 4 GB / 2 vCPU ("Performance"); dashboard-only, project-wide                                                                                                  | 1024 MB / 0.5 vCPU default; 1024–4096 MB per function or project-wide; did not fix the stall here                    |
| Cold-start mitigation                   | Bytecode caching on Node 20+ in production; pre-warming on production deployments; instance reuse                                                                                                | None documented; the stall in #1124 is unexplained                                                                   |
| Region near Supabase Mumbai             | `bom1` (Mumbai) exists, with its own regional pricing page; Pro may run functions in up to 5 regions (the fluid-compute page says 3)                                                             | `sin` (Singapore) is the closest offered                                                                             |
| Cron                                    | One-minute minimum, up to 100 jobs per project on Pro (agent-read); a cron invokes an ordinary function and inherits its `maxDuration`                                                           | One-minute minimum, 30 s limit, published deploys only                                                               |
| Unzipped function size                  | 250 MB (the same Lambda-derived limit; Vercel publishes a troubleshooting guide for it)                                                                                                          | 250 MB                                                                                                               |
| Price                                   | $20 per seat per month plus $20 usage credit; then Active CPU ≈ $0.128/CPU-hour, provisioned memory ≈ $0.0106/GB-hour, invocations $0.60/M (agent-read, usage-and-pricing page dated 2026-06-16) | $20 per month with unlimited seats since 2026-04-14, 3,000 credits included; compute 10 credits/GB-hour (agent-read) |

The first two rows are the ones that matter. Vercel is the only hosted-serverless option that documents sharing one warm process across concurrent requests, which is precisely the property whose absence produced ledger group 1. The `bom1` row removes ledger group 2 outright. The duration row removes group 4. Nothing in the table addresses the 250 MB cap.

## Always-on hosts

An always-on Node process removes cold starts, shares one pool across concurrent requests, and has no request ceiling of its own; every one of these hosts runs `next start` from `output: "standalone"` unchanged. The cost of that property is a machine that is paid for while idle and a host that no longer builds and previews the site for us. The figures below are agent-read from each vendor's pricing page on 2026-09-12 unless marked.

Fly.io Machines: a `shared-cpu-1x` machine with 1 GB runs in the region of $6–13 per month depending on preset; `min_machines_running` defaults to 0 with autostop and autostart, which reintroduces cold starts unless pinned to at least 1; Fly publishes a Next.js guide that generates the Dockerfile.

Railway: Hobby $5 per month with $5 credit, Pro $20 per seat with $20 credit; metered at roughly $10 per GB-month of RAM and $20 per vCPU-month, so a continuous 1 GB / 1 vCPU service is about $25–30 of usage; services are long-running with no per-request spin-up and no default scale-to-zero.

Render: Starter $7 per month at 512 MB / 0.5 CPU, Standard $25 per month at 2 GB / 1 CPU, no 1 GB tier (secondary — the pricing page did not fully render); paid tiers are always-on; the free tier sleeps after 15 minutes idle.

AWS App Runner: about $5 per month for 1 GB provisioned idle, keeps at least one instance and so has no cold starts — but it stopped accepting new customers on 2026-04-30 and AWS points new work at ECS Express Mode.

AWS ECS Fargate: $0.04048 per vCPU-hour and $0.004445 per GB-hour in `us-east-1`, so 1 vCPU / 1 GB always-on is about $33 per month and 0.25 vCPU / 1 GB about $11; no scale-to-zero; needs a container image; `ap-south-1` is available.

Each of these puts the process in a region of our choosing, including Mumbai, and each requires us to run the deploy pipeline and preview environments that Netlify currently provides.

## Spring Boot instead of Next.js

The startup numbers below are from Spring's, GraalVM's, Oracle's, and AWS's own documentation (agent-read). A plain Spring Boot service on HotSpot starts in a few seconds; a GraalVM native image starts in tens of milliseconds ("typically 50x faster than the startup time on a regular JVM", Spring blog 2023-10-16, with an 80 ms example in Spring's docs); CRaC gives a similar few-dozen-millisecond restore; AWS Lambda SnapStart advertises "up to 10x faster" for Java. No primary source benchmarks `next start` process boot on a plain container; the 28–32 s figure measured here is a Netlify cold boot at 1024 MB, not a comparable number.

The capability cost is concrete: React Server Components' co-located server data fetching has no JVM equivalent, so a Spring backend needs a separate client data layer; Prisma has no Java port, so the schema and every query move to JPA, Hibernate, or jOOQ; Better Auth is a TypeScript library, so authentication is rebuilt on Spring Security; and the single Next.js deploy becomes two services with a network hop between them. A JVM on a 1 GB box cold-starts no better than Node unless it is native-compiled and always-on — and always-on is the hosting change doing the work.

## Brokers, queues, and the outbox

The transactional outbox pattern, as defined at microservices.io, exists to avoid the dual write: the event is written in the same transaction as the business row and a relay publishes or executes it later. The relay may crash after acting and before marking done, so consumers must be idempotent whatever the relay is. This repo's drain is the five-minute ticker over the `/api/cleanup/*` twins; its only defect relative to a broker is latency and the absence of per-step checkpoints. The table below gives each option's floor cost, whether it needs a process a serverless host cannot provide, and what it prevents that the outbox drain does not (agent-read from each vendor's pricing and docs, 2026-09-12).

| Option                  | Floor cost at low volume                                                     | Needs a long-running consumer            | Prevents what the outbox drain does not                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Kafka (Confluent Cloud) | Near $0 for a dev cluster; ~$385/month for a production tier (single-source) | Yes                                      | Ordered replayable log, multi-consumer fan-out, sub-second delivery                                                          |
| RabbitMQ (CloudAMQP)    | Free shared tier at 1M messages/month; $50/month dedicated                   | Yes                                      | Push delivery, broker-side redelivery, exchange routing                                                                      |
| BullMQ on Redis         | Library is free; needs Redis plus a persistent Node worker                   | Yes, by its own docs                     | Sub-second pickup, priorities, delays, per-job backoff                                                                       |
| Upstash QStash          | Free at 1,000 messages/day; $1 per 100K pay-as-you-go                        | No — HTTP callbacks into existing routes | Seconds-level delivery and per-message retry and dead-letter without a hand-written loop                                     |
| Inngest                 | Free at 50K executions/month; Pro from $99/month                             | No                                       | Step-level durable execution and event fan-out                                                                               |
| Trigger.dev             | Free with $5 compute credit; Hobby $10, Pro from $50                         | No, but runs on its own compute          | Tasks beyond a function's duration ceiling, per-run logs                                                                     |
| Netlify Async Workloads | No separate line; billed as function compute                                 | No — wraps Netlify Functions and Blobs   | Escalating retry backoff (5 s → 20 s → 80 s → 8 min, up to about a week) and multi-step durable execution; ~500 KB per event |

Every option with a "Yes" in the third column requires the always-on process that ledger group 1 shows the current host cannot supply, which is why ADR 14 rejected a broker. Of the "No" options, Async Workloads and QStash are the two that fit the existing CRON_SECRET routes without new infrastructure; #1010 should be decided between them.

## Background Functions against the five-minute ticker

From Netlify's Background Functions page (last updated 2026-06-03): fifteen-minute limit; an immediate 202 with the return value discarded; on error one retry after one minute and a second two minutes later. A scheduled function may hand long work to a background function, but the older `context.client.invokeBackgroundFunction` is absent from the current context reference and should be treated as legacy. Under Next.js runtime v5 a route cannot be declared background — the in-route `experimental-background` config belongs to runtime v4 — so `background: true` applies only to a standalone file under `netlify/functions/`, which is the pattern `cron-tick.mts` already uses. A background driver that loops bounded calls to an HTTP twin is therefore the platform-native way to run a job past the request ceiling without a queue.

## A reading of the evidence, dated 2026-09-12

This section is a recommendation, not a decision; the decision belongs to the lead engineer and would be recorded under `docs/decisions/`.

The monolith, Next.js, and the no-broker posture are all supported by the numbers: the background work is small, the outbox drain is the correct pattern for it, and a broker would import the always-on requirement rather than remove it. Spring Boot buys nothing the always-on property would not buy on its own and costs the RSC, Prisma, and Better Auth investments. The live question is the host, and it is binary: either stay serverless on a platform whose instance shares a process and offers Mumbai — which today means Vercel Fluid Compute — or run one always-on Node process on Fly, Railway, or Fargate and accept owning the pipeline and previews. Staying on Netlify keeps every mechanism in ledger groups 1 to 4 and relies on a support ticket for the stall. The cheapest next experiment is a Vercel preview of the `dev` branch with `bom1` and Fluid defaults, re-running #1124's twelve-request burst protocol and the `PG_POOL_MAX` deadlock repro from #1435 against it; that is a day of work and produces the only numbers this file cannot.

## Sources

- Vercel fluid compute (concurrency, bytecode caching, durations): https://vercel.com/docs/fluid-compute
- Vercel memory and CPU: https://vercel.com/docs/functions/configuring-functions/memory
- Vercel regions for functions: https://vercel.com/docs/functions/configuring-functions/region and https://vercel.com/docs/regions
- Vercel usage and pricing (agent-read): https://vercel.com/docs/functions/usage-and-pricing and https://vercel.com/docs/cron-jobs/usage-and-pricing
- Vercel connection pooling guide (agent-read): https://vercel.com/kb/guide/connection-pooling-with-functions
- Netlify pricing update 2026-04-14 (agent-read): https://www.netlify.com/changelog/2026-04-14-pricing-updates-april-2026/
- Netlify Async Workloads (agent-read): https://docs.netlify.com/build/async-workloads/overview/ and https://docs.netlify.com/build/async-workloads/limitations/
- Netlify Background Functions: https://docs.netlify.com/build/functions/background-functions/
- Netlify Next.js runtime v5 overview and legacy advanced API routes (agent-read): https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/ and https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/legacy-runtime/advanced-api-routes/
- Fly.io pricing, autostop, Next.js guide (agent-read): https://fly.io/docs/about/pricing/ · https://fly.io/docs/launch/autostop-autostart/ · https://fly.io/docs/js/frameworks/nextjs/
- Railway pricing and Next.js guide (agent-read): https://railway.com/pricing · https://docs.railway.com/guides/nextjs
- Render pricing (secondary): https://render.com/pricing
- AWS App Runner availability change and pricing (agent-read): https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html · https://aws.amazon.com/apprunner/pricing/
- AWS Fargate pricing (agent-read): https://aws.amazon.com/fargate/pricing/
- Spring runtime efficiency blog and native-image docs (agent-read): https://spring.io/blog/2023/10/16/runtime-efficiency-with-spring/ · https://docs.spring.io/spring-boot/reference/packaging/native-image/introducing-graalvm-native-images.html
- AWS Lambda SnapStart (agent-read): https://docs.aws.amazon.com/lambda/latest/dg/snapstart.html
- Transactional outbox: https://microservices.io/patterns/data/transactional-outbox.html
- Queue vendors (agent-read): https://upstash.com/pricing/qstash · https://www.inngest.com/pricing · https://trigger.dev/pricing · https://www.cloudamqp.com/plans.html · https://docs.bullmq.io/guide/going-to-production · https://www.confluent.io/pricing/
