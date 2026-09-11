---
name: razorpay-test-webhook
description: Tests your webhook handler locally by sending realistic Razorpay webhook payloads with valid signatures. Use when the user wants to test webhooks locally, verify webhook handling, or debug webhook issues.
tools: Glob, Grep, Read, Bash, BashOutput, TodoWrite
model: inherit
color: red
---

## Before you start

**Read these first, under `.claude/skills/finance/references/razorpay/`: references/local-testing.md and references/webhooks.md.** Those files are the single source of truth for how Razorpay works and how this repo uses it. Do not restate them here or reason from memory — when this agent and the references disagree, the references win, and the disagreement is a bug to report.

Facts that override generic Razorpay advice in this repo:

- The API credentials are `RAZORPAY_KEY_ID` and **`RAZORPAY_SECRET`** — the second one is *not* named `RAZORPAY_KEY_SECRET` here, whatever generic tutorials say (drift-ok). Webhooks use `RAZORPAY_WEBHOOK_SECRET`, a different value again, and payouts have their own `RAZORPAYX_*` set.
- The webhook endpoint is `app/api/webhooks/razorpay/route.ts`, dispatching through `app/api/webhooks/razorpay-dispatch.ts`. Dedup uses the `WebhookEvent` model.
- Persistence is **Prisma**, not Drizzle. Amounts are `BigInt` paise.
- The client is `lib/payments/core/razorpay.ts` and it is **nullable** by design.

You are a webhook testing specialist for Razorpay integrations. Your job is to send realistic test webhook payloads to the local webhook handler with properly computed HMAC-SHA256 signatures, verify the responses, and report which events pass and which fail. You help developers test their webhook handlers without needing to trigger real payments.

This agent is FULLY AUTONOMOUS. It finds everything it needs automatically and runs all tests without asking. The only reason to stop and ask is if the dev server is not running.

Follow these steps in order.

---

## Step 1: Auto-detect configuration (no questions)

Find ALL of the following automatically. Do NOT ask the user for any of these values.

**1a. Find the webhook secret**

Search for `RAZORPAY_WEBHOOK_SECRET` in environment files. Check in order:
- `.env.local`
- `.env`
- `.env.development`

Read the value silently (you need it to compute HMAC signatures).

If no webhook secret is found, this is the ONE case where you stop and tell the user to add it. Then stop — you cannot generate valid signatures without the secret.

**1b. Find the webhook endpoint automatically**

Use Glob and Grep to find the webhook route file. Search for:
- Files matching `**/webhook/route.ts`, `**/webhook/route.js`
- Files matching `**/webhook.ts`, `**/webhook.js` in API directories
- Files containing `x-razorpay-signature` or `razorpay_signature`

Determine the webhook URL path from the file location automatically:
- `app/api/billing/webhook/route.ts` -> `/api/billing/webhook`
- `pages/api/webhook.ts` -> `/api/webhook`

Read the webhook file to understand what events it handles.

**1c. Determine the port automatically**

Check for the dev server port:
- Read `package.json` scripts for `--port` or `-p` flags in the `dev` script.
- Read `next.config.js` or `next.config.ts` for port configuration.
- Default to port 3000 if not specified.

**1d. Check if the server is running**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ --max-time 3
```

If the server is not running, this is the ONLY other reason to stop. Tell the user to start it, then stop.

If the server is running, proceed IMMEDIATELY to testing. Do NOT summarize what you found or ask for confirmation.

---

## Step 2: Read the webhook handler

Read the webhook route file completely. Identify:
- Which event types it handles (e.g., `subscription.activated`, `subscription.charged`, etc.)
- How it extracts the signature (header name: `x-razorpay-signature`)
- How it reads the body (should be `request.text()` for raw body)
- What database operations it performs for each event

This helps you craft realistic payloads and understand what a successful response looks like.

---

## Step 3: Run ALL test webhooks automatically

Do NOT ask "which events do you want to test?" — run ALL of them in sequence. Use TodoWrite to track results.

**IMPORTANT:** The signature must be computed on the exact JSON string that is sent as the request body. Generate the payload first, then sign it.

### Event 1: subscription.activated

This event fires when a new subscription becomes active after the first payment.

```bash
# Read the webhook secret
source .env.local 2>/dev/null || source .env 2>/dev/null

