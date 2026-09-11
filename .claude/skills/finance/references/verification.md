# How money is proven here

Verifying a money change means producing an actual gateway event, an actual database write, and an actual reconciler pass, and then checking the rows by SQL rather than trusting an agent's or a reviewer's description of what should have happened. This page is the recipe.

## Where to run it: a deploy preview, never a local dev server

The shared Supabase project is fragile and serves both dev and prod (there are no branches), so money-path verification runs against a Netlify deploy preview rather than a local `next dev` session. Two things make this practical since 2026-09-04: browser sign-in on Netlify previews now works, because the deploy-preview context carries a wildcard trusted origin (it used to 403 with `INVALID_ORIGIN`), and `PG_POOL_MAX=1` behaviour — the single-connection deadlock class described in the doctrine page — only reproduces under a real deployed pool, not a local one with its own connections. A local dev server is fine for UI iteration, but a claim that a money path is verified has to be backed by a preview run.

## What a run leaves behind

Verification writes to the same Supabase project that serves production, because there is exactly one project and no branches, and that is a deliberate decision rather than an oversight. A run therefore leaves real rows behind: a `Payment`, the `LedgerTransaction` and `LedgerEntry` pair it posts, a `ConsultantEarnings` accrual, any tax invoice or credit note the flow mints, and a `WebhookEvent` inbox row for every replayed delivery. Razorpay TEST MODE isolates the gateway balance, not this application's tables, so none of those rows are prevented by using test keys.

This is acceptable before launch because the dataset is mock throughout — every seeded user and every existing `Recording` row is faker data, nothing has been sold, and a full reset precedes launch, which is also why no backfill migration is ever written for it. It stops being acceptable the moment real customers exist.

Four disciplines keep the residue harmless in the meantime. Record every identifier a run creates in the verification report, so a later reader can tell a test row from a real one without guessing. Use recognisable fixture names for the users and organisations a run needs, rather than names that read like genuine customers. Never delete a ledger row to tidy up, because the ledger is append-only and deleting an entry silently drifts every snapshot and balance derived from it — post a compensating reversal if a run must be undone. When a cached aggregate disagrees with the journal after a run, repair the cache to the journal's value and never the reverse, since the journal is the truth and the cache is a derivation of it.

The escalation, once the platform has real customers, is a dedicated Supabase project or a database branch for verification, at which point this page's premise changes and the recipe should be rewritten against it.

## Gateway mode

Verification uses Razorpay **TEST MODE** keys (`rzp_test_...`), never live keys. Test-mode payments, refunds, and payouts are entirely separate from live-mode data and are invisible to each other in the Razorpay dashboard, so a test-mode run cannot contaminate a real balance and a live key accidentally used in a preview cannot be mistaken for a successful test.

## Replaying a webhook

The platform learns that money moved through `POST /api/webhooks/razorpay`, and proving a handler change means posting a correctly signed event to that route rather than calling the handler function directly, because the signature check, the idempotency check, and the routing decision are all part of what is being verified.

- **Signature.** Razorpay signs the exact bytes of the request body with HMAC-SHA256 keyed on `RAZORPAY_WEBHOOK_SECRET`. The signature must be computed from the identical byte string that is posted; a payload that is re-serialised between signing and sending (different key order, different whitespace) produces a signature that fails verification even though the JSON is logically the same.
- **Event id.** Every replay needs a unique `x-razorpay-event-id` header. Razorpay's own de-duplication and this platform's `WebhookEvent` inbox both key on that id, so reusing an id from an earlier test is indistinguishable from Razorpay retrying a delivery and will be silently absorbed rather than processed again.
- **Notes.** The `notes` object on the payload should carry the same shape `buildPaymentMetadata` produces at checkout (`appointmentId`, `appointmentType`, `userId`, `organizationId` and `fundingSource` when the booking is org-sponsored, and so on), because Razorpay copies the order's notes onto the payment entity, and the dispatcher in `app/api/webhooks/razorpay-dispatch.ts` reads those notes to choose between `handlePaymentSuccess`, `handleOrgPaymentSuccess`, and `handleOverageMemberSuccess`. A replay with notes that do not match a real checkout's shape will route to the wrong handler or fail validation in a way a real event never would.
- **Local tunnelling.** `.claude/skills/finance/references/razorpay/references/local-testing.md` has the ngrok recipe for registering a webhook against a tunnel when a preview URL is not yet available.

