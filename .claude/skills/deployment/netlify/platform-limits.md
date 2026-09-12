# Netlify platform limits as they apply to this site

Verified on 2026-09-12 against Netlify's documentation, the Netlify changelog, the account and deploy records returned by the Netlify API, and seven days of production function logs. Where the documentation and this site disagree, the site's measurement is recorded next to the documented value; both are kept because the gap is itself the finding.

## What this site is, according to Netlify

The values below come from `get-project`, `get-deploy-for-site`, and `netlify api listAccountsForUser` on 2026-09-12; the deploy is the production deploy of commit `a040ce7c` (release of #1590 and #1588).

| Property           | Value                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Site ID            | `1a1ad7d0-fda0-4efe-9d58-aa0ce0fd6d5c` (name `familiarise`)                                                         |
| Team               | `Practitionist-Deploys`, slug `teetangh`, ID `627691275dcde40f546bebf3`, one member, MFA not enforced               |
| Plan               | Pro; the account API reports `type_slug: orb-pro` and `credit_features: false`                                      |
| Functions region   | `sin` (`ap-southeast-1`, Singapore) for every retained deploy; the ticket draft dated 2026-08-22 already records it |
| Next.js runtime    | `@netlify/plugin-nextjs@5.15.13`, runtime API v2, bootstrap 2.18.0 — the latest release on npm                      |
| Server handler     | `___netlify-server-handler`, Node `nodejs22.x`, 1024 MB, invocation mode `stream`, 68.8 MB zipped                   |
| Scheduled function | `cron-tick` at `*/5 * * * *`, 339 KB                                                                                |
| Edge functions     | one (the middleware)                                                                                                |
| Extensions         | `netlify-observability-extension` v34 on the handler                                                                |
| Skew protection    | on (`skew_protection_token` present on the deploy)                                                                  |
| Production build   | 387 s on 2026-09-12; `NODE_VERSION=22`, `NODE_OPTIONS=--max-old-space-size=6144` at build time only                 |
| Secret scan        | 3,182 files scanned, no matches                                                                                     |

The plan's capability flags that matter here are `background_functions: true`, `configure_functions: true`, `logs_api: true`, `functions: 125000` invocations and `functions_gb_hour: 1000` included, `build_minutes: 25000`, `concurrent_builds: 3`, and `credit_features: false`. The last flag does not gate the memory setting: the memory A/B described below applied on this plan.

## The limits, documented and measured

The table below sets each documented limit beside what this site has actually observed.

| Limit                                  | Documented (2026-09-12)                                                                                                            | Observed on this site                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Synchronous function execution         | 60 seconds, not configurable ("Synchronous execution limit 60 seconds No" in the defaults table)                                   | Invocations of 28.0–32.3 s completed on 2026-09-12; #1124 logged completions to 39 s and "bare platform 500s at ~39 s"                                                                     |
| Edge response for a non-streaming body | Not documented anywhere Netlify staff have answered                                                                                | 504 "Inactivity Timeout" at ~26–27 s while the function keeps running and its DB write lands (#1454); a June 2026 forum thread reports a function finishing at 45 s after the client's 504 |
| Streaming function                     | 60 seconds and a 20 MB response                                                                                                    | Consistent with the RSC page renders that arrive at 27–39 s TTFB in #1124's bursts                                                                                                         |
| Scheduled function                     | 30 seconds; minimum interval one minute; published deploys only                                                                    | `cron-tick` fits by design; each `/api/cleanup/*` twin does the work under its own request                                                                                                 |
| Background function                    | 15 minutes; immediate 202; retry after one minute, then after two more                                                             | Not yet used; enabled on the plan                                                                                                                                                          |
| Memory                                 | 1024 MB default, configurable 1024–4096 MB or `vcpu` 0.5–2.0, "Credit-based Pro and Enterprise"                                    | `m=2048` applied on this plan on 2026-08-22 and was reverted (see below)                                                                                                                   |
| Payloads                               | 6 MB buffered request/response; 20 MB streamed; 256 KB for background functions                                                    | Not hit                                                                                                                                                                                    |
| Unzipped function size                 | 250 MB (AWS Lambda hard limit)                                                                                                     | Hit 18 of 18 times by the Krisp feature (#1158); the handler is 68.8 MB zipped today                                                                                                       |
| Environment variables                  | The 4 KB total cap was removed on 2026-06-12 for the current runtime                                                               | 53 keys on production                                                                                                                                                                      |
| Build memory                           | No published number; forum guidance is that a non-Enterprise build should stay under ~3 GB; high-performance builds are Enterprise | `--max-old-space-size=6144` is set at build time and has held since ADR 24                                                                                                                 |

Until mid-2026 Netlify documented 10 seconds by default and 26 seconds as the Pro maximum, activated per site by support. The 60-second figure appeared with the 2026-06-25 functions redesign, and Pro customers were still posting activation requests for 26 s in September 2026, so the old default may persist for functions on the legacy runtime. This site's handler is on runtime API v2 and demonstrably runs past 26 s.

### The two ceilings, and which one a route hits

A request can fail at two different points. The Lambda execution limit (60 s) kills the function; the client sees a platform 500 or 502. The edge's inactivity timeout (~26 s, undocumented) abandons a response that has not started streaming; the client sees a 504 while the function keeps running to completion, which is why #1454's ledger reconcile "504s but the write lands". A Next.js page render streams its shell early and is bounded by the 60 s limit; a Route Handler that awaits everything and then returns JSON is bounded by the ~26 s edge timeout. Lock-retry budgets and long admin routes must therefore fit under ~25 s of silence, stream a first byte early, or move to a Background Function; no Netlify setting changes this.

## Memory and vCPU

Netlify scales CPU with memory: `vcpu: 0.5` is 1024 MB and `vcpu: 2.0` is 4096 MB, linearly between. The setting can be made three ways. In code, `export const config = { memory: "2gb" }` — impossible for the generated Next.js handler because its file is emitted at build time. In `netlify.toml`, `[functions."___netlify-server-handler"] memory = 2048` — this is what #1148 shipped, and `searchSiteFunctions` confirmed `m=2048` on deploy `6a8954981e6f`. In the Netlify UI, a project-level default that applies to every function including generated ones. Billing scales linearly with the configured size.

The August A/B (#1124, 2026-08-22) is the reason the setting is not on today. At 1024 MB, 11 of 12 concurrent unique-key requests to a cold deploy preview landed at 27.8–31.0 s TTFB. At 2048 MB on the corrected deploy, 11 of 12 landed at 35.9–37.6 s plus one platform 500. A later 1024 MB burst on the same deploy stalled 12 of 12 at 32.6–38.0 s. An earlier "16/16 fast at 2048" result was a confounded run during a window of neighbouring deploy activity and was withdrawn in the issue. Doubling memory and CPU together did not move the stall, which weakens the "CPU-starved cold-boot JS/GC" hypothesis rather than confirming it. The revert commit is `08b10ce4`.

On 2026-09-12 the ten cold invocations after the 14:28 production publish reported Duration 28.0–32.3 s and Memory Usage 892–1012 MB; the 67 warm invocations reported p50 219 ms and p50 116 MB. The cold boots run near the 1024 MB ceiling, but because the 2048 MB run did not help, that is a symptom of the boot rather than its cause. The root cause is still unknown and the support ticket drafted at `docs/perf/netlify-stall-ticket-draft.md` has not been recorded as sent.

## Regions

Region selection is available on all Pro and Enterprise plans and is set per function in code, or project-wide in the UI for generated functions; sites created before 2023-10-04 may carry a different default. The regions Netlify offers are `cmh` (Ohio, the default), `iad` (Virginia), `pdx` (Oregon), `yul` (Montreal), `gru` (São Paulo), `dub` (Dublin), `lhr` (London), `fra` (Frankfurt), `sin` (Singapore), `nrt` (Tokyo), and `syd` (Sydney). There is no Mumbai region, so `sin` is the closest possible placement to the Supabase project in `ap-south-1`, at roughly 55–70 ms round trip instead of the ~200 ms that #932 measured from Ohio. The move to `sin` is not recorded in the repository or on #932; it was in effect by 2026-08-22. Vercel, by contrast, offers `bom1` (Mumbai); see `hosting-alternatives.md`.

## Runtime versions

For functions deployed on or after 2023-05-15 the runtime follows the build's Node version, which must be a non-deprecated Lambda runtime; otherwise Netlify falls back to Node 24, which became the default for new sites on 2026-07-07. This site pins `NODE_VERSION=22` and the handler runs `nodejs22.x`. The 2026-01-16 changelog asks sites still on Node 18 to move to 20 or later because of a Node DoS vulnerability.

## Reading a deploy record

`netlify api getDeploy --data '{"deploy_id":"…"}'` and the MCP's `get-deploy-for-site` return an `available_functions` array whose short keys are undocumented; the meanings below are inferred from the values on this site's deploys and were consistent across every deploy inspected.

| Key  | Meaning                                             |
| ---- | --------------------------------------------------- |
| `n`  | function name                                       |
| `m`  | memory in MB (absent when default)                  |
| `r`  | Lambda runtime, e.g. `nodejs22.x`                   |
| `rg` | AWS region, e.g. `ap-southeast-1`                   |
| `im` | invocation mode, `stream` or `buffer`               |
| `s`  | zipped bundle size in bytes                         |
| `g`  | generator, e.g. `@netlify/plugin-nextjs@5.15.13`    |
| `bd` | build data: `bootstrapVersion`, `runtimeAPIVersion` |
| `c`  | bundle creation time                                |

The top-level fields `functions_region`, `function_schedules`, `commit_ref`, `context`, `deploy_time`, `edge_functions_present`, `skew_protection_token`, and `deploy_validations_report.secret_scan_result` are self-describing. `commit_ref` is the only way to map a deploy to a commit, which any A/B across deploys must do (#1124's correction was caught this way).

## What is still open with Netlify

The stall on brand-new instances under concurrent creation (#1124) has no known cause and no platform mitigation; the drafted support ticket should carry three additional facts from this verification — the documented limit is now 60 s, the ~39 s platform 500s in the issue are therefore under the documented limit, and the 2026-09-12 cold boots still show 28–32 s at 892–1012 MB on the latest runtime. The edge inactivity timeout's value and configurability are unanswered on the forums and belong in the same ticket.

## Sources

- Functions configuration (defaults table, memory/vCPU, regions, Node runtime): https://docs.netlify.com/build/functions/configuration/
- Functions API reference (streaming limit): https://docs.netlify.com/build/functions/api/
- Background Functions: https://docs.netlify.com/build/functions/background-functions/
- Scheduled Functions: https://docs.netlify.com/build/functions/scheduled-functions/
- Changelog, 2026-06-25, functions redesigned: https://www.netlify.com/changelog/2026-06-25-functions-redesigned-for-agents/
- Changelog, 2026-06-12, env-var size limit removed: https://www.netlify.com/changelog/2026-06-12-serverless-functions-env-var-size-limit-removed/
- Changelog tag for functions (Node 24 default, Node 18 advisory): https://www.netlify.com/changelog/tag/functions/
- Forum, 2026-06-17, function completes after the client's 504: https://answers.netlify.com/t/what-is-the-gateway-edge-request-timeout-that-returns-the-504-to-the-client/163935
- Forum, 2026-09-08, a Pro customer still requesting 26 s: https://answers.netlify.com/t/synchronous-function-timeout/168727
- Issue #1124 (stall, memory A/B and its correction), #1454 (edge 504), #932 (cross-region), #1158 (250 MB cap)
