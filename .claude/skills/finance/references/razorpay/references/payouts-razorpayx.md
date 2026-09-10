# RazorpayX payouts

Payouts move money *out* — to consultants and to organisations. They are a different
product from Razorpay Payments, with separate credentials, a separate webhook secret, and
a separate client in this repo.

## The client is hand-rolled, on purpose

`lib/payments/payouts/razorpay-payouts.ts` is a `fetch` client against
`https://api.razorpay.com/v1`, **not** the npm SDK. Do not "modernise" it onto the SDK:
the SDK cannot send `X-Payout-Idempotency` (its header whitelist is `X-Razorpay-Account`
and `Content-Type` only), and that header has been **mandatory for all payout requests
since 15 March 2025**.

Credentials are `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER` and
`RAZORPAYX_WEBHOOK_SECRET`, each falling back to the matching `RAZORPAY_*` var when unset.

Live payouts are gated behind `ENABLE_LIVE_PAYOUTS`. Check it before assuming a payout
path is reachable in an environment.

## Endpoints used

`/contacts` (create, fetch, update) → `/fund_accounts` (+ `/fund_accounts/validations` for
penny-drop verification) → `/payouts` (create, fetch, cancel, list), plus
`/accounts/{account_number}` for the balance preflight.

`createPayout()` sends `account_number`, `fund_account_id`, `amount`, `currency`, `mode`,
`purpose`, `queue_if_low_balance` (default `true`), `reference_id`, `narration` and
`notes`. The idempotency key is deterministic — `payout_${payoutId}` from
`generateIdempotencyKey()` — so a retry of the same payout row can never double-pay.

`determinePayoutMode()` picks the rail: a VPA goes UPI, otherwise IMPS/NEFT/RTGS by amount.

## Webhook routing

Payout events (`payout.processed`, `.reversed`, `.rejected`, `.failed`, `.queued`,
`.pending`, `.cancelled`) arrive at the **same** endpoint as payments,
`/api/webhooks/razorpay`, and are handled by `handleRazorpayPayoutWebhook`.

They are signed with a *different* secret, so `app/api/webhooks/razorpay/route.ts` has a
dual-secret fallback: verify against `RAZORPAY_WEBHOOK_SECRET` first, and only if that
fails **and** the parsed event name starts with `payout.` retry against
`RAZORPAYX_WEBHOOK_SECRET`. The ordering matters — a non-payout event can never be
accepted by the X secret, which is what stops the fallback from widening the trust
boundary.

`RazorpayXClient.verifyWebhookSignature` also exists on the client class but is not what
the route uses. If you ever wire it up, keep its length guard: `timingSafeEqual` throws
rather than returning false when the buffers differ in length.

## Money-side fields

`OrganizationPayout` carries the compliance surface — `gatewayPayoutId`, `gatewayUtr`,
`tdsSectionApplied`, `mustPayByDate` (MSME), `rbiPurposeCode`, `firceRef`. The consultant
side runs `ConsultantEarnings` → `ConsultantPayout` → `PayoutAccount`.

Reconciliation crons live in `jobs/payouts/` and `scripts/payouts/`; TDS reversal and
stuck-payout handling have their own tests under `__tests__/payments/`.

## Settlements are not this

Razorpay's Settlements API — money moving from Razorpay to our bank account — is **not
used anywhere**. Every "settlement" identifier in this codebase refers to internal
overage/ledger settlement. Don't conflate them.
