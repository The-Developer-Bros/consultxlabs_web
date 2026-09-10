# Razorpay Admin Operations

Run these commands directly to query and manage your Razorpay account. All commands use the Razorpay REST API with basic auth.

**Before running**: Ensure `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` are set in your environment or `.env.local`. If not, ask the user for their key ID and secret.

```bash
# Load env vars if using .env.local
export RAZORPAY_KEY_ID=$(grep RAZORPAY_KEY_ID .env.local | head -1 | cut -d'=' -f2)
export RAZORPAY_SECRET=$(grep RAZORPAY_SECRET .env.local | head -1 | cut -d'=' -f2)
```

## Authentication

All API calls use HTTP Basic Auth: `-u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET`

Test keys (`rzp_test_`) only access test data. Live keys (`rzp_live_`) only access live data.

---

## Payments

### Fetch a specific payment
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/payments/pay_xxxxx | jq .
```

Key fields: `id`, `amount` (paise), `status` (`created|authorized|captured|refunded|failed`), `method`, `email`, `subscription_id`, `order_id`, `created_at`

### List recent payments
```bash
# Last 10 payments
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/payments?count=10" | jq '.items[] | {id, amount, status, method, email, created_at}'
```

### List payments by subscription
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/subscriptions/sub_xxxxx/payments" | jq '.items[] | {id, amount, status, method, created_at}'
```

### Filter payments by status
```bash
# Failed payments only
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/payments?count=20" | jq '.items[] | select(.status == "failed") | {id, amount, error_code, error_description}'
```

---

## Subscriptions

### Fetch a specific subscription
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/subscriptions/sub_xxxxx | jq .
```

Key fields: `id`, `plan_id`, `status` (`created|authenticated|active|pending|halted|cancelled|completed|expired|paused`), `current_start`, `current_end`, `total_count`, `paid_count`, `remaining_count`, `short_url`, `notes`

### List all subscriptions
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/subscriptions?count=20" | jq '.items[] | {id, plan_id, status, paid_count, current_end}'
```

### Filter subscriptions by status
```bash
# Active subscriptions only
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/subscriptions?count=50" | jq '.items[] | select(.status == "active") | {id, plan_id, customer_id, current_end}'
```

### Cancel a subscription
```bash
# Cancel at cycle end (graceful — recommended)
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/subscriptions/sub_xxxxx/cancel \
  -H "Content-Type: application/json" \
  -d '{"cancel_at_cycle_end": 1}' | jq .

# Cancel immediately
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/subscriptions/sub_xxxxx/cancel \
  -H "Content-Type: application/json" \
  -d '{"cancel_at_cycle_end": 0}' | jq .
```

### Pause a subscription
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/subscriptions/sub_xxxxx/pause \
  -H "Content-Type: application/json" \
  -d '{"pause_initiated_by": "customer"}' | jq .
```

### Resume a paused subscription
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/subscriptions/sub_xxxxx/resume \
  -H "Content-Type: application/json" \
  -d '{"resume_initiated_by": "customer"}' | jq .
```

---

## Invoices

### Fetch a specific invoice
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/invoices/inv_xxxxx | jq .
```

### List recent invoices
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/invoices?count=10" | jq '.items[] | {id, subscription_id, payment_id, status, amount, issued_at}'
```

### List invoices for a subscription
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/invoices?subscription_id=sub_xxxxx" | jq '.items[] | {id, payment_id, status, amount}'
```

---

## Refunds

### Fetch a specific refund
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/refunds/rfnd_xxxxx | jq .
```

Key fields: `id`, `payment_id`, `amount` (paise), `status` (`pending|processed|failed`), `speed_requested` (`normal|optimum`), `speed_processed` (`normal|instant`), `created_at`

### List refunds for a payment
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/payments/pay_xxxxx/refunds" | jq '.items[] | {id, amount, status, speed_requested, speed_processed, created_at}'
```

### Issue a full refund
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/payments/pay_xxxxx/refund \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

### Issue a partial refund
```bash
# Amount in paise (e.g., 50000 = Rs 500)
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/payments/pay_xxxxx/refund \
  -H "Content-Type: application/json" \
  -d '{"amount": 50000}' | jq .
