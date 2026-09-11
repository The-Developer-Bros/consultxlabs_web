---
title: Security headers
band: 20-iam-and-security
audience: sde2
status: live
last-reviewed: 2026-06-05
---

# Security headers

**New here?** HTTP response headers are instructions the server hands
the browser on every page: *don't let other sites frame me*
(`X-Frame-Options`), *only talk to me over HTTPS*
(`Strict-Transport-Security`), *only load scripts from this allow-list*
(`Content-Security-Policy`, "CSP"). They cost nothing at runtime and are
the first thing a large-customer security review greps for, so getting
them right is table stakes for enterprise.

PR #655 adds the two missing headers that block any large-customer
security review on Familiarise: `Content-Security-Policy` (report-only
by default) and `Strict-Transport-Security`. The other five were
already in place; they get a brief mention here for completeness.

**Design decision: ship CSP in report-only first, enforce later.**
A CSP that's even slightly too strict *breaks the page* — a blocked
script is a blank dashboard, in production, for everyone. So the policy
ships as `Content-Security-Policy-Report-Only`: the browser evaluates
every directive and *reports* what it would have blocked, but blocks
nothing. Violations POST to `/api/csp-report` and surface as
`event: "csp_violation"` log lines, giving a real-traffic window to find
the legitimate origin we forgot before any user hits a wall. Flipping
`ENABLE_CSP_ENFORCE=true` swaps the header key to
`Content-Security-Policy` — same directives, now enforced. The trade-off
is that report-only protects *nothing* while it's on (a real injection
isn't blocked, only logged); the bet is that a short observation window
is cheaper than a production breakage, and the §Rollout schedule keeps
that window bounded.

```mermaid
flowchart LR
  B[Browser renders a page] -->|"loads a resource outside the allow-list"| EVAL{"ENABLE_CSP_ENFORCE?"}
  EVAL -->|"false (report-only)"| ALLOW["resource LOADS + violation reported"]
  EVAL -->|"true (enforce)"| BLOCK["resource BLOCKED + violation reported"]
  ALLOW --> POST["POST /api/csp-report"]
  BLOCK --> POST
  POST --> LOG[("log line — event: csp_violation")]
  LOG --> OP["operator scans during rollout, fixes allow-list"]
```

**The observation window only works if the reports actually arrive.** `/api/csp-report` originally shared `spamLimiter`, which allows 5 requests per hour — a budget sized for a human deciding to file a support ticket. A browser emits one report per violated directive per navigation, so a single person opening a few dashboard pages exhausted the hour in seconds and every subsequent report was rejected with a `429`. The rollout was therefore blind in precisely the situation it exists to observe. The endpoint now has its own limiter (`cspReportLimiter`) sized for browser-generated volume. If you add a report sink in future, size its limiter by who generates the traffic, not by how much you want to receive.

## Header inventory (production)

All seven production headers, their values, and what each one defends against, are listed in the table below.