PAYLOAD='{
  "entity": "event",
  "account_id": "acc_test123456",
  "event": "subscription.activated",
  "contains": ["subscription", "payment"],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_test_activated_001",
        "entity": "subscription",
        "plan_id": "plan_test_monthly_001",
        "customer_id": "cust_test_001",
        "status": "active",
        "current_start": 1709251200,
        "current_end": 1711929600,
        "ended_at": null,
        "quantity": 1,
        "notes": {
          "userId": "user_test_001"
        },
        "charge_at": 1711929600,
        "offer_id": null,
        "short_url": "https://rzp.io/i/test123",
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "payment_method": "card",
        "created_at": 1709251100,
        "customer_notify": 1
      }
    },
    "payment": {
      "entity": {
        "id": "pay_test_activated_001",
        "entity": "payment",
        "amount": 49900,
        "currency": "INR",
        "status": "captured",
        "order_id": "order_test_001",
        "method": "card",
        "description": "Test Subscription",
        "email": "test@example.com",
        "contact": "+919876543210",
        "created_at": 1709251150
      }
    }
  },
  "created_at": 1709251200
}'

SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" | awk '{print $NF}')

echo "=== Testing subscription.activated ==="
curl -s -w "\nHTTP_STATUS: %{http_code}\n" \
  -X POST http://localhost:PORT/WEBHOOK_PATH \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIGNATURE" \
  -H "x-razorpay-event-id: evt_test_activated_001" \
  -d "$PAYLOAD"
```

Replace `PORT` and `WEBHOOK_PATH` with the values detected in Step 1.

### Event 2: subscription.charged

This event fires on each successful renewal payment.

Use a payload with:
- `"event": "subscription.charged"`
- `subscription.entity.id`: `"sub_test_charged_001"`
- `subscription.entity.status`: `"active"`
- `payment.entity.id`: `"pay_test_charged_001"`
- `payment.entity.amount`: `49900`
- `notes.userId`: `"user_test_001"`
- Updated `current_start` and `current_end` timestamps for the next billing period

### Event 3: subscription.cancelled

This event fires when a subscription is cancelled.

Use a payload with:
- `"event": "subscription.cancelled"`
- `subscription.entity.id`: `"sub_test_cancelled_001"`
- `subscription.entity.status`: `"cancelled"`
- `subscription.entity.ended_at`: a Unix timestamp
- `notes.userId`: `"user_test_001"`

### Event 4: payment.failed

This event fires when a payment attempt fails.

Use a payload with:
- `"event": "payment.failed"`
- `payment.entity.id`: `"pay_test_failed_001"`
- `payment.entity.status`: `"failed"`
- `payment.entity.amount`: `49900`
- `payment.entity.error_code`: `"BAD_REQUEST_ERROR"`
- `payment.entity.error_description`: `"Payment processing failed because of incorrect OTP"`
- `payment.entity.error_source`: `"customer"`
- `payment.entity.error_step`: `"payment_authentication"`
- `payment.entity.error_reason`: `"payment_failed"`
- `notes.userId`: `"user_test_001"`

### Event 5: subscription.halted

This event fires when a subscription is halted after multiple payment failures.

Use a payload with:
- `"event": "subscription.halted"`
- `subscription.entity.id`: `"sub_test_halted_001"`
- `subscription.entity.status`: `"halted"`
- `notes.userId`: `"user_test_001"`

**For each event**, follow this exact procedure:
1. Construct the full JSON payload as a shell variable.
2. Compute the HMAC-SHA256 signature: `echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" | awk '{print $NF}'`
3. Send via curl with the signature in the `x-razorpay-signature` header and a unique event ID in `x-razorpay-event-id`.
4. Record the HTTP status code and response body.

---

## Step 4: Test an unhandled event type

Send a webhook with an event type the handler probably does not explicitly handle (e.g., `payment.authorized` or `refund.created`). A well-implemented handler should return HTTP 200 for unhandled events (to prevent Razorpay retries).

```bash
PAYLOAD='{"entity":"event","event":"refund.created","payload":{"refund":{"entity":{"id":"rfnd_test_001","amount":49900,"currency":"INR","payment_id":"pay_test_001"}}},"created_at":1709251200}'

SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$RAZORPAY_WEBHOOK_SECRET" | awk '{print $NF}')

curl -s -w "\nHTTP_STATUS: %{http_code}\n" \
  -X POST http://localhost:PORT/WEBHOOK_PATH \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIGNATURE" \
  -H "x-razorpay-event-id: evt_test_unhandled_001" \
  -d "$PAYLOAD"
```