```

---

## Customers

### Fetch a customer
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/customers/cust_xxxxx | jq .
```

### Search customers by email
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/customers?count=10" | jq '.items[] | select(.email == "user@example.com")'
```

---

## Plans

### List all plans
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/plans?count=20" | jq '.items[] | {id, period, interval, item: .item.name, amount: .item.amount}'
```

### Fetch a specific plan
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/plans/plan_xxxxx | jq .
```

### Create a new plan
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  -X POST https://api.razorpay.com/v1/plans \
  -H "Content-Type: application/json" \
  -d '{
    "period": "monthly",
    "interval": 1,
    "item": {
      "name": "Plan Name",
      "amount": 99900,
      "currency": "INR",
      "description": "Plan description"
    }
  }' | jq .
```

---

## Orders

### Fetch an order
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/orders/order_xxxxx | jq .
```

### List payments for an order
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/orders/order_xxxxx/payments" | jq '.items[] | {id, amount, status, method}'
```

---

## Settlements

Settlements are the actual money transfers from Razorpay to your bank account, net of fees, tax, and adjustments. Default cycle is **T+2 working days** for domestic accounts and **T+7** for international; instant settlements are also available at an extra fee.

### List recent settlements
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/settlements?count=10" | jq '.items[] | {id, amount, status, fees, tax, created_at}'
```

### Fetch a specific settlement
```bash
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/settlements/setl_xxxxx | jq .
```

### Settlement reconciliation (per-day / per-month breakdown)
```bash
# Recon report for a settlement — itemizes every payment, refund, fee, and adjustment
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/settlements/recon/combined?year=2026&month=6&count=100" \
  | jq '.items[] | {entity_id, type, amount, fee, tax, settled_at}'
```

Use the recon API for accurate net-revenue figures — it nets fees, tax, and adjustments per settlement, which is more reliable than summing captured payments.

---

## Webhooks (via Dashboard API)

### Check recent webhook deliveries
```bash
# No direct API for this — use Dashboard: Settings → Webhooks → Click webhook → View deliveries
# But you can verify your endpoint is reachable:
curl -X POST https://your-app.com/api/webhooks/razorpay \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
# Should return 400 (missing signature), NOT 404 or 500
```

---

## Quick Health Check

Run all of these to verify your Razorpay setup is working:

```bash
# 1. Verify credentials
echo "--- Credentials ---"
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  https://api.razorpay.com/v1/plans?count=1 | jq '{ok: (.count != null), mode: (if (.items[0].id // "" | startswith("plan_live")) then "LIVE" else "TEST" end)}'

# 2. Count active subscriptions
echo "--- Active Subscriptions ---"
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/subscriptions?count=50" | jq '[.items[] | select(.status == "active")] | length'

# 3. Recent payments
echo "--- Last 5 Payments ---"
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/payments?count=5" | jq '.items[] | {id, amount, status, created_at}'

# 4. Recent refunds
echo "--- Last 5 Refunds ---"
curl -s -u $RAZORPAY_KEY_ID:$RAZORPAY_SECRET \
  "https://api.razorpay.com/v1/refunds?count=5" | jq '.items[] | {id, payment_id, amount, status}'
```

## Gotchas

1. **Test vs live isolation**: Test keys can't see live data. Double-check which mode you're in.
2. **`jq` required**: All commands pipe to `jq` for readability. Install with `brew install jq` if missing.
3. **Amounts are in paise**: Rs 999 = `99900` paise. Always divide by 100 for display.
4. **Timestamps are Unix seconds**: Convert with `date -r <timestamp>` on macOS or use `jq 'to_date'`.
5. **Rate limits**: Razorpay has undocumented rate limits. Don't script tight loops against the API.
6. **Pagination**: Default `count` is 10, max is 100. Use `skip` parameter for pagination: `?count=100&skip=100`.
7. **Refund on subscription payment**: Refunding does NOT cancel the subscription. Cancel separately if needed.
8. **Cancel is irreversible**: Once cancelled, a subscription cannot be reactivated. Create a new one instead.
