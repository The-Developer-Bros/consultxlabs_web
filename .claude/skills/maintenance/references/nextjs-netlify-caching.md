---
name: nextjs-netlify-caching
description: Decide and verify how a Next.js App Router route renders, caches and revalidates on Netlify — static vs ISR vs dynamic, revalidate windows, on-demand purge, the Netlify durable cache, and the specific traps that make a route silently dynamic or silently un-server-rendered. Use when adding or changing `export const dynamic` / `export const revalidate` / `generateStaticParams`, when a page is slow or its TTFB/FCP is bad, when SSR output looks empty, when asked "should this be ISR", or before claiming any rendering or caching change actually worked.
---

# Next.js App Router rendering and caching on Netlify

This skill encodes what was measured on this codebase during the 2026-07/08 dashboard-performance campaign, not what the framework documentation promises. Where the two disagree, the measurement is recorded and marked. Version-sensitive facts are pinned to Next 15.5.15 and the Netlify Next Runtime. Re-verify them after **any** change to the Next version or the Netlify adapter/runtime, not only a major one — the adapter ships independently of our releases and is not version-pinned in this repo, so its behaviour can change under a build we did not trigger. Record the exact versions alongside any new measurement you add.

## The rule that outranks everything else in this file

Every confident claim made by reasoning about code structure, without measuring, was wrong at least once during this campaign. Every measured claim held. Green CI is not verification: `tsc`, ESLint and the full Jest suite were all green on a build that failed, on a route that returned 500 on every request, and on three separate changes that moved no metric at all.

Therefore, never report a rendering or caching change as working until you have observed the specific artefact listed under "How to verify" below. If you cannot observe it, say the change is unverified rather than describing what should happen.

## Step 1 — Classify the route before touching anything

Ask what the response depends on, because that determines the strategy and nothing else does.

| The response varies by | Correct strategy | What to export |
|---|---|---|
| Nothing; it is the same for every visitor | Static, or ISR if the content changes | `export const revalidate = N` (omit for fully static) |
| Public data that changes on a human timescale | ISR with a revalidate window | `export const revalidate = N` |
| A high-cardinality or unbounded path parameter over public data | On-demand ISR | `export const revalidate = N` **and** `generateStaticParams()` returning `[]` |
| The signed-in user, their role, their organisation, or their money | Dynamic | `export const dynamic = "force-dynamic"` |

Two corollaries that are easy to get wrong on this codebase.

A page whose data is public but whose *chrome* differs for signed-in visitors is still a static page. The auth-dependent affordance belongs in a **client-only** component that resolves the session in the browser, not in the page's server render. Note that a server-rendered "dynamic island" is not an option on our pinned version: without PPR, a request-scoped read inside a `Suspense` boundary still forces the whole route dynamic — see the rejected-options section. Pulling a session read into the page body to swap one button converts the whole route to dynamic and forfeits the cache.

A route parameter with unbounded cardinality must never be prerendered exhaustively at build. Returning `[]` from `generateStaticParams` means nothing is built ahead of time, each parameter renders on its first request, and the result is then cached and revalidated on the window. Confirm `dynamicParams` is left at its default of `true`, or unlisted parameters will 404 instead of rendering.

## Step 2 — Know what silently pins a route to dynamic

Reading any request-scoped API anywhere in a route's server render tree forces that route dynamic regardless of what it exports. The route will keep rendering as `ƒ` and your `revalidate` will be inert, with no error and no warning. The APIs that do this are `cookies()`, `headers()`, `draftMode()`, `connection()`, and `searchParams`.

The read does not have to be visible in the page file. A shared helper, an auth guard, or a data-layer function three imports deep will do it. Before adding `revalidate` to any route, trace its full server import graph for those five APIs and report what you found per route.

On this codebase specifically, note that an `export const revalidate` on a route that is already dynamic produces an **empty** Revalidate column in the build route table. That empty column is the tell that the export did nothing. It was exactly the defect in the first shape of PR #1110, where the two heaviest reads carried a revalidate that never applied.

## Step 2b — Your `revalidate` is a ceiling, not a setting

