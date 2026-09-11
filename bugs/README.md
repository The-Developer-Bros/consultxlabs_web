# Bugs — CTO Subsystem Audit Pack

High-level investigation notes for Familiarise: incomplete work, concurrency traps, multi-device unhappy paths, and open architecture questions. This is **not** a ticket tracker and **not** a rewrite of `docs/` — it is a CTO lens that points at real gaps found in code and docs.

## Triage outcome (2026-07-12)

This pack was fully triaged on 2026-07-12: three verifier agents cross-checked every claim against the current codebase, and a wave of fourteen fix PRs (#981–#994) was then shipped. Each dossier now carries a `## Triage verdict (2026-07-12)` section that stamps its claims with one of ✅ FIXED-BY, 🟡 LEGIT-DEFERRED, 🔵 TRACKED, ❌ STALE/OVERSTATED, or 🎯 DESIGN-DECISION, and the A/B/C questions carry one-line 🎯 notes wherever a decision is now locked.

The fourteen fix PRs are: #981 stream-security, #982 adr18-allowlist, #983 recordings-pipeline, #984 gateway-cleanup (schema), #985 onboarding-identity, #986 waitlist-seat-hold, #987 reviews-integrity (schema), #988 booking-correctness, #989 trust-safety-sweep, #990 money-auto-refund, #991 enterprise-invoice-trust, #992 noshow-automation, #993 payout-batched-status (schema), and #994 checkout-earnings-atomicity.

### Corrections — where this audit was wrong

Several headline claims in this pack did not survive verification against the live code, and they are corrected here so the record is honest.

1. **The "B2C consultant still on 194J" P0 is stale.** Consultant withholding already runs at 194-O through `computeTdsForPayout` (payout-service.ts:592-607); the legacy `tds-service.ts` engine only supplies financial-year helpers and audit-trail data. There is no dual-engine 194J exposure on the live payout path.
2. **The "incomplete refund tax cascade" claim is overstated.** Both adjustment models are already wired from `refund.ts`: the TDS reversal via `recordTdsReversal` (refund.ts:593) and the GST TCS adjustment via `gstTcsAdjustment.create` (refund.ts:723). Only the monthly `GstTcsBatch` collection is genuinely deferred.
3. **DPDP is not missing self-serve erasure.** A self-serve erasure-request endpoint already ships; the claim of "no self-serve delete" is half-overstated. Only self-serve data *export* is actually absent, and that piece is deferred.
4. **Two issue numbers were misattributed.** The audit tied GST TCS to #780, but #780 is the BigInt money migration; and it tied Form 26Q to #738, whereas the code cites #737.
5. **Recording expiry uses `now()+14d`, not `recordedAt+14d`.** The distinction is immaterial to the retention argument but the audit's phrasing was wrong.
6. **The paid-trial funnel is wired, not "partial schema."** `trialPriceInPaise` flows through checkout, so the trial→pay path is not broken.

### Schema-push status

Two of the schema-carrying PRs are safe to push now because their changes are additive: the review-integrity unique constraint (#987) and the BATCHED payout status (#993). Before pushing #987, existing duplicate `(consultant, consultee)` review rows must be de-duplicated so the new unique constraint can be created. The gateway enum removal in #984 was deferred to the pre-MVP database reset because 156 `Payment`, 21 `Refund`, and 10 `Dispute` rows referenced the `LEMON_SQUEEZY` and `XFLOW` enum values, and dropping the values would have orphaned them. **That is no longer true.** Re-checked against the live database on 2026-07-29: zero rows in `Payment`, `Refund` or `Dispute` reference either value — the seed no longer produces them. The blocker for the removal is therefore gone, and what remains is only the mechanics, since Postgres has no `ALTER TYPE … DROP VALUE` and the change needs a type recreation and swap. Until that lands, `scripts/ci/check-db-drift.ts` tolerates the two live-only labels via `prisma/sql/known-drift.json` with an expiry of 2026-09-30, after which CI turns red rather than letting the drift become permanent.

### Deferred but legitimate (rolled up)

The following gaps are real and intentionally left for after this wave: the grievance page plus age gate (compliance, user-deferred), self-serve data export (DPDP), true multi-currency settlement (#783), post-payout clawback netting against the next batch, the subscription no-show remainder (TODO#471, since #992 automates only the consultation no-show), and a real session-revoke mechanism that needs the BetterAuth admin plugin (#725).

## How to read

1. Start with **finances** (mission-critical money movement).
2. Then **booking** (inventory + payment handshake).
3. Then **enterprise**, **stream**, **compliance**.
4. Skim secondary folders for growth/trust/ops risk.
5. Read **cross-cutting** last for multi-device psychology and deadlock patterns that span products.

Each markdown follows: Context → Known gaps → Unhappy paths → Questions (A/B/C) → Concurrency / multi-device → Suggested directions.

After every A/B/C question, a **Recommendation** names the preferred option with a short why, plus why-not for the other two. Recommendations are CTO judgment for Familiarise *now* (money/booking safety, India launch, design-partner gates)—not irreversible product law.

## Severity legend

| Tag | Meaning |
|-----|---------|
| **P0** | Revenue integrity, legal unenforceability, or security that can mint wrong access / money |
| **P1** | Consistency debt that creates ops burden or user distrust at moderate scale |
| **P2** | Deferred / flagged / scale-future; safe to ship with eyes open if documented |
| **Q** | Product or policy decision still open — engineering cannot close alone |

Questions use **A / B / C** short approaches. They are not ranked recommendations unless marked.

## Index

### Mission-critical

| Folder | Focus |
|--------|--------|
| [finances/](finances/) | Checkout, webhooks, payouts, refunds, disputes, ledger, FX, tax |
| [booking/](booking/) | Slots, locks, double-booking, cancel/reschedule/no-show |
| [enterprise/](enterprise/) | Orgs, taxonomy, host agencies, money trust, KYB, concurrency/gaming — start [00-overview](enterprise/00-overview.md) |
| [stream/](stream/) | Chat, video, tokens, recordings, multi-tab calls — **P0:** [recording storage scale](stream/recording-storage-scale-infrastructure.md) |
| [compliance/](compliance/) | TDS/GST/DPDP, legal pages, grievance, audit |

### Secondary

| Folder | Focus |
|--------|--------|
| [feedback-reviews/](feedback-reviews/) | Platform feedback vs consultant ratings |
| [support/](support/) | Tickets, SLA, entity-linked disputes |
| [explore-discovery/](explore-discovery/) | Browse, search, PII, community |
| [waitlist/](waitlist/) | Queue, notify, seat hold |
| [referrals/](referrals/) | Attribution, credits, farming |
| [collaborators/](collaborators/) | Co-hosts, revenue split |
| [notifications/](notifications/) | Resend, Novu, push/SMS gaps |
| [auth-onboarding/](auth-onboarding/) | Single role, dual-profile UX |

### Cross-cutting

| File | Focus |
|------|--------|
| [cross-cutting/multi-device-psychology.md](cross-cutting/multi-device-psychology.md) | Tabs, phones, iPads, same-email dual flows |
| [cross-cutting/deadlocks-and-inconsistencies.md](cross-cutting/deadlocks-and-inconsistencies.md) | Lock order, Phase-2 windows, doc/code drift |

## Reading order (suggested)

1. [finances/00-overview.md](finances/00-overview.md)
2. [booking/00-overview.md](booking/00-overview.md)
3. [enterprise/money-payouts-earnings-trust.md](enterprise/money-payouts-earnings-trust.md) (P0 sponsor trust)
4. [enterprise/taxonomy-and-reachable-paths.md](enterprise/taxonomy-and-reachable-paths.md)
5. [stream/recording-storage-scale-infrastructure.md](stream/recording-storage-scale-infrastructure.md) (P0 media durability)
6. [enterprise/onboarding-multi-device-role-race.md](enterprise/onboarding-multi-device-role-race.md)
7. [stream/chat-security-and-roles.md](stream/chat-security-and-roles.md)
8. [compliance/b2c-vs-b2b-gaps.md](compliance/b2c-vs-b2b-gaps.md)
9. [cross-cutting/multi-device-psychology.md](cross-cutting/multi-device-psychology.md)

## Related docs (canonical engineering)

- `docs/booking/`, `docs/payments/`, `docs/enterprise/`, `docs/stream/`, `docs/compliance/`
- Race suite: `tests/typescript/race-conditions/`
- Feature flags: `lib/feature-flags.ts`

---

*Generated as an architecture audit pack. Update when go-live gates flip or P0 gaps close.*
