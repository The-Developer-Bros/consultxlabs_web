# Billing, Seats & SSO

## Context

Programs: LICENSED_SEAT and CREDIT_POOL. Seats aggregate into billing subscriptions; wallet prepaid with conditional debit; INVOICE accrual + dunning; LICENSE utilization metering. Unverified orgs capped (5 seats, invoice limits). SSO: domain claims, enforceSSO, JIT join, SCIM Users API. Verification loop: PENDING_VERIFICATION → admin verify.

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short) | Verdict |
|---|---|
| Wallet auto-top-up notify-only, no money moves (#777) | 🔵 TRACKED #777 |
| `ENABLE_DUNNING_SUSPEND` off — orgs linger unpaid | 🔵 TRACKED #779 (by-design flag) |
| Host economics / 3-way split behind `ENABLE_HOST_ORGS` | 🔵 by-design gate |
| SCIM docs drift vs live `/scim/v2/**` | 🟡 LEGIT-DEFERRED (doc drift) |
| PERSONAL funding reimbursement (#714) incomplete | 🟡 LEGIT-DEFERRED |
| SSO settings PATCH last-write-wins (see concurrency file) | ✅ FIXED-BY #985 (version CAS) |
| SCIM bypasses unverified seat governance (see concurrency file) | ✅ FIXED-BY #985 |

## Known gaps / bugs

- Wallet auto-top-up: schema + notify-only cron — **no money moves** (#777).
- `ENABLE_DUNNING_SUSPEND` off — orgs may linger unpaid while still booking.
- Host economics / 3-way split behind `ENABLE_HOST_ORGS`.
- SCIM docs drift vs live `/scim/v2/**`.
- PERSONAL funding reimbursement nuances (#714) incomplete product story.

## Unhappy paths & user psychology

- Finance expects auto-recharge like AWS; gets Slack/email only; bookings fail mid-workshop.
- Employee SSO login creates LEARNER; they expected EXPERT access — defaultRole misconfigured.
- Seat count hits cap during HR bulk onboard — partial success confusion (bulk 405).

## Questions (handled?)

1. **Razorpay mandate auto-top-up timeline (#777)?**  
   - A) Build before enterprise GA  
   - B) Manual top-up OK for design partners  
   - C) Invoice-only customers; wallet secondary  

**Recommendation: B.** Notify-only wallet is fine for design partners if UI is honest; ship #777 when volume justifies mandates.  
- Not A: Blocks GA on a convenience feature partners can live without.  
- Not C: Wallet is already in the funding model; demoting it confuses existing paths.

2. **Dunning auto-suspend default on for enterprise tier?**  
   - A) On after 3 reminders  
   - B) Manual suspend only  
   - C) Soft-block new bookings; keep existing  

**Recommendation: B.** Design-partner ops should suspend by hand until dunning copy and edge cases are battle-tested.  
- Not A: Auto-suspend mid-workshop is a trust nuke with few tenants.  
- Not C: Soft-block still surprises buyers without clear finance UX.

3. **SCIM — beta allowlist or public?**  
   - A) Update docs; allowlist customers  
   - B) Feature flag off by default  
   - C) Keep 405 for write until certified  

**Recommendation: A.** Code is live — fix doc drift and gate customers via allowlist so IT can onboard safely.  
- Not B: Hides a working surface and worsens doc/code mismatch.  
- Not C: Write 405 contradicts implemented SCIM and frustrates HRIS pilots.

## High concurrency / multi-device

Wallet debit and seat adjust are race-safe. SSO JIT + invite accept concurrently for same email need membership uniqueness. Multi-device SSO login bumps session expectations.

## Suggested directions

Honest UI for auto-top-up (“notify only”). Decide SCIM status and fix docs.