A route's effective revalidate is the **minimum** of its segment-level `revalidate` and every data-cache entry read during that render. A short `unstable_cache` window deep in the data layer silently caps the whole route, with no warning.

This was measured on #1110: `/` declared `revalidate = 3600` and the build table reported `2m`, because 120-second `unstable_cache` windows in `lib/data/home.ts` were pulling it down. Raising those windows to match was what made the declared value real. Whenever the build table shows a revalidate you did not ask for, this is the first thing to check.

## Step 2c — Read the route-table symbols precisely

The build table distinguishes three states, and conflating the last two wastes time. `○` means prerendered as static HTML at build. `●` means prerendered as static HTML *using `generateStaticParams`*. `ƒ` means rendered on demand.

A `[param]` route with `generateStaticParams` returning `[]` renders as `●` with an **empty Revalidate column**, and this is correct rather than broken. The Revalidate column is populated from prerendered entries, and returning `[]` deliberately produces none, so a non-empty column there and an empty build-time prerender list are mutually exclusive by construction. Do not chase it.

To confirm ISR really is active on such a route, verify at runtime instead: request it on a deploy preview and check that `cache-control` is `public` rather than the dynamic route's `private, no-cache, no-store`, then request it again and confirm the `age` header climbs. A climbing `age` is one cached object aging, which is the proof; a dynamic control route requested alongside it makes the comparison airtight.

## Step 3 — Understand what build-time prerendering costs here

A route that renders `○` in the build route table executes its Server Component data reads **inside `next build`**. On this project that has three consequences worth stating plainly.

The build must reach Supabase. CI decodes a real `.env` before building, so it does. Issue #932 records a build that crashed on a cold cross-region pooler connect, so this is a demonstrated failure mode rather than a theoretical one.

Every Netlify context — deploy preview, branch deploy and production — shares one Supabase database. Build-time reads therefore touch production data from preview builds. This is a real consequence of choosing prerendering and belongs in any PR description that introduces it.

Worst of all, a swallowed error at build time gets frozen into the output. This codebase's `fallbackOnTransientDbError` used to return empty on a transient failure, and the empty result was baked into static HTML. The ISR cache turned out to be the same hazard as build output, so since #1123 the helper rethrows unless a call site opts in with `perRequest` — see "Fail-open and a cacheable response" below.

The guard for this is to rethrow during the build phase, converting a silent bad bake into a visible, retryable build failure:

```ts
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// A swallowed transient error at build time is baked into static HTML. Fail
// loudly instead — a retried build is cheap, a silently empty page is not. #932
if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) throw err;
```

`PHASE_PRODUCTION_BUILD` is verified present in `next/constants` at Next 15.5.15 with the value `phase-production-build`. Import the constant rather than hardcoding the string. Pair the guard with a bounded retry and backoff, because #932 was a *cold* connect and a retry may therefore help. That it converts a hard failure into a success is untested — no measurement here exercised the retry path — so treat it as a hypothesis and measure before claiming it works.

## Step 4 — Cache headers follow the strategy, and you do not choose them

Next.js sets `Cache-Control` purely from the rendering strategy of each route. You cannot negotiate with this from inside the app.

| Strategy | Header Next.js emits |
|---|---|
| Static, no revalidation | `s-maxage=31536000` |
| ISR, time-based revalidation | `s-maxage={revalidate}, stale-while-revalidate={expire - revalidate}` |
| Dynamic | `private, no-cache, no-store, max-age=0, must-revalidate` |

The third row is the whole argument against `force-dynamic` on public pages: it makes them uncacheable at every CDN by construction, so each visitor pays a full origin round trip. On this deployment that is Netlify `ap-southeast-1` to Supabase `ap-south-1`, and the tail was measured at 30–33 seconds. See "What the 23-second TTFB actually decomposes into" below — the cost is a ~24 second event-loop stall on a newly created instance, not the round trip and not the boot.

The converse is the strongest argument for prerendering public pages: a prerendered page is served as static HTML from the edge with **no function invocation at all**, so it also sidesteps the cold start entirely on the pages where LCP matters most.

## Step 5 — What Netlify adds on top

