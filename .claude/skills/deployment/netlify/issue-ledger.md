# Ledger of Netlify-caused and Netlify-constrained issues

Compiled on 2026-09-12 from every open and closed issue in `Practitionist/familiarise_web` whose cause, constraint, or workaround is the hosting platform. Issue states were verified individually on that date. Each group names the mechanism, lists the issues, records what Netlify's side looks like today (from `platform-limits.md`), calls out any premise in the issues that is now stale, and states the next action. Read the group before touching any issue in it; several were written against a platform that has since changed.

## 1. One database connection per instance (`PG_POOL_MAX=1`)

Issues: #1117 (closed by #1126), #1436 (closed by #1435), #1270 (closed by #1271 and #1303), #1540 (closed by #1542), #1526 (open, suspected).

Every serverless instance holds its own pool and serves one request at a time, so `Promise.all` over Prisma reads serialises, a global-client read inside a transaction deadlocks, and a burst of sequential Server Actions on a cold instance queues. Netlify has shipped nothing that changes this; Lambda-shaped functions do not share a warm process across concurrent requests. The four closed issues are code fixes that removed the parallelism assumption. Next action for #1526: confirm or rule out the function timeout by reading the REPORT line for the failing PUT. This mechanism is the strongest single argument in `hosting-alternatives.md`, because Vercel's Fluid Compute and every always-on host do share a process.

## 2. Cross-region latency between functions and the database

Issues: #932 (open), #937 (open), #1456 (open).

Stale premise: all three describe functions in `us-east-2` (Ohio) talking to Supabase in `ap-south-1` (Mumbai). Functions have run in `sin` (Singapore) for every retained deploy and since 2026-08-22 at the latest; nobody recorded the move. Netlify offers no Mumbai region, so `sin` is the best placement available, at roughly 55–70 ms round trip. Next action: re-baseline #932 and #1456 against Singapore-to-Mumbai latency before evaluating Prisma Accelerate (#937); the durable fix is to put the database in `ap-southeast-1`, which is cheap at the pre-MVP reset and expensive afterwards, or to host functions somewhere that offers Mumbai.

## 3. The cold-instance event-loop stall

Issues: #1124 (open), #1557 (closed by #1559).

A brand-new handler instance blocks its event loop for roughly 24 s before any application code runs, worst under concurrent instance creation. On 2026-09-12 the ten cold boots after a production publish ran 28–32 s at 892–1012 MB. The memory/vCPU setting applied on this plan and did not help (2048 MB A/B, reverted in `08b10ce4`); there is no provisioned-concurrency equivalent; the handler emits no `Init Duration` line. Mitigations shipped in #1148 (post-deploy warm-up and hourly keep-warm workflows) and #1559 (the health check yields before arming its budget). Next action: send the support ticket at `docs/perf/netlify-stall-ticket-draft.md` with the three new facts recorded in `platform-limits.md`; there is no evidence it was sent.

## 4. The request ceiling

Issues: #907 and #908 (closed by #939), #1454 (open).

Stale premise: the issues treat 26 s as the platform's execution limit. The documented Lambda limit is now 60 s and this site completes 32–39 s invocations; the ~26 s cut that users see is the edge abandoning a response that has not started streaming, which is undocumented and not configurable. #1454's reconcile route "504s while the write lands" is exactly that. Next action for #1454: scope the admin route with limit parameters and run the full sweep from the ticker, or drive it from a standalone Background Function (15 minutes, enabled on the plan) that loops bounded calls to the HTTP twin; do not wait for a larger limit. Lock-retry budgets stay under ~25 s of silence for the same reason.

## 5. Durable and ISR cache serving the wrong entry

Issues: #1560 (closed), #1119 (closed by #1123).

The `netlify-vary` header keyed the durable cache on two query parameters, so other query strings collapsed into one entry; a degraded fail-open render was cached for the revalidate window. Both are behaviours of `@netlify/plugin-nextjs`, which is on its latest release (5.15.13). Nothing pending on Netlify's side; the fixes are in the routes.

