# Razorpay Setup Guide

> Setting up Razorpay for payment processing and RazorpayX for consultant payouts on Familiarise.

**Last Updated**: 2026-02-14

---

## Overview

Razorpay is our primary payment gateway for Indian customers, handling:

- Credit/Debit Cards (Visa, Mastercard, RuPay)
- UPI (Google Pay, PhonePe, Paytm)
- Net Banking (100+ banks)
- Wallets (PayZapp, Mobikwik, etc.)
- EMI options

Razorpay serves two distinct roles in our system:

| Product                 | Purpose                          |
| ----------------------- | -------------------------------- |
| **Razorpay** (Payments) | Accept payments from consultees  |
| **RazorpayX** (Payouts) | Disburse earnings to consultants |

---

## Prerequisites

| Requirement           | Details                                           |
| --------------------- | ------------------------------------------------- |
| Business Registration | Sole proprietorship, Partnership, Pvt Ltd, or LLP |
| PAN Card              | Business PAN or Individual PAN                    |
| GST Registration      | Optional but recommended (for input tax credit)   |
| Bank Account          | Current account in business name                  |
| Website/App           | Live URL for verification                         |
| Email/Phone           | For account verification                          |

---

## Account Setup

### Step 1: Create Razorpay Account

1. Sign up at `dashboard.razorpay.com/signup`
2. Enter business email and create password
3. Verify email

### Step 2: Complete Business Verification

Provide via Dashboard > Settings > Business Settings:

- Business type, name, PAN, GSTIN (if registered)
- Bank account number, IFSC code, account holder name
- Registered address and supporting document
- Authorized signatory identity proof (Aadhaar/Passport)

### Step 3: Enable RazorpayX

RazorpayX is required for consultant payouts:

1. Apply for RazorpayX via the Razorpay dashboard
2. Complete additional verification if required
3. Obtain a RazorpayX account number once approved

### Step 4: Generate API Keys

Dashboard > Settings > API Keys > Generate Key

- **Key ID**: starts with `rzp_test_` (test) or `rzp_live_` (live)
- **Key Secret**: shown only once — save immediately

---

## Environment Variables

### Payment Keys

| Variable                      | Description                 | Example                  |
| ----------------------------- | --------------------------- | ------------------------ |
| `RAZORPAY_KEY_ID`             | Server-side API key ID      | `rzp_test_xxxxxxxxxxxxx` |
| `RAZORPAY_SECRET`             | Server-side API key secret  | `xxxxxxxxxxxxxxxxx`      |
| `NEXT_PUBLIC_RAZORPAY_KEY_ID` | Client-side publishable key | `rzp_test_xxxxxxxxxxxxx` |

### RazorpayX Payout Keys

| Variable                   | Description              | Fallback                        |
| -------------------------- | ------------------------ | ------------------------------- |
| `RAZORPAYX_KEY_ID`         | RazorpayX API key ID     | Falls back to `RAZORPAY_KEY_ID` |
| `RAZORPAYX_KEY_SECRET`     | RazorpayX API key secret | Falls back to `RAZORPAY_SECRET` |
| `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX account number | Required, no fallback           |
| `RAZORPAYX_WEBHOOK_SECRET` | RazorpayX webhook secret | Optional                        |

### Test vs Live Keys

| Environment | Key Format               |
| ----------- | ------------------------ |
| Test Mode   | `rzp_test_xxxxxxxxxxxxx` |
| Live Mode   | `rzp_live_xxxxxxxxxxxxx` |

Never commit live keys to version control.

---

## Dashboard Configuration

### Webhook Setup

Dashboard > Settings > Webhooks > Add New Webhook

**URL**: `https://yoursite.com/api/webhooks/razorpay`

**Events to select**:

