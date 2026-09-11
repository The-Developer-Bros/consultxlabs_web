# Payment Gateway Setup Guide

This guide helps you configure payment gateways for your appointment booking system.

## Environment Variables

Create a `.env.local` file in your project root with the following variables:

### Development/Testing Mode

```bash
# Skip payment processing for development
SKIP_PAYMENT=true
```

### Stripe Configuration

```bash
# Stripe API Keys (get from https://dashboard.stripe.com/apikeys)
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here

# Public key for frontend (add to .env.local as well)
NEXT_PUBLIC_STRIPE_KEY=pk_test_your_stripe_public_key_here
```

### Razorpay Configuration

```bash
# Razorpay API Keys (get from https://dashboard.razorpay.com/app/keys)
RAZORPAY_KEY_ID=rzp_test_your_key_id_here
RAZORPAY_SECRET=your_razorpay_secret_here
RAZORPAY_WEBHOOK_SECRET=your_razorpay_webhook_secret_here
```

## Error Types and Solutions

### 🔴 Payment Config Error

**Cause**: Missing or invalid payment gateway API keys  
**Solution**: Check your environment variables and ensure API keys are correct

### 🔴 Payment Processing Error

**Cause**: Temporary payment gateway issues  
**Solution**: User should try again later

### 🔴 Database Error

**Cause**: Database connection or query issues  
**Solution**: Check database connection and try again

### 🟡 Availability Error

**Cause**: Selected time slot is no longer available  
**Solution**: User should select a different time slot

### 🔴 Not Found Error

**Cause**: Plan, event, or user not found  
**Solution**: Verify the booking URL and parameters

## Testing Payments

### 1. Skip Payment Mode

Set `SKIP_PAYMENT=true` to bypass payment processing entirely. Bookings will be created immediately.

### 2. Stripe Test Mode

Use Stripe test API keys with these test card numbers:

- **Success**: `4242 4242 4242 4242`
- **Failure**: `4000 0000 0000 0002`

### 3. Razorpay Test Mode

Use Razorpay test API keys. All test transactions will be simulated.

## Production Deployment

1. Replace test API keys with live/production keys
2. Set `SKIP_PAYMENT=false` or remove the variable
3. Configure webhooks for payment status updates
4. Test thoroughly before going live

## Webhook Configuration

### Stripe Webhooks

1. Go to [Stripe Dashboard > Webhooks](https://dashboard.stripe.com/webhooks)
2. Add endpoint: `https://yourdomain.com/api/webhooks/stripe`
3. Select events: `payment_intent.succeeded`, `payment_intent.payment_failed`
4. Copy webhook secret to `STRIPE_WEBHOOK_SECRET`

### Razorpay Webhooks

1. Go to [Razorpay Dashboard > Webhooks](https://dashboard.razorpay.com/app/webhooks)
2. Add endpoint: `https://yourdomain.com/api/webhooks/razorpay`
3. Select events: `payment.captured`, `payment.failed`
4. Copy webhook secret to `RAZORPAY_WEBHOOK_SECRET`

## Troubleshooting

### Common Issues:

1. **"Payment system unavailable"**
   - Check if API keys are set correctly
   - Verify API key format (starts with `sk_` for Stripe, `rzp_` for Razorpay)

2. **"Authentication failed"**
   - Ensure you're using the correct environment (test vs live)
   - Check if API keys have required permissions

3. **"Booking failed"**
   - Check database connection
   - Verify user authentication
   - Check if the plan/event exists

### Getting Help:

- Check the browser console for detailed error messages
- Review server logs for backend errors
- Contact support with error details and timestamp