## 6. Sub-hourly scheduling and the absence of a queue

Issues: #866 (closed, superseded by #1390 and ADR 27), #1010 (open), #1517 (open), #1411 (closed).

GitHub Actions delivered sub-hourly cron about six times slower than declared, so `netlify/functions/cron-tick.mts` posts the ten `/api/cleanup/*` twins every five minutes and Actions keeps only the daily and weekly backstops. Scheduled functions allow a one-minute interval and a 30 s limit, on published deploys only. Netlify Async Workloads now exists as the platform-native queue, and Background Functions are enabled; `background: true` works only on a standalone function file, not on a Next.js route under runtime v5. Next actions: #1517 is a twenty-line HTTP twin; for #1010 compare Async Workloads with QStash on the numbers in `hosting-alternatives.md` before adding a vendor; the ticker could move to every minute only if every drain is idempotent under overlap, which #1411 shows one was not.

## 7. Build-time database access and environment variables

Issues: #920 (open), #282 (closed by #284), plus two incidents in `docs/deployment/netlify.md` (`BETTER_AUTH_URL` left at localhost in the production context; `NODE_ENV=production` skipping devDependencies until `NPM_FLAGS=--include=dev`).

The build prerenders against the live database, so a slow pooler can fail a deploy; #919 added a 30 s connect budget and #920 asks for the pages to become dynamic. Netlify removed the 4 KB env-var cap on 2026-06-12. A keys-only drift check on 2026-09-12 found nothing actionable. Next action: #920 remains a code change.

## 8. The 250 MB unzipped function cap

Issues: #1158 (open), #639 (open), #636 (closed).

AWS Lambda's limit; Netlify cannot raise it. The handler is 68.8 MB zipped today; the Krisp feature exceeded the cap on every attempt. Next action: none on Netlify's side; bundle work only.

## 9. Function logs

Issues: #1122 (closed by #1126), #1127 (open).

`compiler.removeConsole` had stripped server-side output; logs now arrive. Reading them needs the deploy permalink and the recipes in `mcp-and-cli.md`; output is capped at 200 lines per call. Next action: #1127 is an audit of what the payloads serialise.

## 10. react-pdf on the deployed build

Issues: #1468 (closed by #1469), #707 (closed).

The two-React clash only reproduces on the Netlify build; the gotcha is documented in the `maintenance` skill. Nothing pending.

## 11. Branch-deploy subdomains

Issues: #1482 (open).

`branch_deploy_custom_domain` is `dev.familiarisenow.com`, so branch deploys resolve as `<branch>.dev.familiarisenow.com` — the production deploy's branch URL is `prod.dev.familiarisenow.com` in its own deploy record. This is the setting behaving as designed. Next action: one `netlify api updateSite` call setting the base to `familiarisenow.com`; the MCP has no operation for it.

## 12. Rate limiting at the edge

Issues: #407 (closed), #913 (closed by #929).

Rate limiting lives in the middleware edge function backed by Upstash. #913 flagged the missing `[functions]` block in `netlify.toml`; the block is still absent, and after the region move and the memory revert there is nothing it needs to say.

## Trackers that reference the groups above

Open: #1570, #1571, #1449, #1575, #1582, #1583, #1584, #1586, #1591, #1592, #1598, #1599, #1600, #481, #705, #734, #1527, #1230. Closed: #1132, #1421, #1319, #1169, #1072, #676, #1189, #410, #706. These roll up several groups and are not itemised.

## Netlify features in use

Scheduled Functions (`cron-tick`, every five minutes); the Next.js runtime v5 build plugin with its single consolidated server handler; `NODE_VERSION=22` and a 6 GB build heap; a deploy-preview ignore rule for Dependabot branches; per-context build commands for `production` and `dev`; the image CDN via `images.formats`; the durable cache behind on-demand ISR; Netlify DNS with a branch-deploy custom domain; one edge function (the middleware); the observability extension; skew protection.