## The `/api/dev/mock-webhook` shortcut

For flows that do not need a real signature — exercising `handlePaymentSuccess`, `refundEarnings`, or `handlePayoutWebhook` directly — `app/api/dev/mock-webhook/route.ts` simulates `payment.captured`, `order.paid`, `refund.created`, `payout.processed`, and `payout.rejected` without a gateway round trip. It only works in a development environment and is the right tool when the thing under test is the confirmation pipeline itself rather than the webhook route's signature or dispatch logic.

## Driving the sweeps

Every scheduled job has an HTTP twin under `app/api/cleanup/*`, gated by a `CRON_SECRET` bearer token and wrapped in `withCronLock`. Calling a cleanup route directly with the secret is how a sweep is exercised on demand instead of waiting for the Netlify ticker or a GitHub Actions run. Routes invoked by the ticker accept an optional `?limit=` — a positive integer, refused with `400 INVALID_LIMIT` if unparseable and clamped at a per-route cap (500) if it overshoots — so a verification run can take a small, fast bite of a backlog instead of the unbounded default a nightly run would process.

## Verifying by SQL, not by narration

After every mutation, check the actual rows through the Supabase MCP tools against project `pzmbxqdgibfkhjwzeprf` (the one Supabase project that serves both dev and prod — every mutating script here is a production operation). The checklist after any money scenario:

- **Legs.** Every `PaymentLeg` on the payment sums correctly per the identity in the doctrine page, and any reversal leg is negative and does not exceed its original sibling.
- **Ledger.** The `LedgerTransaction` for the event has balanced `LedgerEntry` rows, and its `idempotencyKey` matches the expected shape (`booking:<paymentId>`, `orgpayout:<payoutId>`, and so on) so a second run of the same scenario would not double-post.
- **Earnings.** `ConsultantEarnings` or `OrganizationEarnings` rows reflect the split the `RateCard` implies, and their status (`READY`, `BATCHED`, `PAID`) matches where the payout pipeline should have left them.
- **Invoices and credit notes.** A `ConsumerInvoice` was minted for a personal, non-org-funded payment, or an `OrganizationInvoice` line for an org-funded one; a refund produced the matching `ConsumerCreditNote` or `CreditNote` at the correct proportional split.
- **Reconciler.** Run `scripts/reconcile/reconcile-ledgers.ts` (or the relevant single-purpose reconciler) and confirm zero active discrepancies for the scenario just exercised; a fresh finding here means the scenario surfaced a real drift, not that the reconciler is being noisy.

## Agents over-report; verify their claims against code

A subagent's summary of what it did is not evidence that it did it. Before accepting a report that a money path is verified, re-derive the claim from the actual diff and the actual rows: read the code that changed, not the prose describing the change, and read the database rows the scenario should have produced, not a paraphrase of them. This has caught real gaps before — a report of "leg sums balance" that turned out to be true only because the scenario never exercised the referral-credit branch, for one.

## Sources

`docs/payments/06-high-level-design.md`, `docs/maintenance/04-cron-jobs-reference.md`, `docs/payments/gateways/razorpay/05-go-live-checklist.md`, `.claude/skills/finance/references/razorpay/references/local-testing.md`, `app/api/dev/mock-webhook/route.ts`, `lib/payments/operations/checkout.ts` (`buildPaymentMetadata`), `__tests__/payments/*webhook*`.