The Netlify Next Runtime implements Next's cache handler against Netlify Blobs, so both the Full Route Cache and the Data Cache are durable and shared across every function invocation and CDN node rather than being per-instance. Cacheable responses on Runtime 5.5.0 and later automatically use the durable cache, and an edge node without a local copy checks the durable cache before invoking a function. This means `unstable_cache` and ISR results genuinely persist between requests here — do not assume serverless per-instance memory semantics.

When you need to cache a response Next would mark uncacheable, Netlify honours cache-control headers in order of specificity: `Netlify-CDN-Cache-Control` wins over `CDN-Cache-Control`, which wins over `Cache-Control`. Both `s-maxage` and `stale-while-revalidate` are supported, and `Cache-Control` and `CDN-Cache-Control` are always passed downstream so other caches can use them. Function responses are not cached by default precisely because they are dynamic, so caching them is an explicit opt-in via those headers.

Only reach for that opt-in on a response that is safe to share between users. These headers target a **shared** cache, so applying them to a response whose body depends on `cookies()`, `headers()` or session state will serve one visitor's page to the next one. If the response varies by any request input, that input must appear in the cache key via `Netlify-Vary` before the override is safe; if it varies by identity, it should stay private and uncached. Note that this failure is silent and will not reproduce for the first user who loads the page.

For invalidation, `revalidatePath` and `revalidateTag` both work and propagate through the durable cache. A copy cached at the CDN purely by an `s-maxage` header is a different matter: `revalidateTag` invalidates the Next server cache but the CDN keeps serving its copy until the TTL expires, so a raw CDN cache needs `Netlify-Cache-Tag` on the response and a `purgeCache({ tags })` call alongside the revalidation.

Documented adapter limitations worth remembering: pages set to the `edge` runtime actually run in the functions region, `beforeFiles` rewrites cannot point at static files in `public/`, and headers and redirects are evaluated after middleware.

## How to verify — the only four techniques that have worked here

**Read the CI build route table.** This is authoritative for *build-time* classification — whether a route prerenders at build, and what revalidate the build applied — and it settled the #1110 dispute definitively. It is not authoritative for on-demand ISR, where a `●` route legitimately shows an empty Revalidate column and no build entries; confirm those at runtime from `cache-control` and a climbing `age` instead, as described in Step 2c. `○` means prerendered at build; `ƒ` means dynamic; the Revalidate column shows whether a `revalidate` export actually applied. Pull it from the `TypeScript, Tests & Build` check run with `gh run view --log` and paste the actual lines into your report. Never run `next build` locally — it is RAM-heavy and has taken this machine down.

**Stream the HTML and grep for markup that should be present.** Distinguish real markup (`">Members<"`) from the RSC flight payload (the bare string `Members`). If the string appears only in the payload, the content was **not** server-rendered, however much it looks present in the browser. When the bare-string count equals the markup count, there are no payload-only occurrences and the result is genuine.

**A/B two deploy previews.** Same account, same page, exactly one variable changed. This is what finally proved both real wins in this campaign, and what exposed a route returning 500 on every request that CI had called green.

**Read the `Cache-Status` response header.** Netlify emits RFC 9211 `Cache-Status`, and it answers "was this response written to the durable cache" outright, which no amount of reasoning about status codes will. `"Netlify Durable"; fwd=uri-miss; stored` means it was stored; `"Netlify Durable"; hit` with a climbing `age` means it is being replayed; `"Netlify Durable"; fwd=bypass` alongside a 500 means nothing was persisted. This is the artefact that proved both the #1119 bug and its fix.

**Warm the function first.** Cold measurements on this deployment span 1.9 s to 33 s on the same route, so any single cold timing is noise. Warm the instance, or take enough cold samples to see the distribution — it is bimodal, not noisy-around-a-mean, and the mean is meaningless.

## Measured facts that keep getting rediscovered

A skeleton cannot fire First Contentful Paint. FCP requires text, an image, canvas or SVG, and a component built purely from `Skeleton` boxes has none of those. Measured on #1102: the shell HTML arrived at 458 ms while FCP still waited about 6 s for real text. If a surface needs an early FCP it must render actual text, not a placeholder for it.

