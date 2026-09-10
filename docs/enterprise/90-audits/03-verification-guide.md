---
title: Enterprise verification guide — seeded logins + step-by-step flows
band: 90-audits
audience: sde4
status: live
last-reviewed: 2026-06-05
---

# Enterprise verification guide — seeded logins + step-by-step flows

The database was reset and reseeded (`small` mode). This guide gives you **every mock login** and a **click-through flow** to verify the enterprise subsystem across all org archetypes. Pair it with [`subsystem-checklist`](02-subsystem-checklist.md) (what each phase covers + known gaps).

> **One password for everything:** `SeedPass123!`
> **Start the app:** `npm run dev` → http://localhost:3000 → sign in.
> **Reset/reseed again:** `npx prisma db push --force-reset && SEED_MODE=small npx tsx prisma/seed.ts` (needs `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<your consent text>"`; the remote pooler is slow — `small` mode is the reliable one).

---

## 🔑 Credentials (all password = `SeedPass123!`)

> This table is the authoritative seed-cohort roster; the agent-run case files under [`prompts/enterprise-tests/`](../../../prompts/enterprise-tests/) reference it from their shared setup ([`_shared/shared-setup.md`](../../../prompts/enterprise-tests/_shared/shared-setup.md) §2) rather than maintaining a copy. If a reseed ever changes these logins, update both places.

### Canonical demo login (start here)
| Login | Role | Org | What it shows |
|---|---|---|---|
| **`tour-owner@familiarise.dev`** | OWNER | Wipro | The dedicated tour account (`ORG_WORKSPACE`), OWNER of the SPONSOR org. |

### By org archetype
| Org | Archetype | Funding / Program | Persona | Email |
|---|---|---|---|---|
| **Wipro Limited** (`wipro`) | **SPONSOR** (sponsor✓ host✗) | INVOICE · LICENSED_SEAT (200 seats, 12 covered/cycle) | OWNER | `zara.brown@yahoo.com` |
| | | | OWNER (tour) | `tour-owner@familiarise.dev` |
| | | | LEARNER | `robert.brown@gmail.com` |
| | | | LEARNER | `samantha.brown@outlook.com` |
| | | | LEARNER | `sarah.brown@yahoo.com` |
| **IIT Madras** (`iit-madras`) | **HYBRID** (sponsor✓ host✓) | WALLET (₹14,75,000) · CREDIT_POOL | OWNER | `charlotte.anderson@gmail.com` |
| | | | EXPERT | `andrew.anderson@gmail.com` (also: angela, arjun, benjamin, catherine) |
| | | | LEARNER | `sophia.brown@hotmail.com` (also: thomas, victoria, william) |
| **LearnPro Academy** (`learnpro-academy`) | **HOST** (sponsor✗ host✓) | RateCard 10/10/80 | OWNER | `daniel.anderson@outlook.com` |
| | | | EXPERT | `aarav.anderson@gmail.com` (also: aditi, alex, amit, ananya) |
| **Arjun Anderson's Coaching** (`arjun-anderson-coaching-2ncb`) | **solo HOST** | personal org | OWNER | `arjun.anderson@yahoo.com` |
| **Platform admin** | — | — | ADMIN | `robert.davis@yahoo.com` |

> Note: `arjun.anderson@yahoo.com` is OWNER of the solo coaching org **and** an EXPERT at IIT Madras — a built-in **multi-org consultant** example.

The org-archetype roster above was regenerated from the live database on 2026-09-06, against the `Membership`, `users`, and `organizations` tables in Supabase project `pzmbxqdgibfkhjwzeprf`, after a 2026-09-06 E2E run found that `rachel.anderson@hotmail.com` (the previously documented IIT Madras LEARNER) has no live membership at all; the actual IIT Madras LEARNER cohort is the Brown family (`sophia`, `thomas`, `victoria`, `william`).

```sql
-- Active enterprise memberships for the four seed orgs, joined to email/name/role.
SELECT o.name AS org_name, m.role, u.email, u.name, m.status
FROM "Membership" m
JOIN users u ON u.id = m."userId"
JOIN organizations o ON o.id = m."organizationId"
WHERE o.slug IN ('wipro', 'learnpro-academy', 'iit-madras', 'arjun-anderson-coaching-2ncb')
ORDER BY o.name, m.role, u.email;

-- Live ADMIN-role users (the "Platform admin" persona).
SELECT email, name, role FROM users WHERE role = 'ADMIN';
```

### Seeded data summary
`4 orgs · 78 users · 22 enterprise memberships · 2 programs · 2 contracts · 1 invoice (Wipro, DRAFT) · 8 ledger transactions`

---

## 🧭 Step-by-step verification flows

