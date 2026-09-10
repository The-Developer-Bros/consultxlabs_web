# Navigation Performance

| Field | Value |
|---|---|
| Status | Stable |
| Audience | All engineers |
| Last reviewed | 2026-06-17 |
| Source files | `next.config.mjs`, `lib/prisma.ts`, `components/ui/NavLink.tsx`, `components/dashboard/DashboardSkeletons.tsx`, `components/ui/dashboard-skeleton.tsx`, `providers/StreamProvider.tsx`, `providers/StreamProviderImpl.tsx`, `lib/stream/disconnect.ts`, `providers/ReactQueryProvider.tsx`, `app/api/dashboard/consultant/[consultantId]/route.ts`, `app/api/dashboard/consultee/[consulteeId]/events/route.ts` |

## 1. Overview and Goals

This document is the canonical record of the navigation-performance round delivered in [PR #887](https://github.com/). It captures what changed, why each change was made, and what was deliberately left for a later round so that the next engineer to touch navigation does not have to reverse-engineer the intent from the diff.

The round had a single guiding goal: make moving between pages in the authenticated dashboard feel instant, and make the first paint of every route cheaper. The work attacks the problem on four fronts that compose rather than overlap. Perceived performance covers what the user sees the moment a link is clicked, before any server work has finished. The client bundle covers how much JavaScript the browser must download and parse before the application becomes interactive. Server and data-layer time-to-first-byte (TTFB) covers how quickly the React Server Component (RSC) payload for a route is produced. Database indexes cover the query cost underneath that payload. A final observability change makes future regressions in any of these layers visible without a profiler.

None of these changes alter business logic, money handling, or authorization. They are pure performance and correctness work, with one exception called out explicitly in [Section 4](#4-client-bundle) where a latent SSR data-leak was fixed as a side effect of the bundle work.

## 2. Scope

| In scope | Out of scope |
|---|---|
| Route-level loading boundaries and skeletons | The React Query migration itself — see [`00-optimization-checklist.md`](./00-optimization-checklist.md) |
| Client-router cache tuning and pending affordances | Hover-prefetching strategy — see [`02-dashboard-prefetching.md`](./02-dashboard-prefetching.md) |
| Bundle composition: package-import optimization, lazy loading, dead-dependency removal | Real-time dashboard caching strategy |
| Bounded dashboard-home queries and additive indexes | Schema design and migration mechanics — see [`../prisma/01-migrations-guide.md`](../prisma/01-migrations-guide.md) |
| Prisma slow-query observability | Stream SDK internals — see [`../stream/01-architecture.md`](../stream/01-architecture.md) |

## 3. Perceived Performance

The largest single win comes from giving every route an instant, layout-matched skeleton so that navigation paints immediately instead of blocking on the server component that produces the page.

### 3.1 Loading Boundaries

Before this round only twelve of the application's roughly one hundred and forty-nine routes had a `loading.tsx` boundary. The remaining routes blocked on their server component, so a click produced no visible change until the server finished. This round raised the count to approximately ninety-nine boundaries. The App Router wraps each route segment that has a `loading.tsx` in a React `Suspense` boundary, so the moment a user navigates the router can paint the fallback while the real server component streams in behind it.

Each `loading.tsx` file is deliberately thin. It does no work of its own beyond re-rendering a shared skeleton. Dashboard routes render a skeleton from [`components/dashboard/DashboardSkeletons.tsx`](../../components/dashboard/DashboardSkeletons.tsx) that mirrors the structure of the page it stands in for, so the transition from skeleton to content does not shift the layout. Non-dashboard routes render a generic inline skeleton from [`components/ui/dashboard-skeleton.tsx`](../../components/ui/dashboard-skeleton.tsx). Keeping the boundary files thin means the visual design lives in one place and a change to a skeleton propagates to every route that uses it.

### 3.2 Pending Affordance on Navigation Links

A skeleton tells the user that the destination is loading, but the link they clicked also needs to acknowledge the click immediately. [`components/ui/NavLink.tsx`](../../components/ui/NavLink.tsx) wraps `next/link` and uses the `useLinkStatus` hook introduced in Next.js 15.5 to render a debounced pending spinner on the dashboard sidebar while the destination route is resolving. The debounce matters: showing a spinner for a navigation that completes in a few milliseconds would read as a flicker, so the affordance only appears once the navigation is slow enough that the user would otherwise wonder whether the click registered.

### 3.3 Client-Router Cache Tuning

Next.js 15 changed the default `staleTime` for page segments in the client router cache to zero, which means the router refetches the RSC payload on every navigation, even when the user is bouncing between two pages they visited seconds ago. This round restores a useful cache window through `experimental.staleTimes` in [`next.config.mjs`](../../next.config.mjs):

```javascript
experimental: {
  staleTimes: { dynamic: 30, static: 180 },
}
```

With these values the client router holds a navigated page's payload for roughly thirty seconds for dynamic segments and three minutes for static segments. Re-navigating within that window serves the cached payload instantly with no network round trip. The window is intentionally short for dynamic routes because dashboard data is live; thirty seconds is long enough to make back-and-forth navigation instant without serving meaningfully stale data.

## 4. Client Bundle

The bundle work, tracked under [#636](https://github.com/) and [#639](https://github.com/), reduces how much JavaScript the browser must download and parse on first load. Three techniques apply here: optimizing barrel imports, lazy-loading heavy SDKs, and removing dead dependencies. A latent correctness bug in the React Query provider was fixed in the same pass.

### 4.1 Package-Import Optimization

Several dependencies are barrel libraries: a single entry point re-exports hundreds of named members, so importing one icon can pull the entire library into the bundle unless the bundler can tree-shake it perfectly. `experimental.optimizePackageImports` in `next.config.mjs` instructs Next.js to rewrite these imports so that only the members actually used are bundled. The configured libraries are `lucide-react`, `recharts`, `date-fns`, and the Radix icon set. The Stream SDKs and `framer-motion` are also listed for completeness, but they benefit far less because they are not barrel libraries in the same sense, so their gains are marginal.

### 4.2 Stream SDK Lazy Loading

The Stream chat and video SDKs, together with their two stylesheets, were previously linked statically into any route that mounted the provider, which meant they shipped on first load even for users who never opened a chat or a call. This round splits the provider in two. [`providers/StreamProvider.tsx`](../../providers/StreamProvider.tsx) is now an SDK-free shell that uses `next/dynamic(..., { ssr: false })` to load [`providers/StreamProviderImpl.tsx`](../../providers/StreamProviderImpl.tsx), and the SDK plus its stylesheets now ship only inside that lazily loaded chunk.

The complication is that other code — notably the navbar and several dashboards — needed to reach the shared Stream client to disconnect it, and importing the provider for that purpose would have statically re-linked the SDK and defeated the split. A new SDK-free module, [`lib/stream/disconnect.ts`](../../lib/stream/disconnect.ts), now owns the shared client references and the `disconnectStreamClients` function, so callers that only need to tear down the connection can import that module without pulling in the SDK. See [`../stream/01-architecture.md`](../stream/01-architecture.md) for the broader provider design.

### 4.3 Recharts Lazy Loading

The admin payouts page was the only consumer of `recharts` on a route that most administrators visit rarely. The chart was extracted into its own `PayoutsChart.tsx` component and loaded with `next/dynamic(..., { ssr: false })`, so the charting library now ships only when that page is actually opened.

### 4.4 React Query Provider: Per-Request Client

[`providers/ReactQueryProvider.tsx`](../../providers/ReactQueryProvider.tsx) previously created its `QueryClient` at module scope. On the server that singleton is shared across requests, which means one user's cached data could be dehydrated into another user's SSR render — a correctness and security defect, not merely a performance concern. The provider now constructs a fresh `QueryClient` per request, which eliminates the cross-request leak. The same change sets `mutations: { retry: 0 }` so that failed mutations do not silently re-fire, and adds a streaming-dehydration default so that query state hydrates cleanly under streamed SSR.

> [!IMPORTANT]
> The per-request `QueryClient` is a security fix as much as a performance one. Do not reintroduce a module-scope `QueryClient`: on the server it will leak one user's cached data into another user's render.

### 4.5 Dead-Dependency Removal

The dependency tree carried a number of libraries that were no longer imported, or that duplicated functionality already available through another dependency. Removing them shrinks both the install footprint and the bundle.

| Action | Packages | Rationale |
|---|---|---|
| Removed | `npm`, `swr`, `axios`, `cmdk`, `react-day-picker`, `tweetnacl` (and `tweetnacl-util`) | No remaining imports; `swr` superseded by React Query, `axios` by `fetch`. |
| Moved to `devDependencies` | `prettier`, `dotenv` | Tooling only; not needed in the production bundle. |
| Replaced | `bcryptjs` → `bcrypt` | The seed script now uses the native `bcrypt`. |
| Consolidated | `react-icons` → `react-icons/fa6` | Standardized on the FA6 set (for example `FaXTwitter`) so a single icon family ships. |
| Pinned | `@next/bundle-analyzer` → `^15` | Aligns the analyzer major with Next.js 15. |
| Raised floor | `next` → `^15.5.0` | Matches the `useLinkStatus` API relied on in [Section 3.2](#32-pending-affordance-on-navigation-links). |

### 4.6 Image and Server-Externals Configuration

Two further `next.config.mjs` changes round out the bundle work. `images.formats` is set to `["image/avif", "image/webp"]` so the image optimizer serves modern formats ahead of legacy ones. `serverExternalPackages` was broadened to include `razorpay`, `stripe`, `resend`, `bcrypt`, `@stream-io/node-sdk`, and `libsodium-wrappers`, which keeps these server-only native and SDK packages out of the bundler's module graph and prevents them from being incorrectly traced into client output.

## 5. Server and Data-Layer TTFB

The server work, tracked under [#734](https://github.com/), bounds the two dashboard-home routes whose queries were previously unbounded and therefore grew linearly with a user's history. An unbounded `findMany` is the classic cause of a TTFB that is fine in development and pathological for a heavy production account.

The consultant dashboard-home route, [`app/api/dashboard/consultant/[consultantId]/route.ts`](../../app/api/dashboard/consultant/[consultantId]/route.ts), previously fetched appointments, consultations, and subscriptions with unbounded `findMany` calls. Each now carries `take: 200` together with a date lower bound, so the query cost no longer scales with the full lifetime of the account.

The consultee events route, [`app/api/dashboard/consultee/[consulteeId]/events/route.ts`](../../app/api/dashboard/consultee/[consulteeId]/events/route.ts), is bounded by an `EVENTS_TAKE` constant of 200.

> [!IMPORTANT]
> On the consultee route the consultation and subscription `where` clauses were deliberately kept org-scope-only and were **not** changed to require a slot. A slot-less `PENDING` booking must still render so that the Appointments → Upcoming view can show its pending-payment call to action. The `take: 200` provides the bound instead of a slot filter. Do not "tighten" these clauses to require a slot — doing so would hide pending bookings from the user who still needs to pay for them.

## 6. Database Indexes

The indexes added in this round, tracked under [#696](https://github.com/) and [#734](https://github.com/), were applied additively to the familiarise Supabase database with `CREATE INDEX CONCURRENTLY` so that no table was locked against writes during the build. See [`../prisma/01-migrations-guide.md`](../prisma/01-migrations-guide.md) for the project's broader migration conventions and the safe-operation rules around concurrent index creation.

| Index | Columns | Why |
|---|---|---|
| `Payment` | `(userId, organizationId, createdAt)` | Supports the org-scoped, time-ordered payment reads on the dashboard-home routes. |
| `Waitlist` | `(userId, status)` | Supports the per-user, status-filtered waitlist lookups. |
| `ConsultantReview` | `(consultantProfileId)` | Fixes the explore "trending" sort, which ordered by `reviews._count` and was performing a full-table scan. |

The `Consultation` and `Subscription` `(planId, status)` indexes were considered and intentionally skipped as redundant: a superset index on `(planId, status, requestedAt)` already exists, and Postgres can satisfy a `(planId, status)` lookup from the leading columns of that index, so adding the shorter index would only duplicate maintenance cost.

## 7. Observability

To make future regressions visible without attaching a profiler, [`lib/prisma.ts`](../../lib/prisma.ts) now emits the Prisma `query` event in all environments rather than only in development. When a query takes longer than the `PRISMA_SLOW_QUERY_MS` threshold the client logs a warning, so a slow query in production surfaces in the logs on its own. The threshold defaults to 500 milliseconds, can be overridden through the `PRISMA_SLOW_QUERY_MS` environment variable, and is clamped to a positive finite value so that a malformed override cannot disable the check or set a nonsensical bound. This work is tracked under [#383](https://github.com/).

> [!IMPORTANT]
> Query parameters are logged only in development. In production the slow-query warning records timing and the query shape but not the bound values, so sensitive data is never written to production logs.

## 8. Deferred Follow-Ups

The following items were considered during this round and deliberately deferred. They are recorded here so that the rationale is not lost and the next attempt does not repeat a dead end.

The first is a fast-path for `customSession` membership reads. This would let the session-enrichment hot path skip a database round trip when memberships are already known, but it requires memberships to be persisted into the session itself. BetterAuth's `cookieCache` strips the enriched membership list, so a fast-path keyed only on session generation would return empty memberships and break authorization reads. Until memberships are persisted into the session in a form the cookie cache preserves, this fast-path cannot be implemented safely.

The second is converting the public landing, explore, and detail pages to React Server Components. These pages are currently client-rendered, and an RSC conversion would cut their client JavaScript and improve their first paint, but it is a larger refactor than the navigation round scoped for and is left for a dedicated effort.

The third is adopting `framer-motion`'s `LazyMotion` to defer the animation runtime. This would shrink the animation portion of the bundle for routes that animate, and it pairs naturally with the package-import work in [Section 4.1](#41-package-import-optimization), but it was out of scope here.

## 9. References

- [PR #887](https://github.com/) — the navigation-performance round documented here.
- Issues: [#734](https://github.com/) (TTFB bounding and indexes), [#636](https://github.com/) and [#639](https://github.com/) (client bundle), [#450](https://github.com/), [#248](https://github.com/), [#309](https://github.com/), [#696](https://github.com/) (indexes), [#383](https://github.com/) (slow-query observability).
- [`00-optimization-checklist.md`](./00-optimization-checklist.md) — the React Query migration and the broader dashboard optimization history.
- [`02-dashboard-prefetching.md`](./02-dashboard-prefetching.md) — hover-based route prefetching, which complements the loading boundaries described here.
- [`../stream/01-architecture.md`](../stream/01-architecture.md) — Stream provider architecture, relevant to the SDK lazy-load split in [Section 4.2](#42-stream-sdk-lazy-loading).
- [`../deployment/netlify.md`](../deployment/netlify.md) — deployment environment that serves the optimized bundle.
- [`../prisma/01-migrations-guide.md`](../prisma/01-migrations-guide.md) — migration conventions and the rules around `CREATE INDEX CONCURRENTLY`.