`next/dynamic` with `ssr: false` skips server rendering for the component **and all of its children**. Wrapping `{children}` in such a component removes an entire subtree from the HTML. Its options must also be an inline object literal at each call site, because SWC analyses them statically — hoisting them to a `const` passes `tsc`, ESLint and Jest and then fails the build.

A client layout that returns a skeleton while its queries load returns that skeleton during SSR too, because nothing prefetched those queries on the server. The fix is to seed the query from a server component with `prefetchQuery` plus `dehydrate` and a `HydrationBoundary`. Both sides must derive an identical key *value*. That is why seeding failed here: the client keyed on `useSession()`, which is still pending during SSR, so its key was `["user-details", undefined]` while the server seeded the real id. Passing the resolved user id down from the server — the same serialized value on both sides — is what fixes it. The mismatch is invisible to `tsc` and to every test.

A `loading.tsx` creates an implicit Suspense boundary, which is what allows a layout to flush while its page is still pending.

`React.cache` memoizes fulfilled results but **not** rejections. Retrying a `cache`d reader therefore really re-runs the query rather than replaying the failure — checked directly against the React that Next 15.5.15 vendors (`next/dist/compiled/react`, `19.2.0-canary-0bdb9206`), for a thrown error and a rejected promise alike. Note that `react` in `package.json` is 18.3.1 and its `cache` is unusable outside experimental channels, so test against the vendored copy, not the installed one.

## The database connection pool holds one client, so parallelising queries wins nothing

`PG_POOL_MAX` is set to **1** on production, deploy preview and branch deploy alike, and `lib/prisma.ts` passes it to `pg.Pool` as `max`. Each function instance therefore holds exactly one client, and concurrent Prisma queries serialise instead of overlapping.

The practical consequence is that wrapping independent Prisma reads in `Promise.all` cannot make anything faster on this deployment. This was measured rather than assumed: across 20 order-balanced interleaved rounds against a real session, the parallelised branch came in at 1,176 ms against 1,142 ms sequential, while anonymous requests were identical on both deployments at 557 and 558 ms, ruling out a deployment-level offset. The change was reverted inside the PR that introduced it.

Check `PG_POOL_MAX` before proposing any "these queries are independent, parallelise them" optimisation anywhere in this codebase. The idea is dead until the pool is widened, and widening it is a capacity question about Supabase pooler limits across concurrent function instances rather than a config tweak. It is tracked as issue #1117.

This also reframes the wave-depth measurements. The finding that one `appointment.findMany` issues 30 SQL statements for 3 appointments, with summed database time of 3,108 ms exceeding wall time of 1,127 ms, is about statement count under a serialising pool as much as about cross-region round trips. That makes Prisma's `relationJoins` more promising than it first appeared, because collapsing statement count is the only lever a single connection responds to.

## What the 23-second TTFB actually decomposes into

This was measured on 2026-08-09 against deploy preview 1118, anonymously, on `/explore/experts/[consultantId]` — an on-demand ISR route, so every distinct parameter forces one real server render. Forty-two cold renders were taken across four batches. Every number below is client-side `time_starttransfer` from `curl`, correlated against the Netlify function log.

The headline is that the 23-second figure was misattributed. Cold boot and render cost are both ruled out by measurement below.

**The database is not the slow part, and the ~30 seconds is a stalled event loop on a newly created function instance.** This was settled on 2026-08-09 against deploy preview 1123 by a diagnostic route that reported instance identity, `process.uptime()`, an event-loop lag probe, and per-attempt connect timings in its response body — see "The connect budget cannot be enforced" below. The earlier reading on this page, that a pooler connection was the thing timing out, was wrong: the connect error is a *casualty* of the stall, not its cause.

The evidence is a bimodal distribution with nothing in the middle:

| Batch | Concurrency | Instance state | Samples | Result |
|---|---|---|---|---|
| A | 1 (strictly sequential) | new | 8 | 1.80–2.72 s, median 1.88 s, no outliers |
| B | 12 concurrent | mostly new | 12 | six at 1.90–4.66 s, six at 30.99–33.08 s |
| C | 16 concurrent | 12 already warm | 16 | twelve at 2.64–2.94 s, four at 30.83–33.12 s |
| D | 12 concurrent | all warm | 12 | 3.33–5.89 s, zero slow |

