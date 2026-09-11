# High Concurrency & Traffic Spikes

> **Verdict pass 2026-09-03/04.** Every money claim in this file was re-checked against `dev@e1766fa2d` and the live database as part of the 2026-09-03 finance-subsystem verification. Of 9 claims, 4 are still true today, 5 have been addressed since this dossier was written, and 0 are stale. See [`docs/payments/audits/2026-09-03-finance-verdicts.md`](../../docs/payments/audits/2026-09-03-finance-verdicts.md) for the per-item disposition.

## Context

Money paths already assume concurrency: Redis checkout locks, Serializable isolation, wallet conditional updates, webhook dedup, payout idempotency keys, ledger sorted locks. GitHub Actions crons backstop orphans, stuck webhooks, earnings sync, refund cascade, and ledger drift. Race tests exist under `tests/typescript/race-conditions/` (webhook storms, cancel-vs-webhook).

## Triage verdict (2026-07-12)

Triaged 2026-07-12 against real code (3 verifier agents cross-checked every claim); fix wave PRs #981–#994 shipped. This dossier's claims map as follows:

| Claim (short)                                           | Verdict                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Prisma pool exhaustion under long Serializable txs      | 🔵 TRACKED #368 (CLOSED — pooler fix landed)                                                       |
| Event checkout fail-closed on Redis outage              | 🔵 by-design (seat safety over conversion)                                                         |
| Consultation path leans on DB GiST if Redis fails       | 🔵 handled (#440 exclusion constraint live)                                                        |
| Cron jitter delays sweeper/cleanup                      | 🔵 TRACKED #866 (cron→QStash plan)                                                                 |
| Hot consultant auto-allocate lock serializes consultant | ✅ FIXED-BY #988 (#860 sharded locks; auto-allocate keeps consultant key by design, GiST backstop) |

## Known gaps / bugs

- Prisma pool exhaustion risk when long Serializable checkout/allocation txs pile up (#368).
- Event checkout fail-closed on Redis outage (503) — correct for seats, harsh for conversion at peak.
- Consultation path relies more on DB GiST if Redis fails — asymmetric.
- Cron jitter (Actions) means tentative cleanup / sweeper delay under load.
- Hot consultant auto-allocate lock serializing an entire consultant — the 2026-09-03 verdict pass confirmed this FIXED-BY #988 (#860 sharded locks); auto-allocate keeps the consultant key by design, with the GiST constraint as a backstop.

## Unhappy paths & user psychology

- Flash webinar: 500 users hit last 10 seats — many see 409/503; some pay and lose at confirm; support floods.
- Payment success emails lag Phase-2 — users refresh and create duplicate tickets.
- Org wallet mega-booking day: sequential debit contention → intermittent failures feel like “site broken.”

## Questions (handled?)

1. **Load-test target for checkout QPS and webhook burst before marketing spikes?**
   - A) Formal k6/Gatling gate in CI monthly
   - B) One-off pre-launch test only
   - C) Rely on race unit suite

**Recommendation: A.** Formal checkout/webhook load gates catch pool exhaustion (#368) and lock bottlenecks before marketing spikes create real chargebacks.

- Not B: A single pre-launch run goes stale as checkout and cron paths change.
- Not C: Race unit tests prove correctness under contention, not QPS or Prisma pool headroom.

2. **Redis down during peak — fail closed everywhere or degrade 1:1 to DB-only?**
   - A) Fail closed all paid checkout
   - B) Events fail closed; 1:1 continue on GiST
   - C) Queue checkout intents for later processing

**Recommendation: B.** Keep event capacity fail-closed on Redis outage while 1:1 can rely on GiST as the confirmed-slot backstop.

- Not A: Blocking all paid checkout when GiST still protects 1:1 over-punishes consultations during a Redis blip.
- Not C: Queued intents defer money state and create worse “paid later / seat gone” psychology at peak.

> 🎯 Locked: rec B matches shipped behaviour — events fail closed on Redis, 1:1 continues on the GiST backstop.

3. **Move booking/money crons from Actions to a real queue (#866)?**
   - A) Inngest/BullMQ near-term
   - B) Keep Actions until scale pain
   - C) Hybrid: critical sweepers on always-on worker

**Recommendation: C.** Put money-critical sweepers (webhooks, refunds, tentative cleanup) on an always-on worker while leaving lower-urgency jobs on Actions.

- Not A: A full near-term queue migration is speculative ops redesign ahead of fixing known refund/idempotency bugs.
- Not B: Actions jitter already delays confirmation/refund healing under load — waiting for “scale pain” risks paid users.

> 🎯 Locked: tracked under #866 — money-critical (Class A) jobs move to QStash while business crons stay on GitHub Actions; monolith retained, no Temporal.

## High concurrency / multi-device

Same user across phone + laptop should be serialized by `lockConsulteeBooking` for booking-shaped payments. Different users on same slot: expect one winner; losers need clear UX (“slot taken — refund processing”). Idempotency keys must survive mobile WebView reloads.

## Suggested directions

Define a “payment succeeded / booking pending” status page. Page on-call for webhook sweeper lag during campaigns.