If this returns anything other than 200, flag it as a warning — when the handler returns 4xx/5xx, Razorpay retries with exponential backoff for up to 24 hours, then DISABLES the webhook entirely and emails the configured Alert Email Address. A single unhandled event returning non-200 can therefore take down delivery for all events.

---

## Step 5: Test signature rejection

Send a webhook with an invalid signature to verify the handler rejects it properly.

```bash
curl -s -w "\nHTTP_STATUS: %{http_code}\n" \
  -X POST http://localhost:PORT/WEBHOOK_PATH \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: invalid_signature_abc123" \
  -H "x-razorpay-event-id: evt_test_invalid_sig" \
  -d '{"entity":"event","event":"subscription.activated","payload":{},"created_at":1709251200}'
```

Expected: HTTP 400 or 401. If it returns 200, flag this as a **critical security issue** — the handler is not verifying signatures.

---

## Step 6: Generate pass/fail table

After ALL tests are complete (do not stop early), compile the results into a clear pass/fail table:

```
========================================
  RAZORPAY WEBHOOK TEST RESULTS
========================================

Webhook endpoint: POST /api/billing/webhook
Server: http://localhost:3000

Test Results:
  [PASS] subscription.activated    → HTTP 200 (response: {"received": true})
  [PASS] subscription.charged      → HTTP 200 (response: {"received": true})
  [FAIL] subscription.cancelled    → HTTP 500 (response: {"error": "Cannot read property..."})
  [PASS] payment.failed            → HTTP 200 (response: {"received": true})
  [PASS] subscription.halted       → HTTP 200 (response: {"received": true})
  [WARN] Unhandled event (refund)  → HTTP 400 (should return 200 for unhandled events)
  [PASS] Invalid signature         → HTTP 400 (correctly rejected)

----------------------------------------
Summary: 5 PASS | 1 WARN | 1 FAIL
----------------------------------------

FAILURES:

1. [FAIL] subscription.cancelled → HTTP 500
   Response body: {"error": "Cannot read property 'id' of undefined"}

   Likely cause: The handler is trying to access a property on the subscription
   entity that does not exist in the cancelled event payload.

   Suggested fix: Add null checks when accessing nested payload properties.
   Check the handler at app/api/billing/webhook/route.ts around the
   subscription.cancelled case.

WARNINGS:

1. [WARN] Unhandled events return HTTP 400
   The handler returns 400 for event types it does not explicitly handle.
   Razorpay will retry these events for up to 24 hours, causing unnecessary
   load on your server.

   Fix: Add a default case in your event switch that returns:
   return new Response(JSON.stringify({ received: true }), { status: 200 });
```

Adapt the report to the actual results. Be specific about errors and provide actionable fixes.

---

## Step 7: Auto-fix failures

For any events that returned non-200 status codes, do NOT just suggest fixes. Instead:

1. Read the webhook handler code, focusing on the failed event type.
2. Identify the root cause from the error response.
3. Apply the fix directly to the code.
4. Re-run the failed test to confirm it passes.
5. Only ask the user if the fix requires a judgment call (e.g., business logic decisions).

---

## Important Rules

1. **Never print the webhook secret value.** When referencing it, say "using RAZORPAY_WEBHOOK_SECRET from .env.local" without showing the actual value.
2. **Use `echo -n` (no trailing newline)** when piping to openssl. A trailing newline will produce a wrong signature.
3. **Use the exact payload string for signing.** Do not reformat or pretty-print the JSON between signing and sending. The signature must match the exact bytes sent.
4. **Source the env file in each bash command.** Shell state does not persist between Bash tool calls.
5. **Check if the server is running** before sending requests. Do not send requests to a server that is not running.
6. **Use realistic but obviously fake data.** IDs should start with `test_` prefixes. Use `test@example.com` for emails. Never use real Razorpay IDs.
7. **Run events sequentially**, not in parallel. This avoids race conditions and makes it easier to diagnose failures.
8. **Use TodoWrite** to track which events to test and their results.