No sample in those four batches landed between 6.8 s and 30.8 s. The gap is the signature of the cold-instance stall: an instance either serves normally or loses roughly 24 seconds to it, with nothing in between. The shape replicated exactly on 2026-08-09 against `dev` at 1fa94c17 — eight sequential renders at 1.79–4.94 s with no outliers, then twelve concurrent renders splitting one fast at 1.85 s, six at 30.67–32.68 s and five hard 500s at 36.3 s.

The pattern replicated on a second, independently built deploy: eight concurrent requests, all against brand-new instances, split five fast at 9.20–11.40 s and three slow at 34.16–36.76 s, with the same `prisma:error timeout exceeded when trying to connect` and a 29,155 ms invocation in the log (that error is a casualty of the stall, not its cause — see below). Note that the fast mode there is 9–11 s rather than 2–3 s, because *every* instance in that batch was new — so the fast mode is not a constant, but the gap is always present and the slow mode always lands at 30–37 s.

Batch A settles the cold-boot question on its own: a brand-new instance rendering a real database-backed page sequentially costs about 1.9 seconds end to end. Boot is not the problem. Batch D settles the concurrency question: twelve simultaneous renders against warm instances cost 3.3–5.9 seconds and never degrade. What produces the tail is instance creation: concurrency forces new instances, and a new instance pays the stall.

The slow-count arithmetic supports that reading directly. Batch B ran twelve requests against roughly six existing instances and produced exactly six slow responses; batch C ran sixteen against the roughly twelve instances batch B had created and produced exactly four. In both cases the number of slow responses equals the number of instances that had to be created. The log does not expose instance identity, which is why this was inference at the time; a diagnostic route that returned a per-instance id later confirmed it directly — every stalled sample had an instance age under 100 ms and an invocation count of 1.

Three further facts are worth carrying forward, because each one costs an afternoon to rediscover.

**On this path, one HTTP request was one function invocation.** Six concurrent uncached `/explore/experts/[consultantId]` document requests produced exactly six `Duration:` lines, and each client timing exceeded its matching invocation duration by a near-constant 0.37 s of CDN and network overhead. The 32.23 s request maps to a single invocation of 30,113.69 ms. So for these requests nothing chained, nothing was retried by the platform, and the document request was not followed by a second billable render.

Do not promote that to a platform rule — it is a statement about anonymous document requests to this route. A logged-in dashboard navigation, a route that redirects, or a client-side RSC fetch can each add invocations. What it does rule out is explaining *this* measurement by a redirect chain, a middleware hop or an RSC follow-up, because none of those appeared.

**Do not plan on reading `Init Duration` here.** Netlify documents it as the cold-start discriminator, and staff describe a full Lambda-style report line — `Duration … Billed Duration … Memory Size … Max Memory Used … Init Duration …`. The Next.js server handler on this account does not emit that. Through both `netlify logs` and its historical API the line is reduced to `Duration:` and `Memory Usage:` only. A user on Netlify's own forum reports the identical absence for this same function ("I have checked my full log and I can't find any `init duration` in it"). Whether the dashboard UI shows more was not checked.

Two substitutes work instead. An invocation *start* appears as an info line with an empty message, so start and end pair by adding the duration to the start timestamp — verified exact to the millisecond. And a genuine module load prints the Better Auth pair `Social provider github is missing clientId or clientSecret` / `… facebook …`, which makes each new instance countable.

**You cannot add a `console.*` line to server code and read it in production.** `next.config.mjs` sets `compiler.removeConsole: process.env.NODE_ENV === "production"`, and this strips server-side console calls too, not just client bundles. It was tested directly: a `console.warn` added at Prisma client construction produced **zero** occurrences in the function log across a deploy where two module loads were independently confirmed by the Better Auth markers in the same window. The reason third-party lines still appear is that `node_modules` is not compiled by SWC — which is exactly why Better Auth and `prisma:error` survive while our own would not.

