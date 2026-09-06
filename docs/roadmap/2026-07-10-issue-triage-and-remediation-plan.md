# Issue Triage & Remediation Plan

**Generated:** 2026-07-10 · **Scope:** all 105 open GitHub issues · **Method:** each issue read in full, then verified against the *current* code on `dev` (grep/read of routes, schema, services, crons, workflows). Code is treated as ground truth over issue text — many issues describe work that has since shipped or been superseded.

> This is a **planning document only**. No code is changed here. Each remediation item becomes its own follow-up PR into the feature branch.

> **Status addendum (2026-07-11):** Wave 0 item 0.1 (**#693** moderation side-effects — listed below as the top launch blocker) has since been implemented in PR #974, which wires the full enforcement pipeline (ban/suspend flags, session and Stream revocation, bulk cancellation with refunds, earnings hold, notifications). Read the #693 rows in this snapshot as historical; the remaining moderation tails (unban/reinstate action, best-effort reconciliation path, Novu dashboard workflows) are named as follow-ups in `docs/decisions/2026-07-11-moderation-enforcement-and-peer-chat-block.md`. The rest of the snapshot is unmodified.

---

## 1. Headline numbers

| Classification | Count | Meaning |
|---|---:|---|
| ✅ **Already fixed** — close | 12 | Code already does this; close the issue. |
| ♻️ **Duplicate / obsolete / wontfix** | 5 | Superseded, stale, or an ops-runbook not an eng deliverable. |
| 🟡 **Partially fixed** | 41 | Core landed; a named tail remains. Most trackers live here. |
| 🔴 **Legit-pending** | 47 | Genuinely unbuilt. |

**The story the code tells:** the money/booking/payments core, resilience primitives (rate-limit, circuit breakers, failed-email DLQ, CAS/locks), Sentry, and the enterprise SSO/SCIM stack are **already built and hardened**. What remains splits into (a) a *small* set of genuine launch-blockers — mostly **security side-effects that were stubbed out** — and (b) a long tail of polish, compliance depth, and post-launch features.

**The one finding that should stop everything else:** **#693 — moderation actions are a `TODO` stub.** Ban/suspend/unverify write no side-effects, so a "banned" user keeps full access (session, Stream token, bookings). That is the highest-severity item in the entire backlog.

---

## 2. Close now — already fixed (verified in code)

| # | Title | Evidence |
|---|---|---|
| #248 | Stream Chat sync on every dashboard load | `event-channel.action.ts:471` session guard + sessionStorage guard; per-load full-sync is gone |
| #279 | Support entire subscription reschedule | `reschedule/route.ts:40` `?type=SUBSCRIPTION` marks all slots tentative; UI wired |
| #300 | In-app notification system | Delivered via Novu Inbox (`NotificationInbox.tsx`) instead of custom table |
| #346 | Pagination on document dashboards | `documents/route.ts:47` limit/offset + client envelope; ACs all checked |
| #360 | Recording two-mode storage | `RecordingStoragePolicy` enum + auto-transfer service + cron |
| #379 | Consultant verification gate + moderation link | `checkConsultantVerification` gates plan creation; moderation → `isVerified=false` |
| #387 | Staff onboarding validation | STAFF/ADMIN rejected server-side as invite-only (`onboarding-server.ts:573`) |
| #437 | Referral qualifying actions / anti-gaming | Deferred referee bonus + consultant-referee qualification shipped |
| #474 | Critical email retry + DLQ | `FailedEmail` model + retry worker + cron + admin requeue |
| #475 | Sentry error tracking | Shipped via PR #901 |
| #534 | Safe Prisma migration workflow docs | `docs/prisma/01-migrations-guide.md` (~95% coverage, audited) |
| #855 | Capture-after-cancel auto-refund | `handlers.ts:360` `capturedAfterTerminal` → auto-refund + CAS guard |

## 3. Duplicate / obsolete / wontfix

| # | Title | Disposition |
|---|---|---|
| #636 | Next.js perf optimization | **Duplicate** of #639 (its own body says #639 supersedes it) |
| #613 | Codex Checkpoint-1 audit snapshot | **Obsolete** — a passive tracking snapshot; residuals live in their own issues |
| #875 | Detect→Triage→Decide→Remediate | **Obsolete** — open-ended discussion; detection backbone (Sentry) shipped |
| #481 | Billing guardrails across vendors | **Wontfix-as-code** — per-vendor dashboard config → keep as an ops runbook |
| #884 | Phone/SMS step-up verification | **Parked by decision** (2026-06-17); no-op seam kept in `auth-phone-stepup.ts` |

---

## 4. The sequenced remediation plan ("the rightful order")

Ordered by **launch dependency**, not by label. Each wave should largely finish before the next starts; items inside a wave are listed most-critical first. Effort: S ≤ half-day · M ≈ 1–2 days · L ≈ 3–5 days · XL = multi-week/epic.

### 🚨 Wave 0 — Launch blockers (security, correctness, go/no-go)

These are the gate to a public launch.

| Order | # | What's actually left | Effort | Why it blocks |
|---:|---|---|:--:|---|
| 0.1 | **#693** | Wire real side-effects into moderation `actionType` (session + Stream-token revoke, suspend/ban flags, cancel appointments, earnings hold, Novu). `action/route.ts:82` is still `// TODO`. | M | Banned users currently keep full access. |
| 0.2 | **#690** (AUTH-2) | AES-256-GCM envelope-encrypt `Account.accessToken/refreshToken/idToken` (reuse the `panEncrypted` crypto pattern). Tokens are plaintext `@db.Text`. | M | DB leak → OAuth account takeover. |
| 0.3 | **#694** (DOC-4) | App-layer encryption + `virusScanStatus`/`fileHash` on verification docs; rate-limit the verification & plan-material upload routes (DOC-2). | M | PAN/Aadhaar scans stored unencrypted at rest. |
| 0.4 | **#695** (ADM-1/2) | Fix passwordless staff-create contract (`user/staff/route.ts` takes `password`, never calls BetterAuth); add audit-log rows to the 4 financial-admin routes (TDS, reconcile-ledgers, exchange-rates). | M | Irreversible TDS actions with no record; broken staff auth. |
| 0.5 | **#696** (SCH-3) | Drop `user.email` from the public consultant-search `OR` predicate (`consultants/route.ts:128`). | S | Email enumeration of the whole user base. |
| 0.6 | **#691** (NTF-2) | Add `List-Unsubscribe` + unsubscribe footer to email templates; add a `triggerWorkflowSafe()` wrapper around the 23 fire-and-forget triggers. | M | CAN-SPAM/GDPR legal exposure + silent notification loss. |
| 0.7 | **#486** | Fix consultee "Upcoming" filter — `event-processor.ts:512` filters by **time only**, so EXPIRED/PENDING appointments show with a live Join button. Gate Join on status + joinable window. | M | Users can "join" cancelled/unpaid sessions. |
| 0.8 | **#407/#405** | Add the Netlify **edge** rate-limit layer (Layer 1) — app-layer (Upstash) is done; re-audit the 21 lifecycle sub-items (2 CRITICALs already closed). | S–L | Pre-function IP throttling for launch. |
| 0.9 | **#932** | Verify/relocate Netlify Functions to Singapore (ap-southeast-1) to stop cross-region pooler timeouts; blast-radius + caching already shipped. | M | Prod stability — pooler connection timeouts under load. |
| 0.10 | **#837** | Run the staging chaos go/no-go gate (scenarios 1–4 + 2× peak ramp). **Code work is complete.** | S (ops) | Launch gate. |
| 0.11 | **#874** | Run + record the capacity go/no-go (chaos scenario 6 at 2× peak). Depends on caching (#734) + vendor-tier upgrades. | M | Explicit launch go/no-go gate. |

### 🧊 Wave 1 — Schema freeze + money/tax correctness

Per the project rule, **schema freeze is the launch gate** (deferred impl is OK, deferred schema is not).

| Order | # | What's left | Effort |
|---:|---|---|:--:|
| 1.1 | **#688** | Extend `deletedAt` to money models (Payment/Refund/Invoice/Payout/Earnings); land residual bps-sum + wallet-non-negative CHECK constraints; DB trigger to enforce ledger append-only. | L |
| 1.2 | **#677** | GST intra/inter-state split + place-of-supply + B2B reverse-charge; Float→paise on remaining money fields; credit-note flow for PAID org invoices. (Runtime-verify tax math.) | XL |
| 1.3 | **#738** | Chargeback-LOST tax cascade; resolve the 194J→194O CA decision; multi-attendee webinar tax. Non-resident Sec-195 stays deferred. | XL |
| 1.4 | **#676** | Booking audit tail: AE-1/AE-2 allocation-engine gaps, A11 optimistic versioning, B4 audit logs. Mark A1–A4 + B1 closed. | L |
| 1.5 | **#834** | Add the explicit waitlist↔slot unique constraint on the pre-MVP schema reset (CAS race already fixed in code). | S |

### 🛡️ Wave 2 — Production resilience & infra

| Order | # | What's left | Effort |
|---:|---|---|:--:|
| 2.1 | **#697** | `withJobExecution()` wrapper writing `SystemJobExecution` (INF-2 silent cron failure); TTL on maintenance keys (INF-1); wrap Razorpay client in a circuit breaker (INF-3). | L |
| 2.2 | **#866** | Install `@upstash/qstash`; migrate ~10 event-shaped jobs off GitHub Actions to QStash→HTTP; add a dead-man heartbeat for the GA fleet. | L |
| 2.3 | **#899** | Event-driven Stream channel setup + thin reconciliation cron to retire per-load bulk sync (root cause of #248). | XL |
| 2.4 | **#689** | STR-2 transfer retry backoff + STR-4 per-participant audit trail (STR-1 revenue-leak already fixed). | M |
| 2.5 | **#473** | Add Stream status to `/api/health` + degradation UI (breaker itself done). | M |
| 2.6 | **#471/#472** | No-show auto-detection/marking + session-overrun timer & conflict alert (presence foundation exists). | L |
| 2.7 | **#920** | Finish making remaining DB-backed pages dynamic; delete the `IS_NEXT_BUILD` prerender workaround in `prisma.ts`. | M |
| 2.8 | **#937** | Evaluate Prisma Accelerate (ap-south-1 pool) vs the region move as the durable cross-region fix. | L |
| 2.9 | **#900** | Confirm Netlify build env (`SENTRY_AUTH_TOKEN`) + rotate token, then close. | S |

### 🏢 Wave 3 — Compliance & enterprise runtime

| Order | # | What's left | Effort |
|---:|---|---|:--:|
| 3.1 | **#840** | First-class org-invitee onboarding: detect invite token pre-picker, route to a no-profile shell (dominant enterprise acquisition path). | M |
| 3.2 | **#701** | LCY residuals: consent-withdrawal cascade, data-residency enforce-or-remove, `DataBreach` 72h write path; confirm HRIS scope (route absent). SSO/SCIM runtime itself is largely done. | L |
| 3.3 | **#725** | BetterAuth Tier-1 plugins — start with **2FA + Captcha** (enterprise-sales relevant), then LinkedIn/HIBP/Admin-RBAC. | XL |
| 3.4 | **#692** | Referral anti-fraud: velocity + IP-subnet checks in `applyReferralCode`; expire-credits cron endpoint (REF-2 lapsed-credit fix already done). | M |
| 3.5 | **#770** | Contract & BillingSubscription lifecycle — GAP-2→GAP-1→GAP-3 (edit/amend/renew), then `billingMode` PREPAID/POSTPAID. | L |
| 3.6 | **#684** | OrganizationPlan curation UI (backend/entitlement layer already real). | L |
| 3.7 | **#705** | Residual infra trio: analytics stack wiring, Postgres extension enablement, Supabase Realtime decision. | L |
| 3.8 | **#863** | Enterprise residuals register — tick off `ScimToken.expiresAt`; re-audit tails (ongoing tracker). | L |

### 🎨 Wave 4 — UX & dashboard polish

| # | What's left | Effort |
|---|---|:--:|
| **#868** | Finish dashboard-redesign residuals (StatCard accent colors), merge `feat/dashboard-redesign`→dev. | L |
| **#867** | Split the remaining 71 semantic-correctness findings (role×tab editability, races) into discrete issues. | XL |
| **#487** | Re-audit surviving P1/P2 consultant-dashboard findings against redesigned pages. | XL |
| **#906** | `/api/appointments` ~2.3s → parallelize reads, discriminate the single event include, defer/cache count. | M |
| **#448/#337** | Reschedule: add the re-allocation-complete notification + staff/admin visibility (request-side already done). | M |
| **#494** | Onboarding UX: draft persistence, clickable completed steps, consultee budget/session/domain fields. | M |
| **#698** | `calculateProfileCompletion` compute+persist; verify OB-2 session refresh after ORG_ADMIN assignment. | M |
| **#485** | Price + currency on consultee cards; scope chronological grouping separately. | M |
| **#536** | Shared enum→label formatter + populate missing Novu payload fields. | M |
| **#450** | Re-audit remaining query-batching claims (RSC conversion + review cap already done). | L |
| **#902** | Align org-members prefetch query-key/shape with client, or drop the dead prefetch. | S |
| **#309** | React Query + HTTP cache headers on slot-availability APIs. | M |
| **#348** | Supabase Realtime subscription on `AppointmentDocument`. | M |
| **#663** | Enterprise analytics endpoints + Recharts visualizations. | L |
| **#664** | "Recommended by [Org]" badge on explore cards. | S |
| **#341** | Form-based Send Inquiry (model + API + profile CTA). | L |

### 📦 Wave 5 — Post-launch features & tech-debt (defer)

**Quick wins worth grabbing early** (small, isolated): **#891** (referral code wiped on `?ref=`-less signup — one-line effect fix), **#664** badge, **#902** prefetch.

**Cross-cutting workstreams** (see §5–§6): Server-Actions migration (relates to **#734**), app-wide animations.

| Bucket | Issues |
|---|---|
| Perf tail | #734 (include→select + bundle split), #639 (re-run ANALYZE), #383 (query-perf runbook) |
| Notifications/CMS | #399 (Novu receiver), #536, #334 (ConvertKit), #312 (Directus), #767 (CMS/newsletter decision), #381 |
| Features | #366 (recording monetization), #367 (enterprise recording marketplace), #371 (AI mentor search), #739 (agentic support RFC), #341, #342 (chat roadmap), #469 (Google One-Tap), #377 (Intercom), #348 |
| Analytics/scanning | #378 (PostHog), #409 (Aikido/CodeQL) |
| Referrals | #880 (design umbrella), #692, #891 |
| Enterprise later | #702 (affiliate — defer to ~₹5L MRR), #746 (roadmap umbrella), #367 |
| Code quality | #531 (Winston), #640 (eslint strict), #654 (zod 4), #842 (de-export), #869 (reorg), #733 (folder debt), #270 (payment factory), #274 (lib/api extraction), #308 (seed realism) |
| Ops/cleanup | #535 (Stream hard-delete cron), #724 (collapse ORG_ADMIN backstop) |
| Parked by decision | #872 (DST timezone), #884 (phone step-up), #366 |

---

## 5. Enterprise SSO — MVP recommendation

**You do not need to build SAML, OIDC, or SCIM — Better Auth already provides all three, and most of it is already wired here.** Verified in code:

- `lib/auth.ts` registers the `sso()` plugin (SAML 2.0 + OIDC, org-scoped, auto-generates `ssoProvider`), `lib/sso/enforce-session.ts` does session enforcement, plus a cert-expiry-alert cron.
- JIT provisioning exists — `ssoSettings.defaultRoleForAutoJoin` auto-joins SSO users to their org on first login.
- Full `lib/scim/` module (`operations.ts`, token auth, group-mappings) + routes under `app/api/organizations/[orgId]/{sso,scim}`.

**MVP scope — what to turn on:**

| Capability | MVP | Rationale |
|---|:--:|---|
| SAML + OIDC login | ✅ On | Free from the plugin; covers Okta/Entra/Google; unblocks enterprise deals. |
| JIT auto-provision | ✅ On | Already built; covers "new hire logs in → gets access." |
| SCIM auto-deprovision | 🟡 Present, flag-gated | Already built, so cost is maintenance/test surface, not build. Enable per-org for the first customer contractually requiring automated deprovisioning; until then JIT + admin-removal suffices. |

**No WorkOS, no native protocol code, no new build.** The remaining SSO work is governance/lifecycle tails tracked under **#701** (consent cascade, data-residency, DataBreach) and the auth plugin roadmap **#725** (2FA/Captcha) — sequenced in Wave 3.

## 6. Server Actions vs API Routes — validated strategy

Researched against current Next.js guidance. Verdict: **the instinct is right but "migrate *most* routes" is the wrong scope.** Server Actions run **sequentially** (even `Promise.all` won't parallelize them) and are **POST-only with no GET caching**, so they are *bad* for the data-heavy reads this dashboard app is full of. Their win is narrow: first-party **mutations** save a hop and get `revalidatePath` for free.

**Adopted pattern (incremental, tracked — not launch-critical):**

- **Reads → React Server Components + `lib/data`** (already the convention here).
- **First-party form/button mutations → Server Actions**, incrementally, keeping the existing idempotency / CAS / serializable-retry money guards intact.
- **Stay Route Handlers permanently:** Razorpay webhooks, OAuth callbacks, QStash/cron triggers, anything a third party or future mobile client calls, streaming, public API.
- **Watch the sequential trap:** never fan out parallel Server Actions for dashboard tiles.

A reference-slice PR (strategy doc + one representative mutation migrated with guards intact) establishes the pattern. Relates to the perf tail in **#734**.

## 7. App-wide animations — perf-safe approach

Direction chosen: **in-view element motion** (fade + rise on mount/scroll), **not** route-transition choreography — the latter delays interactivity and fights the instant-nav static shell (#938/#940).

- Shared `FadeIn` / `Stagger` primitives on **`LazyMotion` + `m` components** (~5 kb feature set, not ~35 kb) to protect the Netlify bundle.
- Animate **only `transform` + `opacity`** (GPU-composited, zero layout thrash).
- `MotionConfig reducedMotion="user"` globally for accessibility.
- `whileInView` with `once: true` so animations never re-fire on scroll.
- Scoped to the content region, kept **out of the instant-nav shell**. Verify no LCP/INP regression before merge.

---

## Appendix — full per-issue classification

Legend: ✅ fixed · ♻️ dup/obsolete/wontfix · 🟡 partial · 🔴 pending. Crit = launch-blocker / high / med / low.

| # | Class | Crit | Wave | One-line action |
|---|:--:|:--:|:--:|---|
| 248 | ✅ | low | — | Close — per-load full-sync removed |
| 270 | 🔴 | low | 5 | P3 refactor switch→service map (or wontfix) |
| 274 | 🟡 | low | 5 | Remaining `lib/api` handler-factory extraction |
| 279 | ✅ | med | — | Close — entire-subscription reschedule shipped |
| 300 | ✅ | med | — | Close — Novu inbox |
| 308 | 🟡 | low | 5 | Past appts → COMPLETED; reviews only on COMPLETED |
| 309 | 🔴 | low | 4 | React Query + cache headers on slot APIs |
| 312 | 🔴 | low | 5 | Directus CMS epic — only a stub webhook exists |
| 334 | 🟡 | low | 5 | Implement ConvertKit API + status fields |
| 337 | 🟡 | med | 4 | Add allocation-side approval notification |
| 341 | 🔴 | med | 4 | Build form-based inquiry (model+API+CTA) |
| 342 | 🔴 | low | 5 | Chat roadmap — split P1 items |
| 346 | ✅ | low | — | Close — pagination shipped |
| 348 | 🔴 | low | 4 | Supabase Realtime on AppointmentDocument |
| 360 | ✅ | low | — | Close — two-mode storage + transfer cron |
| 366 | 🔴 | low | 5 | Recording monetization — keep deferred |
| 367 | 🟡 | med | 5 | Narrow to deferred recording-marketplace slice |
| 371 | 🔴 | low | 5 | AI mentor search — options doc only |
| 377 | 🔴 | low | 5 | Intercom widget or de-prioritize |
| 378 | 🟡 | low | 5 | Split off PostHog (Sentry half done) |
| 379 | ✅ | med | — | Close — gate + moderation link live |
| 381 | 🟡 | low | 5 | Announcement audience/types/approval tail |
| 383 | 🟡 | low | 5 | Convert to monitoring runbook (hook shipped) |
| 387 | ✅ | high | — | Close — invite-only reject implemented |
| 399 | 🔴 | med | 5 | Build Novu webhook receiver |
| 405 | 🟡 | high | 0 | Re-audit 21 sub-items (2 CRITICALs done) |
| 407 | 🟡 | high | 0 | Add Netlify edge rate-limit layer |
| 409 | 🔴 | low | 5 | Add Aikido/CodeQL to CI |
| 437 | ✅ | med | — | Close — anti-gaming shipped |
| 438 | 🟡 | high | 1 | Enterprise PDF done; split B2C receipt/email |
| 448 | 🟡 | high | 4 | Verify re-allocation notify + staff visibility |
| 450 | 🟡 | med | 4 | Re-audit batching (RSC + review-cap done) |
| 469 | 🔴 | low | 5 | Google One-Tap sign-in |
| 471 | 🟡 | med | 2 | No-show detection on presence foundation |
| 472 | 🔴 | low | 2 | Session-overrun timer + conflict alert |
| 473 | 🟡 | med | 2 | Stream status in /health + degradation UI |
| 474 | ✅ | low | — | Close — DLQ + retry worker (opt: rate alert) |
| 475 | ✅ | low | — | Close — Sentry via #901 |
| 480 | 🟡 | high | 0/1 | Launch checklist tracker — tick code-done items |
| 481 | ♻️ | med | — | Ops runbook, not eng deliverable |
| 485 | 🔴 | low | 4 | Price+currency on cards; group toggle separate |
| 486 | 🔴 | high | 0 | Fix Upcoming filter + gate Join on status |
| 487 | 🟡 | high | 4 | Re-audit P1/P2 vs redesigned pages |
| 494 | 🔴 | med | 4 | Draft persistence + clickable steps + fields |
| 531 | 🔴 | low | 5 | Winston logger post-launch (Sentry covers now) |
| 534 | ✅ | low | — | Close — migration guide exists |
| 535 | 🔴 | low | 5 | Weekly Stream hard-delete cron |
| 536 | 🔴 | med | 4 | Enum→label formatter + payload fields |
| 613 | ♻️ | low | — | Close — stale audit snapshot |
| 636 | ♻️ | low | — | Close — duplicate of #639 |
| 639 | 🟡 | med | 5 | Re-run ANALYZE; file residual page items |
| 640 | 🔴 | low | 5 | eslint strict at `warn`, fix incrementally |
| 654 | 🔴 | low | 5 | Bump zod ^4 + fix `z.record()` sites |
| 663 | 🔴 | low | 4 | Analytics endpoints + Recharts |
| 664 | 🔴 | low | 4/5 | "Recommended by [Org]" badge (quick win) |
| 676 | 🟡 | high | 1 | Booking audit tail (AE/A11/B4) |
| 677 | 🟡 | high | 1 | GST split + FX + credit-note tax engine |
| 684 | 🟡 | med | 3 | OrganizationPlan curation UI |
| 688 | 🟡 | high | 1 | Money soft-delete + CHECK constraints + trigger |
| 689 | 🟡 | med | 2 | STR-2/4 resilience tail (STR-1 done) |
| 690 | 🟡 | high | 0 | Encrypt OAuth `Account` tokens (AUTH-2) |
| 691 | 🔴 | high | 0 | Unsubscribe links + `triggerWorkflowSafe()` |
| 692 | 🟡 | med | 3 | Velocity/IP anti-fraud + expire-credits cron |
| 693 | 🔴 | **blocker** | 0 | **Wire moderation actionType side-effects** |
| 694 | 🟡 | high | 0 | Encrypt verification docs + rate-limit uploads |
| 695 | 🟡 | high | 0 | Fix passwordless staff + audit financial admin |
| 696 | 🟡 | med | 0 | Drop email from public search predicate |
| 697 | 🟡 | high | 2 | `withJobExecution()` + maintenance TTL + breaker |
| 698 | 🔴 | med | 4 | `calculateProfileCompletion` + OB-2 refresh |
| 701 | 🟡 | med | 3 | LCY residuals (consent/residency/breach/HRIS) |
| 702 | 🔴 | low | 5 | Affiliate — defer to ~₹5L MRR |
| 705 | 🟡 | med | 3 | Analytics + PG extensions + Realtime trio |
| 724 | 🔴 | low | 5 | `ensureOrgWorkspaceProfile` + delete backstop |
| 725 | 🔴 | high | 3 | BetterAuth Tier-1 — 2FA + Captcha first |
| 733 | 🔴 | low | 5 | Folder Phase-1 READMEs + eslint layering |
| 734 | 🟡 | med | 5 | include→select sweep + bundle split |
| 738 | 🟡 | high | 1 | Chargeback tax cascade + 194O decision |
| 739 | 🔴 | low | 5 | Agentic support — RFC only |
| 746 | 🔴 | low | 5 | Enterprise roadmap umbrella |
| 767 | 🔴 | low | 5 | CMS/newsletter vendor decision (blocks 312/334) |
| 770 | 🔴 | med | 3 | Contract lifecycle GAP-2→1→3 + billingMode |
| 834 | ✅ | med | 1 | Add unique constraint on schema reset |
| 837 | 🟡 | high | 0 | Run staging chaos go/no-go (code done) |
| 840 | 🔴 | high | 3 | First-class org-invitee onboarding path |
| 842 | 🔴 | low | 5 | Re-run knip + de-export behind gate |
| 855 | ✅ | med | — | Close — auto-refund on capture-after-cancel |
| 860 | 🔴 | med | 2 | Narrow auto-allocate lock + per-event lock |
| 863 | 🟡 | med | 3 | Residuals register — tick ScimToken.expiresAt |
| 866 | 🔴 | high | 2 | Migrate ~10 jobs to QStash + GA heartbeat |
| 867 | 🟡 | high | 4 | Split 71 semantic-correctness findings |
| 868 | 🟡 | high | 4 | Finish redesign residuals + merge branch |
| 869 | 🔴 | low | 5 | Phased codebase reorg — defer |
| 872 | 🔴 | low | — | DST timezone — parked (schema frozen) |
| 874 | 🔴 | **blocker** | 0 | Run + record capacity go/no-go |
| 875 | ♻️ | low | — | Close — discussion issue |
| 880 | 🟡 | med | 5 | Confirm reward ramp + verify OAuth capture |
| 884 | ♻️ | low | — | Parked — stub kept |
| 891 | 🔴 | low | 5 | Only clear referral stash on manual empty submit |
| 899 | 🟡 | high | 2 | Event-driven channels + reconciliation cron |
| 900 | 🟡 | med | 2 | Confirm Netlify build env + rotate token |
| 902 | 🔴 | low | 4/5 | Align prefetch key/shape (quick win) |
| 906 | 🔴 | med | 4 | Parallelize `/api/appointments` reads |
| 920 | 🟡 | med | 2 | Finish dynamic pages + drop IS_NEXT_BUILD |
| 932 | 🟡 | high | 0 | Verify Functions region → Singapore |
| 937 | 🔴 | med | 2 | Evaluate Prisma Accelerate vs region move |

*Runtime-verification flagged (money/security, code read only):* #677, #676, #738, #855, #337, #536, #405/#407 (Redis env), #690, #900, #932 (region), #932/#835 wallet refund.
