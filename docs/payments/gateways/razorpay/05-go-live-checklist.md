# Razorpay Go-Live Checklist

> What has to be true before the platform accepts its first rupee of real money through Razorpay, and what has to be verified in the Razorpay dashboard rather than in this repository.

**Last Updated**: 2026-09-05 · **Tracking issue**: #1377

---

## How to read this page

This checklist covers the payments product only. Consultant and organisation disbursement through RazorpayX is gated separately by `ENABLE_LIVE_PAYOUTS` and has its own runbook at [docs/enterprise/50-operations/06-live-payout-go-live-runbook.md](../../../enterprise/50-operations/06-live-payout-go-live-runbook.md); do not treat the two as one cutover, because accepting money and disbursing money can safely go live weeks apart.

Several items below cannot be verified from the codebase at all. Auto-capture, the settlement cycle and the uncaptured-payment refund window are account settings that live in the Razorpay dashboard, and no amount of reading `lib/payments/core/razorpay.ts` will tell you how they are configured. Those items are marked as dashboard checks, and they need a screenshot or a dashboard link recorded against the issue rather than a code reference.

---

## 1. Account activation

The account has to be activated before live keys do anything at all, and activation is not instantaneous.

- [ ] KYC is submitted and approved, and the dashboard shows the account as activated. Razorpay quotes one to three business days for this, and a rejection restarts the clock.
- [ ] The settlement bank account on the Razorpay account is the platform's current account, and the account holder name matches the registered business name exactly.
- [ ] GSTIN is recorded on the Razorpay account. This is what lets Razorpay issue us a compliant invoice for its own fees, which we need for input tax credit; it is unrelated to the tax invoices this platform issues to consumers, which are minted in-house (see [../../07-b2c-tax-invoice.md](../../07-b2c-tax-invoice.md)).
- [ ] If international cards are ever to be accepted, domestic acceptance is activated first and video KYC is complete. International acceptance is a separate approval, not a toggle.

---

## 2. Keys and the test-key guard

The platform holds two unrelated Razorpay credential pairs and one webhook secret per mode, and confusing any two of them is the most common cause of a silent outage.

- [ ] `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` hold the **live** key pair, with `rzp_live_` as the key id prefix. Note that the secret's variable name is `RAZORPAY_SECRET` in this repository and not `RAZORPAY_KEY_SECRET`; only the legacy readers under `scripts/` accept the second name.
- [ ] `NEXT_PUBLIC_RAZORPAY_KEY_ID` holds the same live key **id**. It is the only Razorpay value that may ever be public, and neither secret may ever be given a `NEXT_PUBLIC_` prefix.
- [ ] `RAZORPAY_ALLOW_TEST_KEYS_IN_PRODUCTION` has been **deleted** from the production environment. While it is set to `true`, a test key under `NODE_ENV=production` only logs a loud error instead of throwing, which is deliberate for the pre-launch period when signup is closed and checkout is exercised with test cards. Once live keys are in place the variable has no legitimate use, and leaving it behind removes the guard that would otherwise catch a future accidental rollback to test keys.
- [ ] A production boot has been observed after the change. The test-key guard in `lib/payments/core/razorpay.ts` runs at module load, so a misconfigured production posture fails at require time rather than at the first customer — which means the deploy either comes up clean or does not come up at all.

---

## 3. Webhooks

Webhook delivery is how the platform learns that money moved. Everything else is best effort.