The practical consequences are worth stating plainly. Any diagnostic you add this way is inert in production while passing every local check, so it is worse than nothing. Roughly 993 `console.*` call sites already exist under `lib/` and `app/api`, all of them silently dead in production, including the ones the comment in `lib/prisma.ts` cites as "the lib/ convention" — see issue #1122. Reach for `Sentry.logger` instead, but note it ships to Sentry rather than to the function log, so it does not help anyone reading `netlify logs`.

### The connect budget cannot be enforced, and the reason is not the database

`lib/prisma.ts` tunes a 3 s connect budget, and that value really is passed through to `pg.Pool` — verified in `node_modules/@prisma/adapter-pg/dist/index.mjs`, where the factory hands its config straight to `new pg.Pool(...)`, and reproduced locally, where a black-holed connect with `connectionTimeoutMillis: 3000` failed in 3,003 ms with the exact two error strings seen in production. Prisma itself does not retry: one query is one connect attempt.

Yet a production invocation logged that connect timeout at t+29.78 s. The reason is that **both pg timers are plain `setTimeout`s** — `pg-pool/index.js:219` for the queue wait and `pg/lib/client.js:148` for the socket — and a `setTimeout` cannot fire while the event loop is blocked.

Measured on deploy preview 1123 with a diagnostic route that ran 400 ms of pure idle `await` **before touching the database at all**, then reported the loop lag it observed. Three of forty invocations came back like this:

| instance age | `process.uptime()` | invocation | 400 ms idle phase took | max loop lag | first DB attempt |
|---|---|---|---|---|---|
| 40 ms | 3,363 ms | 1 | 23,905 ms | 23,746 ms | ok in 862 ms |
| 39 ms | 3,361 ms | 1 | 24,634 ms | 24,534 ms | ok in 866 ms |
| 100 ms | 3,355 ms | 1 | 24,823 ms | 24,655 ms | ok in 1,037 ms |

The other thirty-seven, all on instances at least 47 s old, completed the same idle phase in 400–453 ms with lag of 1–70 ms. So the stall is roughly 24 seconds, it happens **before any database work**, and it happens only on a brand-new instance serving its first invocation. The database query that follows takes about a second — and in an earlier round where a connect *did* get caught by the stall and failed after 25.7 s and 26.1 s, the immediately retried attempt connected in 340 ms and 327 ms.

Three consequences worth carrying forward. No value of `PG_CONNECT_TIMEOUT_MS` can bound this, so do not propose tuning it. `prisma:error timeout exceeded when trying to connect` in the function log is not evidence that the pooler is unhealthy — check whether the instance was new before believing it. And the only lever that reliably helps is not invoking the function at all, because an ISR cache hit costs no instance and therefore pays no stall.

A request-time retry looks like the obvious second lever and was written, then **reverted inside #1123**. The attempt straight after a stalled connect really does succeed in 327–340 ms, but that was two diagnostic samples and the effect could not be separated from the rethrow in the page-level A/B. Against it: retrying per read doubles the query count on pages that issue four of them, `PG_POOL_MAX=1` serialises those, and a saturated pooler then pushes the render toward the function ceiling — where the response is a bare platform 500 with no error boundary and no `Cache-Status` at all, strictly worse than a fast 500. Do not reinstate it without a per-render budget and fault-injected evidence.

The function runs with `AWS_LAMBDA_FUNCTION_MEMORY_SIZE=1024`, a V8 heap limit of 1,018 MB and 675–795 MB RSS at rest, and Lambda scales CPU with memory. That the stall is cold-instance JS/GC work at that CPU share is the obvious reading but is **inferred**, not measured. `NODE_OPTIONS=--max-old-space-size=6144` from `netlify.toml` was suspected and ruled out: `process.env.NODE_OPTIONS` is `null` inside the function, so `[build.environment]` does not reach the runtime.

Do not treat the platform ceiling as a backstop either. Netlify documents 10 s by default and 26 s maximum on paid plans, yet invocations of 26.4 s to 31.9 s were logged on this Pro account. The stall itself is tracked as issue #1124; #1120 is closed by #1123, which established that it is not a database problem.

### The 2026-08-22 memory A/B: assessed and reverted — and what it disproves

