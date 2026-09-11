# Netlify Pro support ticket — DRAFT (for kaustav to file)

> Subject: Next.js server handler (`___netlify-server-handler`): brand-new instances block their event loop ~24s on first invocation when created concurrently — is this expected scale-out behavior?
>
> Site: familiarise.netlify.app (site id `1a1ad7d0-fda0-4efe-9d58-aa0ce0fd6d5c`)
> Plan: Pro (Credit-based) · Region: `ap-southeast-1` functions · Adapter: `@netlify/plugin-nextjs@5.15.13` (runtime API v2, single consolidated SSR+ISR function) · Next.js 15.5.15, Node 22

## Summary

Since at least July 2026 we have measured a reproducible, bimodal latency pathology on the Next.js server handler. A function instance created **in isolation** boots and serves a real database-backed page end-to-end in **~1.9s**. Instances created **under concurrent load** each stall for roughly **24 seconds with a blocked event loop before executing any application code**, then serve normally. There is nothing between the two modes: across ~90 instrumented cold renders we observed zero samples between ~6s and ~31s.

## Evidence

**1. Bimodality correlates exactly with instance creation count.**
Four batches against one deploy preview, client-side TTFB via curl, correlated with function logs and an in-app diagnostic route that reports per-instance id + `process.uptime()` + event-loop-lag probe:

| Batch | Concurrency | Instance state | Samples | Result |
|---|---|---|---|---|
| A | strictly sequential | new each time | 8 | 1.80–2.72s, no outliers |
| B | 12 concurrent | ~6 pre-existing | 12 | six at 1.9–4.7s, six at 31.0–33.1s |
| C | 16 concurrent | ~12 pre-existing | 16 | twelve at 2.6–2.9s, four at 30.8–33.1s |
| D | 12 concurrent | all warm | 12 | 3.3–5.9s, zero slow |

Slow-count equals newly-created-instance-count in every batch. The diagnostic route confirmed every stalled sample ran on an instance aged <100ms serving invocation #1.

**2. The stall is an event-loop block BEFORE any application work.**
On stalled first invocations, a diagnostic route that awaits 400ms of idle *before* touching the database reported the idle phase taking **23.9–24.8s**, max loop lag 23.7–24.7s, while instance age was <100ms. The subsequent DB query connected in ~0.9–1.0s. On warm instances the same probe shows 400–453ms / lag 1–70ms. Downstream effects: `pg` connect timers are plain `setTimeout`s, so they fire only after the stall ends (~26s), which initially misdiagnosed this as a database problem.

**3. Memory/CPU scaling does not touch it.**
We configured the v2 handler correctly by name (`___netlify-server-handler`; verified via `searchSiteFunctions`, field `m`) at **2048 MB** — i.e. doubled vCPU, since your docs state memory and vCPU scale together. Result under the identical 12-way burst protocol:

| Config | Deploy id (ready UTC 2026-08-22) | commit_ref | searchSiteFunctions `m` | Result |
|---|---|---|---|---|
| control 1024 MB | `6a894a2398d6…` (07:05) / `6a895a3f4651…` (08:13) | 74f58138 / 08b10ce4 | 1024 | 11/12 slow, TTFB 27.8–31.0s |
| **treatment 2048 MB** | **`6a8954981e6f…` (07:49)** | **17228d7e** | **2048** | **11/12 slow, TTFB 35.9–37.6s + one platform 500** |
| post-revert re-run | `6a8974a11d65…` (10:06) | 0646d8f5 | 1024 | 12/12 slow, TTFB 32.6–38.0s |

(An intermediate burst on `6a895c2e7d70…`/58fb03fc at 08:22 came back 16/16 fast — an anomaly attributable to residual warm capacity from three deploys and two concurrent agent sessions within nine minutes, not to the memory setting; recorded for completeness.)

No improvement (possibly worse). We reverted.

**4. Not our bundle's init work.** Sequential brand-new instances complete module loading + init + a full SSR render in <2s total, so first-invocation application work cannot account for 24s; and if the stall were proportional to per-instance init CPU, doubling CPU should have moved it. Confirmed again on 2026-08-23: a build carrying lazy-initialized payment SDK clients (#1221, deploy-preview-1221, commit 353cef1e) still stalled **12/12 at 29.5–31.5s** after ≥30 min idle, while its sequential profile was normal (first-ever request 5.84s settling to ~0.26s warm).

**5. Observability gap:** this function emits no `Init Duration:` log line (only `Duration:`/`Memory Usage:`), so cold starts can't be discriminated from logs; we had to build an in-app instance-age probe. A forum report from May 2025 describes the same absence.

## Questions

1. Is concurrent instance-creation contention (e.g., simultaneous sandbox provisioning, deployment-artifact fetch, or shared-host CPU scheduling during burst scale-out) a known cause of multi-second stalls on runtime-API-v2 handlers? Is there a known incident or fix in flight since mid-2026?
2. Does Netlify have, or plan, anything equivalent to provisioned concurrency / minimum instances for framework-generated functions like `___netlify-server-handler`? Scheduled keep-warm pings keep at most one instance warm and cannot protect bursts.
3. Why does the server handler not emit AWS-style `Init Duration` in its logs, and are there plans to expose it? It makes cold-start SLO work impractical.
4. Any guidance on reducing burst-time instance-creation latency from within the deployment (bundle shape, esbuild vs default bundling, region placement), given memory/vcpu scaling showed no effect?

## Impact

User-visible: landing-page/explore clicks stall 20–30s then render (the "site is down" perception), worst right after deploys and during traffic bursts from a cold pool. We ship ISR-first architecture and deploy-warming workflows, but the tail persists whenever concurrency forces new instances.