- [ ] A webhook is registered in **live** mode pointing at `https://<production-host>/api/webhooks/razorpay` over HTTPS on port 443.
- [ ] `RAZORPAY_WEBHOOK_SECRET` in the production environment holds the **live** webhook secret, which is a third value distinct from both the API secret and the test-mode webhook secret. A test-mode secret in production rejects every live delivery with a 400.
- [ ] The selected events are exactly the ones the dispatcher handles: `payment.captured`, `order.paid`, `payment.failed`, `refund.created`, `refund.processed`, `refund.failed`, `refund.speed_changed`, the six `payment.dispute.*` events, and the seven `payout.*` events. Selecting an event the dispatcher does not handle is harmless because unknown events are logged and acknowledged with a 200, but omitting a handled one loses the state transition entirely.
- [ ] The Alert Email Address on the webhook is a monitored inbox. Razorpay emails it when it disables a webhook, and that email is the only notification of the failure mode described below.
- [ ] A signed test delivery has reached production and produced a `WebhookEvent` row. The recipe lives in the Razorpay skill at `.claude/skills/finance/references/razorpay/references/local-testing.md`; the signature is an HMAC-SHA256 of the exact bytes posted, so it must be generated from the same string that is sent.

### Why a non-2xx is dangerous here

Razorpay treats every non-2xx response as a delivery failure, retries on an exponential backoff for 24 hours, and then **disables the webhook** ([webhook FAQs](https://razorpay.com/docs/webhooks/faqs/)). A disabled webhook is not merely paused: events that fire while it is disabled are never delivered, and Razorpay has no self-serve replay. Recovering them means a support ticket, only works for events under 15 days old, and only works if the webhook was enabled when the event fired. This is why the route returns 200 for events it does not handle and reserves 503 for the single case where a retry is genuinely wanted, namely an unreachable database.

### Rotating the webhook secret

Rotating `RAZORPAY_WEBHOOK_SECRET` is a two-sided change that cannot be made atomically, because the operator saves the new secret in the Razorpay dashboard and the platform picks it up only on the next deploy. Every event signed in that gap would be rejected, and a long enough gap ends in the disabled webhook described above.

`RAZORPAY_WEBHOOK_SECRET_PREVIOUS` exists to close that window, mirroring for inbound deliveries what [ADR 09](../../../enterprise/70-design-decisions/09-webhook-rotation-grace.md) does for outbound ones. The procedure is:

1. Set `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` to the current secret and deploy. Nothing changes yet, because the current secret still verifies everything.
2. Generate the new secret in the Razorpay dashboard, set `RAZORPAY_WEBHOOK_SECRET` to it, and deploy. Deliveries signed with either secret now verify.
3. Watch the operations timeline. Every delivery that only the previous secret can verify writes a `WEBHOOK`/`WARN` system event naming the variable, so the rotation is visibly finished when those stop.
4. Delete `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` and deploy. The old secret stops being honoured.

Leaving the variable set indefinitely defeats the purpose of rotating a leaked secret, which is why step 4 is part of the procedure rather than optional cleanup.

### RazorpayX payout deliveries

RazorpayX payout events arrive at the same endpoint but are signed with `RAZORPAYX_WEBHOOK_SECRET`, a different value again. The route verifies against the payment-side secrets first and only consults the RazorpayX secret when that fails **and** the event name begins with `payout.`. That ordering is the safety property rather than an optimisation: because a non-payout event can never be accepted by the RazorpayX secret, holding a second secret cannot be used to smuggle a forged `payment.captured` through.

---

## 4. Capture and settlement (dashboard checks)

- [ ] **Automatic capture is on.** Verify at Settings → Payments → payment capture. Auto-capture is on by default, but if it has been turned off, payments sit in `authorized`, `payment.captured` never fires, and no booking is ever confirmed. The `payment_capture` request field that older integrations used is deprecated and this repository correctly does not send it; per-order overrides are available through the `payment.capture` and `payment.capture_options` objects on the Orders API, and the platform deliberately does not use them so that one dashboard setting governs every order ([capture settings](https://razorpay.com/docs/payments/payments/capture-settings/)).
- [ ] **The auto-refund window for uncaptured payments is understood.** A payment left in `authorized` past the account's `manual_expiry_period` is refunded automatically, at normal speed, so the customer sees it back in five to seven working days. Read the actual configured value off the dashboard rather than trusting a remembered default, because Razorpay's own pages have quoted three days and five days in different places.
- [ ] **The settlement cycle is recorded.** The standard domestic cycle is T+2 working days from capture, where working days exclude Sundays, the second and fourth Saturdays, and bank holidays; T+7 is the international cycle rather than a new-merchant probation ([settlements](https://razorpay.com/docs/payments/settlements/)). The finance owner needs this number to reconcile the bank statement against the ledger.
- [ ] **A real ₹1 payment has been taken end to end in live mode** and has produced a Payment row at SUCCEEDED, a confirmed appointment, balanced ledger entries and a consumer tax invoice.

---

## 5. Refunds

- [ ] A live refund has been issued against that ₹1 payment and has reached SUCCEEDED via the `refund.processed` webhook rather than by anyone editing a row.
- [ ] The team understands that live refunds settle in five to seven business days at normal speed. Test-mode refunds usually appear instantly, which is not a guarantee and must never be built into a flow; the only correct trigger for "the customer has their money" is `refund.processed`.
- [ ] Nobody has introduced a `speed` parameter. This platform always requests the default `normal` speed and never `optimum`, so it never pays the instant-refund fee and `refund.speed_changed` is informational only. Changing that is a pricing decision, not an engineering one.
- [ ] Refund idempotency is intact: every refund carries `X-Refund-Idempotency` set to the `Refund` row's id, which is minted before the gateway call and unchanged on the error path. A key derived from the payment id and amount would make two legitimate partial refunds of equal value collide, and the second would silently return the first refund instead of paying the customer again.

---

## 6. Order metadata limits

Razorpay caps order `notes` at **15 key-value pairs of at most 256 characters each**, and rejects the whole order with a `BAD_REQUEST_ERROR` when either limit is exceeded ([Orders API](https://razorpay.com/docs/api/orders/create/)). The receipt field is separately capped at 40 ASCII characters and must be unique per order.

- [ ] Every producer of order notes has been counted against the 15-pair budget before any new key is added. `buildPaymentMetadata` in `lib/payments/operations/checkout.ts` already emits fifteen keys in the org-sponsored case, so it has no headroom left.
- [ ] No unbounded user-supplied string reaches `notes`. This is an open gap at the time of writing: the free-text booking note is validated as `z.string().optional()` with no maximum and is forwarded verbatim, so a note longer than 256 characters fails order creation and the customer cannot pay. It is tracked for the multi-currency and checkout PR that owns those files.

---

## 7. Operations and observability

- [ ] Sentry is receiving events from the payments subsystem, and the webhook route's signature-failure and parse-failure paths have been seen at least once in a preview environment so the alerting is known to work.
- [ ] The scheduled sweeps are running in production. Payment confirmation is durable because the `WebhookEvent` row is written before the 200 is returned, but recovery from a crashed handler depends on `sweep-stuck-webhook-events`, and recovery from an event that never arrived depends on `reconcile-payment-status`. Both are driven by the Netlify ticker every five minutes with GitHub Actions as a backstop; see [ADR 27](../../../enterprise/70-design-decisions/27-state-as-outbox-and-scheduled-ticker.md).
- [ ] No secret is logged. Payloads are scrubbed by `scrubWebhookPayload` before anything is written, and no code path prints `RAZORPAY_SECRET` or either webhook secret.
- [ ] Payment records are retained for at least eight years, as Indian tax law requires. Nothing in the money subsystem hard-deletes a Payment, Refund or invoice row, and that property must survive any future data-retention work.

---

## Related Documents

- [01-setup.md](./01-setup.md) — Account setup, keys, dashboard configuration and test credentials
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) — Payment flow and revenue split
- [03-payout-flow.md](./03-payout-flow.md) — RazorpayX payout system and status mapping
- [04-kyc-and-onboarding.md](./04-kyc-and-onboarding.md) — KYC requirements and timelines
- [docs/payments/06-high-level-design.md](../../06-high-level-design.md) — Where money truth is written and which sweep closes each gap
- [docs/enterprise/50-operations/07-required-secrets.md](../../../enterprise/50-operations/07-required-secrets.md) — The full secrets manifest and what breaks when each one is missing