The "CPU-starved cold-boot" reading above became testable when Netlify shipped per-function `memory`/`vcpu` config (Credit-based Pro/Ent; `memory` and `vcpu` **scale together**, so setting either tests the same lever). Applied correctly at 2048 MB to the v2 handler and measured under the identical 12-way concurrent unique-key burst protocol:

| Deploy | Handler memory | Result |
|---|---|---|
| control (1024 MB) | 1024 | 11/12 slow, TTFB 27.8–31.0 s |
| treatment | 2048 | 11/12 slow, TTFB 35.9–37.6 s + one platform 500 |

No improvement, possibly worse. Reverted in 08b10ce4. Two conclusions: the CPU-share hypothesis for the stall is **weakened**, not confirmed — doubling per-instance CPU should have shrunk a CPU-bound stall and moved nothing; and any artifact claiming memory "resolved" the stall descends from a misattributed burst that ran during a hyperactive window (three deploys + two agent sessions within nine minutes) where residual warm capacity produced the fast numbers.

**Method traps this cost a day to learn.** Runtime API v2 generates ONE function named `___netlify-server-handler`; overrides targeting v1 names (`___netlify-handler`, `___netlify-odb-handler`) are silently ignored — verify with `netlify api searchSiteFunctions --data '{"site_id":"…"}'` (record field `m`). Netlify deploy IDs do not visibly map to commits: `netlify api listSiteDeploys` → `commit_ref` does, and every cross-deploy claim must use it. Cross-preview A/Bs confound ISR cache freshness with instance-pool age; only same-deploy comparisons count.

