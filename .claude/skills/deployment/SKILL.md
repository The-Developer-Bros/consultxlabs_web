---
name: deployment
description: What the hosting platform actually does to this app — Netlify's real function limits as measured on this site (the 60-second Lambda limit versus the undocumented ~26-second edge 504, the cold-instance stall that memory does not fix, the Singapore region and why Mumbai is unavailable, the plan and its capabilities), how to read the platform with the Netlify MCP and CLI without re-researching, the ledger of every GitHub issue Netlify caused or constrained with its current status, and the verified 2026 numbers for the alternatives (Vercel Fluid Compute, always-on hosts, Spring Boot, brokers and queues, Netlify Background Functions and Async Workloads). Use when the user says "function timeout", "504", "cold start", "Netlify limit", "memory", "vCPU", "region", "Netlify MCP", "should we move to Vercel", "Spring Boot", "Kafka", "BullMQ", "QStash", "background function", "Async Workloads", or asks whether a Netlify issue can be fixed on Netlify's side.
---

# Deployment

This is the index for platform-level facts about where the app runs. The `maintenance` skill covers the plumbing we built on top of the platform (the cron ticker, env-var sync, caching, seeds); this skill covers the platform itself — its limits, its knobs, its dashboard, and the alternatives — so that nobody has to re-open Netlify's docs, Vercel's docs, or six months of GitHub issues to answer "can Netlify fix this?" again.

The table below lists each reference and when to read it.

| Reference                         | Purpose                                                                                                                                                                                                                                               | Read it when                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `netlify/platform-limits.md`      | Netlify's function limits as documented and as measured on this site (verified 2026-09-12): the two ceilings, memory/vCPU and what the August A/B disproved, regions, plan capabilities, runtime versions, and the deploy-record field cheat sheet.   | A route 504s or 500s only in production, someone proposes raising memory or timeout, or someone cites "26 seconds" or "Ohio".     |
| `netlify/mcp-and-cli.md`          | The Netlify MCP server (install, auth, the cold-start cache trap, what its nine tools can and cannot do) and the CLI recipes that fill the gaps: deploy records, account capabilities, function logs with REPORT-line parsing, env-var drift.         | You need a fact about the live site — plan, region, memory, deploy state, env keys, invocation durations — without the dashboard. |
| `netlify/issue-ledger.md`         | Every GitHub issue Netlify caused, constrained, or forced a workaround for, grouped by mechanism, with Netlify's side as of 2026-09-12, the stale premises each group carries, and the next action.                                                   | Triaging an open infra issue, or before filing a new one that might be a duplicate.                                               |
| `netlify/hosting-alternatives.md` | Verified 2026 numbers for the alternatives: Vercel Fluid Compute side by side with Netlify, always-on hosts, Spring Boot, message brokers and queues, Netlify Background Functions and Async Workloads — and a reading of what the evidence supports. | The "should we have used Vercel / Spring Boot / Kafka" question comes up, or a queue vendor is being chosen for #1010.            |

## Non-negotiables

There are two ceilings on a Netlify request, not one. The Lambda execution limit is 60 seconds (documented since the 2026-06-25 functions redesign, and invocations of 32 to 39 seconds complete on this site), but an edge 504 lands on the client at roughly 26 seconds if the response has not started streaming; a Route Handler that awaits a long query before returning any bytes therefore fails at ~26 s while its database write completes underneath (#1454). Fitting under ~25 s, streaming early, or moving the work to a Background Function are the fixes; waiting for a bigger limit is not.

Memory does not fix the cold-instance stall. Netlify's per-function `memory`/`vcpu` setting applies to the generated Next.js handler when targeted by name in `netlify.toml` — `m=2048` was verified on deploy `6a8954981e6f` on 2026-08-22 — and doubling it left the ~24 s stall untouched (#1124). Do not propose it again without new evidence; the cold boots still run at 892–1012 MB of 1024 MB, but that is a symptom.

Functions run in Singapore (`sin`), the closest region Netlify offers to Supabase in Mumbai; Mumbai is not on Netlify's menu. Any issue that still says "us-east-2" or "Ohio" is describing a state that ended by 2026-08-22 at the latest.

The Netlify MCP reads projects, deploys, teams, and env vars and writes env vars; it cannot read function logs, change function limits, or touch billing. Use `netlify logs --url <deploy permalink>` and `netlify api` for those, per `netlify/mcp-and-cli.md`.

Every number in these references carries the date it was verified and the source it came from. When a number matters for a decision, re-open the source if the date is more than a quarter old; otherwise trust the file.