Each flow maps to phases in [`subsystem-checklist`](02-subsystem-checklist.md). Switch orgs via the org switcher (top-left) or the URL.

### Flow A — Operator console tour (SPONSOR / INVOICE / LICENSED_SEAT)
**Login:** `tour-owner@familiarise.dev` → lands on the Wipro org dashboard.
1. **Home** — overview stats **plus the state-aware activation checklist + "action required" center** (#777 §A / #779 §F): a fresh org shows the Getting-Started steps (verify → billing → contract → program → invite → assign), and condition banners surface for overdue invoices, cap-near programs, contracts expiring ≤30d, pending overage (framed as an upsize prompt), low wallet, and stuck payouts. The checklist auto-hides once every step is done. *(Phase 1 / 23)*
2. **Members / Learners** — see the 3 LEARNERs + owners; try add/edit/remove. *(Phase 2)*
3. **Invitations** — send an invite, copy the link, revoke it. *(Phase 3)*
4. **Contracts** — the annual license contract (ACTIVE). Open the detail; **Edit contract** lets you change safe fields, and **Terminate** is guarded — it refuses until live assignments are cancelled, then cascades the contract → programs EXPIRED → assignments CLOSED (#779 §A). Note `Auto-renew` is shown read-only; renewal/supersession run via the cron + `/contracts/[contractId]/supersede` route, not a button yet (#777 §B). *(Phase 7)*
5. **Programs** — "Wipro Engineer Leadership Program" (LICENSED_SEAT, 200 seats, 12 covered/cycle). Open it; assign a learner. Try the overage-behavior selector + surcharge (`overageSurchargeBps`) + circuit-breaker (`maxOveragePerCyclePaise`) fields. **Money fields lock** once the first assignment exists (`configLockedAt`, #779 §B) — re-open and confirm they're read-only; safe fields (name) stay editable. *(Phases 11, 14)*
6. **Billing → Invoices** — the DRAFT invoice; open the PDF. *(Phase 9)*
7. **Audit** — every action you just took is logged; export CSV. *(Phase 6)*
8. **Settings** — edit name/branding. Money-bearing fields (billing email, funding) are gated to OWNER/BILLING_ADMIN via the field-level RBAC disjunction (#779 §A) — sign in as a MANAGER to confirm they're hidden/blocked. *(Phase 0)*
9. **Integrations** — Webhooks (create an endpoint, **rotate secret** → confirm the old secret still verifies for the 24h grace window, #777), SCIM (token), Data Exports (request one → poll until READY → download via the 7-day signed URL). *(Phases 4, 5, 19)*

### Flow B — Learner: covered booking → overage (the money path)
**Login:** `olivia.anderson@gmail.com` (Wipro LEARNER).
1. **My Program** — see the allocation, covered engagements, usage bar. *(Phase 23)*
2. **Book a covered session** against the program (org pays). Watch the payer show "Bill to Wipro". *(Phase 13)*
3. **Exceed the cap** — at checkout the **pre-checkout overage preview** (#777 §C — `OrgPayerSelector`, backed by `/checkout/overage-preview`) warns *before* you confirm that this booking exceeds the cap and what the marginal (base + surcharge) will cost. Confirm anyway → overage fires per the program's behavior:
   - **CHARGE_ORG** → `OverageEvent` ACCRUED, rolled into the org invoice (check Wipro's billing).
   - **CHARGE_MEMBER** → a PENDING `OverageEvent` side-charge appears at **`/dashboard/overage`** → pay it via Razorpay (test mode); abandon it and the `timeout-member-overages` cron flips it FAILED (`chargeTimedOutAt`). *(Phase 14)*
   - **BLOCK** (or circuit-breaker `maxOveragePerCyclePaise` blown) → booking refused at the cap.

### Flow C — HYBRID: wallet + CREDIT_POOL money-meter
**Login:** `charlotte.anderson@gmail.com` (IIT Madras OWNER).
1. **Billing → Wallet** — ₹14,75,000 balance; do a top-up (Razorpay test) and watch the balance + ledger update. *(Phase 10)*
2. **Programs** — the CREDIT_POOL program (credits = paise meter). Assign `rachel.anderson@hotmail.com`. *(Phase 11)*
3. **As the learner**, book sessions → credits burn by **price** (a ₹5,000 session burns more than a ₹500 one — the money-meter, #753 fixed). Exceed the budget → overage. *(Phase 14)*
4. **Experts tab** — IIT also hosts experts (it's HYBRID). *(Phase 16)*

### Flow D — HOST: experts, rate card, earnings, payouts
**Login:** `daniel.anderson@outlook.com` (LearnPro OWNER).
1. **Experts** — the 5 EXPERT members. *(Phase 16; note: add-EXPERT UI is missing — #729.)*
2. **Rate cards** — the 10/10/80 split. *(Phase 12; note the ownerOrgId wizard bug #728.)*
3. **Payouts** — create a payout batch. **Expect it to sit in PROCESSING** — gateway disbursement is gated off (`ENABLE_LIVE_PAYOUTS`, #776 §B). This is *expected*, not a bug. *(Phase 16)*
4. **Earnings** — consultant/org earnings with the 3-way split. *(Phase 16)*

### Flow E — Expert surface
**Login:** `aarav.anderson@gmail.com` (LearnPro EXPERT).
- **My Arrangement** — payout recipient (SELF/ORG) + earnings split. *(Phase 23; note: experts can't yet see their org-booked appointments — #754.)*

### Flow F — Multi-org consultant
**Login:** `arjun.anderson@yahoo.com` — OWNER of the solo coaching org **and** EXPERT at IIT. Switch between the two via the org switcher to see the dual context. *(Phase 0 switcher)*

### Flow G — Platform admin: verify an org
**Login:** `olivia.brown@protonmail.com` (ADMIN).
- New orgs land in `PENDING_VERIFICATION`; verify/suspend/**reject** them from the admin surface.
- **Reject → resubmit loop** (#779 §A): reject an org's verification, then sign in as that org's OWNER — the home action center surfaces the rejection and the org can resubmit via `/verification/resubmit` (Organization stamps; no `RESUBMIT` enum). Re-verify it as ADMIN to close the loop. *(Phase 1)*

---

## 🆕 v2 lifecycle & money-safety flows (#777 / #778 / #779)

These exercise the surfaces the v2 mega-audit added. Most are **full dashboard UI**; the two marked *(API/route-level)* have no dedicated button yet — drive them via the route (e.g. with the seeded session cookie) and verify the *effect* in the UI.

### Flow H — Wallet auto-top-up settings (HYBRID, WALLET org)
**Login:** `charlotte.anderson@gmail.com` (IIT Madras OWNER) → **Billing → Wallet** tab.
1. Set a **minimum balance** (e.g. ₹1,000) and a top-up amount → save. The cron keys off `minBalancePaise`; `autoTopUpEnabled` stays false until a mandate (`autoTopUpMandateId`) is attached — the API rejects enabling it without an amount. *(Phase 10, #777 §C)*
2. Verify the low-balance banner: when the balance is below `minBalancePaise`, the home **action center** shows "Wallet balance low → Top up".

### Flow I — Dunning visibility on overdue invoices (SPONSOR, INVOICE org)
**Login:** `tour-owner@familiarise.dev` (Wipro) → **Billing → Invoices**.
- An **OVERDUE** invoice renders with its lateness quantified ("OVERDUE · N days late"), not an undated alarm. The `dunning` cron marks ISSUED→OVERDUE past `dueDate` and sends 7-day × 3 reminders (`notifyOrgInvoiceOverdue`); the home action center shows "N invoices overdue → Pay now". *(Phase 9, #779 §A.)* **Note:** booking-suspend on terminal non-payment now ships behind `ENABLE_DUNNING_SUSPEND` (#812) — with the flag set, stage 3 stamps `dunningSuspendedAt` 7 days past the last reminder and blocks new sponsored bookings; with the flag unset, reminders fire but the org is not frozen.

### Flow J — Contract terminate + cascade / supersede (SPONSOR org)
**Login:** `tour-owner@familiarise.dev` (Wipro) → **Contracts**.
1. **Terminate** the contract while a program has live assignments → the guard blocks ("cancel assignments first"). Cancel them, terminate → the cascade flips programs EXPIRED + assignments CLOSED in one tx (no zombies). *(Phase 7, #779 §A)*
2. *(API/route-level)* **Supersede / amend / renew** — `POST /contracts/[contractId]/supersede` mints the replacement and chains `supersededByContractId` + `supersessionReason` (AMENDMENT / RENEWAL / TERMINATION_REPLACEMENT). Confirm the old row shows superseded and the new row is ACTIVE. Auto-renew is driven by `jobs/contracts/auto-renew-contracts.ts` (`autoRenewedAt` claim-gate), not a button.

### Flow K — SSO break-glass open/close (any org with SSO)
**Login:** the org OWNER → **Settings → SSO**.
1. Turn **Enforce SSO** on (password login now blocked for claimed domains). *(Phase 4)*
2. *(API/route-level)* Simulate the IdP being down: `POST /sso/break-glass` opens a time-boxed window (`OrganizationSSOSettings.breakGlassUntil`) where password login is permitted again; the auth layer skips the `enforceSSO` gate while `breakGlassUntil > now`. Who/why is captured in the `OrgAuditLog` row the route emits. Closing = let it lapse or `DELETE` the window. *(#779 §E.)* **Note:** no dashboard control yet — verify via the route + an audit-log entry.

### Flow L — Consent grant / withdraw (DPDP §6(4))
**Login:** any org OWNER/MANAGER → **Consent**.
- The page lists this org's `ConsentArtifact`s (active + withdrawn history) and exposes **Withdraw** at the *same prominence* as grant (DPDP §6(4)). Withdraw a consent (optionally scoped to one `purposeCode`); it's irreversible — a re-grant is a fresh POST. *(Phase 6 / compliance.)*

### Flow M — Data-export request + download (DPDP §11)
**Login:** OWNER or BILLING_ADMIN → **Integrations → Data Exports**.
- Request an export → the row polls PENDING → PROCESSING → **READY** (`process-data-exports` cron), then a **download** link appears with a 7-day signed-URL TTL. FAILED/EXPIRED stop the poll. *(Phase 19, `OrgDataExportJob`.)*

---

## 🔬 Backend / integrity verification
```bash
# 1. Ledger reconcile — should be ok:true, 0 findings on a fresh reseed.
#    v1 (#776) adds LEDGER_BALANCE_SNAPSHOT_DRIFT + REFUND_BOOKING_COHERENCE.
npx tsx -r dotenv/config scripts/reconcile/reconcile-ledgers.ts

# 2. Typecheck + enterprise tests
NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit
npx jest __tests__/enterprise/

# 3. Live-payout sandbox proof — MUST pass with ENABLE_LIVE_PAYOUTS unset.
#    Asserts the gate holds (no gateway submission while flagged off). See
#    docs/enterprise/50-operations/06-live-payout-go-live-runbook.md.
npx tsx -r dotenv/config scripts/smoke/org-payout-sandbox-smoke.ts

# 4. Inspect data visually
npm run db:studio   # Prisma Studio
```

### v1 (#776) verifiable surfaces
- **Marketplace leak (#726):** sign out / open `/explore` — an org's `ORG_ONLY`
  plan must NOT appear in the curated carousels or inflate a topic's count.
- **Org disputes:** a finance role (OWNER/MAINTAINER/BILLING_ADMIN/MANAGER) sees
  **Disputes** under Commerce → `[orgId]/disputes`. A LOST chargeback on an
  org-wallet-funded booking debits the org wallet (org bears it), falling back
  to an `ORG_RECEIVABLE` when the wallet can't cover it.
- **Credit notes:** refunding an invoiced (CHARGE_ORG / INVOICE_ACCRUAL) payment
  mints a `CreditNote` (`<PREFIX>-CN-<FY>-<seq>`) referencing the original
  invoice with a proportional CGST/SGST/IGST split.
- **Observability:** set `ENABLE_BETTERSTACK_TELEMETRY=true` + source token; a
  failed reconcile / stuck payout / webhook backlog / HMAC failure ships to the
  BetterStack Telemetry tail.

---

## ⚠️ What's intentionally incomplete (don't be alarmed)
These are **known, tracked gaps** — verifying them as "not there" is correct. Full list + audit refs in [`subsystem-checklist`](02-subsystem-checklist.md). *(Updated 2026-06-05 post-v2 — several former gaps now ship; see the v2 flows above.)*
- **Payout disbursement** sits at PROCESSING (gated `ENABLE_LIVE_PAYOUTS`, #776 §B) — money doesn't leave the gateway yet.
- **Dunning suspension cascade** is **config-gated off by default** (#812) — overdue reminders fire (7-day × 3), and stage 3 auto-suspends the org 7 days past the last reminder only when `ENABLE_DUNNING_SUSPEND` is set; with the flag unset there is no auto-suspend.
- **Add-EXPERT UI** (#729), **expert appointment view** (#754) — not built.
- **Contract supersede/renew + SSO break-glass** exist as **routes/crons, not dashboard buttons** yet (#777 §B / #779 §E) — drive them via the route (Flows J/K).
- IRN/e-invoice (`ENABLE_IRP_UPLOADER` off), GST TCS, Form 26Q/16A (`ENABLE_TDS_ADMIN_VIEW` off) — schema present, filing deferred (#778). Credit notes on refund **do** mint (#776).

> **Now shipped in v2** (verify them as *present*, per the flows above): state-aware activation + action-center home (#777 §A / #779 §F), pre-checkout overage preview (#777 §C), invoice dunning reminders (#779 §A), cycle-engine rollover + contract cascade (#779 §A), program config-lock (#779 §B), wallet auto-top-up settings (#777 §C), self-serve verification resubmit (#779 §A), webhook secret rotation grace (#777).

> Everything marked `✅` in the checklist should work against this seed; everything `🟡`/`❌` is on the v0–v4 audit roadmap (#768/#776/#777/#778/#779).