| Category           | Events                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment            | `payment.captured`, `order.paid`, `payment.failed`                                                                                                                    |
| Refund             | `refund.created`, `refund.processed`, `refund.failed`                                                                                                                 |
| Dispute            | `payment.dispute.created`, `payment.dispute.under_review`, `payment.dispute.action_required`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed` |
| Payout (RazorpayX) | `payout.processed`, `payout.failed`, `payout.reversed`, `payout.rejected`, `payout.queued`, `payout.pending`, `payout.cancelled`                                      |

This list is the same one the go-live checklist requires, and it is the exact set the dispatcher in `app/api/webhooks/razorpay-dispatch.ts` handles. Omitting `payout.failed` is the expensive mistake, because it is the terminal event that tells the platform a bank refused the transfer; without it the earnings stay batched against a payout that will never arrive.

Copy the webhook secret after creation and store it in the appropriate environment variable. Each mode has its own webhook secret, so the value generated in test mode will reject every live delivery and vice versa. Rotating the secret later is a two-sided change and must follow the grace-window procedure in [05-go-live-checklist.md](./05-go-live-checklist.md), because a hard cutover loses the events signed during the gap and Razorpay disables a webhook that has been failing for 24 hours.

### Test Mode vs Live Mode

Toggle via top-right corner of the Razorpay dashboard.

- **Test Mode**: Uses test API keys, no real money, webhooks still fire
- **Live Mode**: Real transactions, requires complete verification

---

## Testing

### Test Card Numbers

| Card Type            | Number                | Notes                      |
| -------------------- | --------------------- | -------------------------- |
| Mastercard (Success) | `5267 3181 8797 5449` | Any CVV, any future expiry |
| Visa (Success)       | `4111 1111 1111 1111` | Any CVV, any future expiry |
| RuPay (Success)      | `6076 6506 0000 0083` | Any CVV, any future expiry |
| Card (Failure)       | `4000 0000 0000 0002` | Any CVV, any future expiry |

### Test UPI IDs

| Scenario | UPI ID             |
| -------- | ------------------ |
| Success  | `success@razorpay` |
| Failure  | `failure@razorpay` |

### Test Net Banking

In test mode, any bank selection shows a simulation page where you can choose success or failure.

### Local Webhook Testing

Use ngrok or similar to expose your local server:

```
ngrok http 3000
```

Set the ngrok URL as your webhook endpoint in the Razorpay dashboard.

---

## Common Issues & Troubleshooting

### "Invalid API Key"

- Verify test/live key matches the dashboard mode
- Check key is copied correctly (no whitespace)
- Verify key hasn't been regenerated

### "Webhook signature verification failed"

- Use raw request body (not parsed JSON) for verification
- Verify webhook secret matches the dashboard
- Check for middleware modifying the request body

### "RazorpayX not configured"

- Ensure `RAZORPAYX_ACCOUNT_NUMBER` is set
- Verify RazorpayX is approved and active on your account
- Check that `RAZORPAYX_KEY_ID` and `RAZORPAYX_KEY_SECRET` are set (or fallback keys exist)

---

## Security Best Practices

- Store all API keys in environment variables, never in code
- Verify webhook signatures on every incoming webhook
- Use HTTPS for all endpoints
- Implement idempotency keys for payouts (required since March 2025)
- Never log full card numbers or sensitive payment data
- Never trust client-side payment data — always verify server-side

---

## Source Files

| File                                           | Purpose                                                      |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `lib/payments/core/razorpay.ts`                | Client initialization, order creation, refunds, cancellation |
| `lib/payments/payouts/razorpay-payouts.ts`     | RazorpayX Payouts service (contacts, fund accounts, payouts) |
| `app/api/webhooks/razorpay/route.ts`           | Webhook handler (14 event types)                             |
| `app/checkout/components/RazorpayCheckout.tsx` | Client-side checkout component                               |

---

## Related Documents

- [Gateway Overview](../README.md) — Comparison and selection logic
- [02-architecture-and-flow.md](./02-architecture-and-flow.md) — Payment flow and revenue split
- [03-payout-flow.md](./03-payout-flow.md) — RazorpayX payout system
- [04-kyc-and-onboarding.md](./04-kyc-and-onboarding.md) — KYC requirements
- [05-go-live-checklist.md](./05-go-live-checklist.md) — What must be true before the first live rupee