**Where this leaves the levers.** Warming workflows (#1148 keep-warm/warm-deploy) protect only the lone-click case — one ping keeps one instance warm and cannot cover bursts. App-side init work is bounded by measurement (solo new instance = full boot + render in ~1.9 s), so shaving SDK init buys fractions of that budget, nothing more. If the tail remains unacceptable after code hygiene, the remaining lever is architectural — always-on compute for SSR — not more warming machinery. A support ticket with the evidence pack lives at `docs/perf/netlify-stall-ticket-draft.md`.

The warm-then-burst close-out (2026-08-23, preview-1148): idle→6-burst stalled 6/6 at 30.6–32.0 s; ~150 s of sustained sequential traffic kept essentially ONE instance warm (every subsequent unique-key RSC fetch served from the ISR/durable cache at ~0.24 s); an immediate 12-burst still stalled 4/12 at 27.8–30.3 s plus a platform 504. Concurrency width alone forces fresh instances into the stall seconds after heavy activity — no ping cadence can prevent it. The same day, a build carrying lazy-initialized Razorpay/Stripe clients (#1221) reproduced the stall at full strength (12/12 slow, 29.5–31.5 s after ≥30 min idle) while its sequential profile was textbook — second independent confirmation, after the CPU-doubling null result, that the stall does not scale with application init work. Do not re-propose bundle-shaving as a stall fix.

### Fail-open and a cacheable response are safe alone and dangerous together

A fail-open path on an ISR route converts a transient database blip into a cached artefact. `fallbackOnTransientDbError` rethrew during `next build` but degraded at request time, and on `/explore/experts/[consultantId]` that produced HTTP 200 responses carrying the degraded shell at 66 KB against a healthy 104–118 KB. Ten of forty concurrent cold renders came back that way, each with `Cache-Status: "Netlify Durable"; fwd=uri-miss; stored`, and re-fetching them five minutes later returned the same broken page in 0.30–0.64 s with `"Netlify Durable"; hit` and `age: 318–350`. The broken page becomes the *fast* one, which is why nobody notices.

Worse, the degrade is often cheap: several of those poisoned entries were produced in **0.47 s**, because a pooler that fails fast reaches the fallback fast. Do not assume a degraded render announces itself by being slow.

The fix, shipped in #1123, is that degrading is now opt-in per call site (`perRequest`) in `lib/data/fail-open.ts`, and the default on anything with a `revalidate` export is to rethrow.

**Both halves of the framework behaviour that makes rethrowing correct were verified by observation**, on a temporary ISR route shaped like the real one, on deploy preview 1123:

- A render that throws returns **HTTP 500** with `Cache-Status: "Netlify Durable"; fwd=bypass, "Netlify Edge"; fwd=miss; fwd-status=500` — no `stored`, and three consecutive requests each re-rendered rather than hitting a cache. Nothing is persisted.
- When a cached good copy already exists and the *revalidation* throws, the good copy keeps being served. Across 45 polls spanning several deliberately-throwing windows on a `revalidate = 10` route, every response was the good body with `age` climbing to 39–53 s, resetting only when a non-throwing window regenerated it. This matches Next's documented "Handling uncaught exceptions" paragraph.

So on an ISR route, throwing is strictly better than degrading: the one unlucky visitor gets an error boundary, everyone else keeps the last good copy, and nothing bad is written down.

## Options assessed and rejected — do not re-propose without new information

Partial Prerendering and Cache Components are not merely "a Next 16 feature" — they are unreachable from our pinned version. At `next@15.5.15`, `packages/next/src/server/config.ts` throws `CanaryOnlyError` on a stable build for both `experimental.ppr` and `experimental.cacheComponents`, so even `experimental.ppr = "incremental"` fails at config load rather than degrading. Next's own [ppr-preview](https://nextjs.org/docs/messages/ppr-preview) page confirms a canary release is required. This matters because PPR is the textbook answer to "a static page with one dynamic hole", and on this version that answer simply does not exist — a `Suspense` boundary around a dynamic read does **not** rescue static rendering without PPR. Separately, `use cache` would not help a route whose every segment is auth-gated, and every dashboard route here is auth-gated.

Caching a dynamic route at the CDN with `Netlify-CDN-Cache-Control` is technically sound and was considered for the public pages, but it still invokes the function on every cache miss, so it does not solve the cold start the way prerendering does. It remains the right tool when build-time data access is genuinely unacceptable.

Verified clean and not worth re-investigating: `next/image` usage (there are zero raw `<img>` tags), fonts (`next/font/google` with `display: swap`), `staleTimes`, `serverExternalPackages`, the Prisma singleton, and the bundle-analyzer tooling.

## Project constraints that constrain every change here

ESLint warnings are blocking, because SonarCloud fails the quality gate on unused variables. Never filter ESLint output for errors alone.

Renaming a large file makes SonarCloud count every line as new code, which then fails `new_duplicated_lines_density` on long-standing duplication. Prefer adding a parent server layout over splitting a client layout into a separate shell file.

The same trap fires without any rename. Several files on `dev` are already Prettier-dirty, so running `prettier --write` on one while editing it reformats hundreds of untouched lines and hands all of them to Sonar as new code. On #1116 this reformatted roughly 200 lines of `Navbar.tsx` that the change never touched. Revert the formatting churn and re-apply only the semantic edits; Prettier is `continue-on-error` in CI, so an unformatted file is not a failure, whereas a diff full of reformatting is a quality-gate risk.

Never run `prisma db push` as part of a rendering change. There is deferred, unrelated schema drift that a push would apply to a database shared with production.

## Sources

These were opened as primary sources rather than summarised second-hand.

- [Using a CDN with Next.js](https://nextjs.org/docs/app/guides/cdn-caching) — the exact per-strategy `Cache-Control` values.
- [Incremental Static Regeneration](https://nextjs.org/docs/app/guides/incremental-static-regeneration) and [How Revalidation Works](https://nextjs.org/docs/app/guides/how-revalidation-works).
- [generateStaticParams](https://nextjs.org/docs/app/api-reference/functions/generate-static-params), [revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag) and [Revalidating](https://nextjs.org/docs/app/getting-started/revalidating).
- [Netlify caching overview](https://docs.netlify.com/build/caching/caching-overview/) — header precedence, `stale-while-revalidate`, cache tags and `purgeCache`.
- [Next.js on Netlify](https://opennext.js.org/netlify) and [Netlify's Next.js setup guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) — adapter support matrix, durable cache, documented limitations.
- [Durable Cache and the Quest for Fast, Fresh Content](https://www.netlify.com/blog/durable-cache-quest-for-fast-fresh-content/) — the Netlify Blobs backing store.