| Header | Value | Notes |
|---|---|---|
| `Content-Security-Policy-Report-Only` | see `next.config.mjs` CSP_DIRECTIVES | flipped to enforce by `ENABLE_CSP_ENFORCE=true` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | 2-year window + preload-list eligibility |
| `X-Frame-Options` | `DENY` | Anti-clickjacking |
| `X-Content-Type-Options` | `nosniff` | Anti-MIME-sniffing |
| `X-DNS-Prefetch-Control` | `off` | Reduces info leakage |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=(), payment=()` | Stream.io needs camera/mic; payment is iframe-scoped via Razorpay |

All seven are applied globally via `next.config.mjs` `async headers()`
(the single `source: "/(.*)"` block over `securityHeaders`). There are
no per-route overrides — the production allow-list is already narrow
enough to cover the dashboard surface (`/dashboard/organization/[orgId]/**`)
and the public marketplace pages alike.

## CSP allow-list rationale

Anything outside the directives below will be blocked once `ENABLE_CSP_ENFORCE=true`, so each external origin earns its place by being load-bearing for a real product surface.

The `script-src` directive keeps `'self' 'unsafe-inline' 'unsafe-eval'`, which is non-negotiable until Next.js 16 ships hashed inline runtime chunks. Its external origins are Razorpay's checkout CDN (`https://checkout.razorpay.com`, the payment SDK), Stripe (`https://js.stripe.com`), Sentry (`https://*.sentry.io`, error reporting), Stream.io (`https://*.getstream.io`), and Supabase (`https://*.supabase.co`, storage signed URLs). The Stream entry is inherited rather than observed — the SDK is bundled from npm and self-served, so no `script-src` fetch to Stream was seen in practice.

The `connect-src` directive governs XHR, fetch, and WebSocket targets. It opens `https://api.razorpay.com` for payments, the three Stream domains described below, `https://*.supabase.co` and `https://*.upstash.io` for storage and Redis, `https://*.sentry.io` for error reporting, `https://api.resend.com` for transactional email, and `https://*.novu.co` plus `wss://*.novu.co` for the notification inbox.

The `media-src` directive serves Stream.io recording and call audio/video, so it requires `blob:` for local recording playback alongside Stream's CDN and API origins.

### Stream.io does not run on getstream.io

This is the mistake the allow-list originally made, and it is worth stating plainly because it is easy to repeat: `getstream.io` is Stream's marketing and documentation domain. No SDK traffic goes there. The clients talk to three unrelated domains, and a CSP host wildcard does not span them:

| Domain | Carries |
| --- | --- |
| `*.stream-io-api.com` | REST calls and both websockets (`wss://video.stream-io-api.com`, `wss://chat.stream-io-api.com`) |
| `*.stream-io-video.com` | the edge-latency hint (`hint.stream-io-video.com`) the client fetches before a call to choose an SFU, then the SFU edge itself |
| `*.stream-io-cdn.com` | call recordings and chat attachments |

Because only `*.getstream.io` was listed, every dashboard load filed violation reports for traffic the product cannot function without, and video calling would have failed outright the moment `ENABLE_CSP_ENFORCE=true` was set. The domains above were confirmed against a real browser network log on a deploy preview rather than read off Stream's docs, which is the only way to catch this class of drift.

`*.getstream.io` remains in the list: Stream still serves some static assets from it, and dropping it is a separate change with its own unobserved blast radius.

`worker-src` is deliberately absent. Nothing in the app constructs a `Worker`, and Stream's background-filter and noise-cancellation add-ons — the features that would need `blob:` workers and `wasm-unsafe-eval` — are not installed. If they are ever adopted, `worker-src` is the directive that breaks first, and it will fall back to `default-src 'self'`.

The `frame-src` directive allows Razorpay's checkout iframe; without this entry, payments break the moment CSP is flipped to enforce mode.

The remaining directives in `CSP_DIRECTIVES` carry no external origins
and are listed here for completeness: `default-src 'self'`,
`style-src 'self' 'unsafe-inline'` (Tailwind/runtime inline styles),
`font-src 'self' data:`, and `img-src 'self' data: https: blob:` —
note `img-src` is deliberately broad (`https:`) because user/consultant
avatars come from many CDNs (Google, GitHub, logo.dev, Supabase, …);
tightening it would mean enumerating every avatar host in the
`images.remotePatterns` list.

## Rollout

The rollout walks a bounded three-step schedule that keeps the report-only observation window from drifting open indefinitely.

1. On day zero, which is now, report-only mode is already shipped, so violations stream to `/api/csp-report` and surface as `event: "csp_violation"` log lines without blocking anything.
2. On day seven, review the report log for unexpected entries, update the allow-list if a legitimate dependency was missed, and create an issue if a suspicious entry shows up.
3. On day fourteen, flip `ENABLE_CSP_ENFORCE=true` in the production environment so the header key changes from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`; the same reports keep arriving, but the browser now blocks the offending request instead of allowing-but-flagging it.

## Auditing

The production headers are visible to anyone with `curl -sI`, which makes the rollout-readiness check a one-liner.

```bash
curl -sI https://app.familiarise.work/ | grep -iE 'content-security|strict-transport|x-frame'
```

Expected lines:

```
content-security-policy-report-only: default-src 'self'; ...
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-frame-options: DENY
```
