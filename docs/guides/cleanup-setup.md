# Abandoned Payment Cleanup Setup Guide

## Overview

This system provides **two versions** of abandoned payment cleanup:

1. **Local Script** (`scripts/cleanup-abandoned-payments.ts`) - For testing and manual runs
2. **GitHub Actions Job** (`jobs/cleanup-abandoned-payments.ts`) - For automated CI/CD cleanup

## **Key Differences**

| Feature            | Local Script      | GitHub Actions Job                  |
| ------------------ | ----------------- | ----------------------------------- |
| **Purpose**        | Testing & Manual  | Automated Cleanup                   |
| **Output**         | Console logs      | Structured results + GitHub outputs |
| **Error Handling** | Basic             | Enhanced with error collection      |
| **Execution**      | On-demand         | Scheduled (every 15 minutes)        |
| **Environment**    | Local development | CI/CD environment                   |

---

## **1. Local Script Version** 🖥️

### **File**: `scripts/cleanup-abandoned-payments.ts`

**Usage:**

```bash
# Run via npm script
npm run scripts:cleanup-abandoned-payments

# Run directly with ts-node
npx ts-node scripts/cleanup-abandoned-payments.ts
```

### **Features:**

- ✅ Manual execution for testing
- ✅ Simple console output
- ✅ Perfect for development/debugging
- ✅ No GitHub Actions dependencies

### **Environment Variables Required:**

```bash
DATABASE_URL=your_database_url
STRIPE_SECRET_KEY=sk_test_...        # Optional
RAZORPAY_KEY_ID=rzp_test_...         # Optional
RAZORPAY_KEY_SECRET=...              # Optional
```

---

## **2. GitHub Actions Job Version** 🚀

### **File**: `jobs/cleanup-abandoned-payments.ts`

**Triggered by:**

- ⏰ **Scheduled**: Every 15 minutes via cron
- 🔧 **Manual**: GitHub Actions "Run workflow" button

### **Enhanced Features:**

- ✅ **Structured Results**: Returns `CleanupResult` object
- ✅ **Error Collection**: Tracks all errors for reporting
- ✅ **GitHub Outputs**: Sets workflow outputs for monitoring
- ✅ **Success Rate Tracking**: Calculates cleanup success percentage
- ✅ **Performance Metrics**: Execution time tracking
- ✅ **Graceful Failure**: Non-critical errors don't fail the job

### **GitHub Actions Workflow**: `.github/workflows/cleanup-abandoned-payments.yml`

```yaml
name: Cleanup Abandoned Payments

on:
  schedule:
    - cron: "*/15 * * * *" # Every 15 minutes
  workflow_dispatch: # Manual trigger

jobs:
  cleanup-abandoned-payments:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "18"
          cache: "npm"
      - run: npm ci
      - run: npx ts-node jobs/cleanup-abandoned-payments.ts
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          # ... other secrets
```

---

## **Setup Instructions** ⚙️

### **1. Configure GitHub Secrets**

Go to `Settings` > `Secrets and variables` > `Actions` and add:

```bash
DATABASE_URL                 # Required - Your production database URL
STRIPE_SECRET_KEY           # Optional - For Stripe payment cancellation
RAZORPAY_KEY_ID            # Optional - For Razorpay cancellation
RAZORPAY_KEY_SECRET        # Optional - For Razorpay cancellation
```

### **2. Enable GitHub Actions**

1. Ensure GitHub Actions are enabled in repository settings
2. Commit the workflow file to your default branch
3. The workflow will start running automatically

### **3. Monitor Job Execution**

**GitHub Actions UI:**

- Go to `Actions` tab in your repository
- Look for "Cleanup Abandoned Payments" workflow
- View logs and execution history

**Job Outputs:**

```bash
cleaned_count=5      # Number of successfully cleaned appointments
error_count=0        # Number of failed cleanups
total_processed=5    # Total appointments found
success=true         # Overall job success status
```

---

## **How It Works** 🔧

### **Cleanup Logic:**

1. **Find Abandoned Appointments**:

   ```typescript
   // Appointments with pending payments that are either:
   // - Explicitly expired (expiresAt < now)
   // - Legacy without expiration (createdAt > 30 min ago)
   // - Have tentative slots
   ```

2. **Cancel Payment Intents**:

   ```typescript
   // For each payment gateway:
   // - Stripe: stripe.paymentIntents.cancel()
   // - Razorpay: razorpay.payments.cancel()
   ```

3. **Update Payment Status**:

   ```typescript
   // Mark payments as FAILED (cancelled = failed)
   paymentStatus: PaymentStatus.FAILED;
   ```

4. **Clean Up Database**:
   ```typescript
   // Remove tentative slots
   // Delete appointments if no confirmed slots remain
   // Clean up related consultation/subscription records
   ```

### **Safety Measures:**

- ✅ **Transaction-based**: All DB operations are atomic
- ✅ **Non-destructive**: Only removes tentative bookings
- ✅ **Graceful degradation**: Continues even if payment cancellation fails
- ✅ **Comprehensive logging**: Detailed logs for debugging

---

## **Testing & Debugging** 🧪

### **Test Locally:**

```bash
# 1. Set up .env file with test credentials
echo "DATABASE_URL=your_test_db_url" > .env

# 2. Run local script
npm run scripts:cleanup-abandoned-payments

# 3. Check output for any issues
```

### **Test GitHub Actions:**

1. Go to `Actions` tab in GitHub
2. Select "Cleanup Abandoned Payments" workflow
3. Click "Run workflow" button
4. Monitor logs in real-time

### **Common Issues:**

**Issue**: TypeScript compilation errors
**Solution**:

```bash
npm install @types/node ts-node typescript --save-dev
```

**Issue**: Database connection fails
**Solution**: Verify `DATABASE_URL` secret is correctly set

**Issue**: Payment gateway errors
**Solution**: Check if API keys are valid and not expired

---

## **Monitoring & Alerts** 📊

### **Success Monitoring:**

```bash
# Check cleanup job outputs
cleaned_count > 0     # Appointments were cleaned
error_count = 0       # No errors occurred
success = true        # Job completed successfully
```

### **Set Up Alerts:**

**Option 1: GitHub Actions Email Notifications**

- Enable in repository settings
- Get notified on workflow failures

**Option 2: Slack Integration**

```yaml
# Add to workflow after cleanup step
- name: Notify Slack on failure
  if: failure()
  uses: 8398a7/action-slack@v3
  with:
    status: failure
    webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

**Option 3: Custom Webhooks**

```typescript
// Add to job version
if (result.errorCount > 0) {
  await fetch(process.env.ALERT_WEBHOOK_URL, {
    method: "POST",
    body: JSON.stringify({
      message: `Cleanup job had ${result.errorCount} errors`,
      errors: result.errors,
    }),
  });
}
```

---

## **Performance Considerations** ⚡

### **Job Frequency:**

- **Current**: Every 15 minutes
- **Adjustable**: Modify cron schedule in workflow

### **Database Impact:**

- **Minimal**: Uses efficient queries with proper indexing
- **Transaction-based**: Prevents partial updates
- **Batched processing**: Handles large volumes gracefully

### **Resource Usage:**

- **GitHub Actions**: ~30-60 seconds execution time
- **Database**: Minimal connection time with automatic disconnect
- **Memory**: Low footprint with streaming queries

---

## **Security Best Practices** 🔒

### **1. Secrets Management**

- ✅ All API keys stored as GitHub Secrets
- ✅ No credentials in code or logs
- ✅ Environment-specific configurations

### **2. Database Access**

- ✅ Read-only access where possible
- ✅ Transaction-based operations
- ✅ Proper connection management

### **3. Error Handling**

- ✅ No sensitive data in error messages
- ✅ Graceful failure handling
- ✅ Comprehensive audit logging

---

## **Troubleshooting** 🛠️

### **Common Scenarios:**

**Scenario 1**: Job reports "0 appointments found"

- ✅ **Normal**: No abandoned payments to clean
- ✅ **Check**: Verify payment expiration logic is correct

**Scenario 2**: Payment cancellation fails

- ⚠️ **Action**: Check API credentials and connectivity
- ✅ **Impact**: Database cleanup still proceeds

**Scenario 3**: Database transaction fails

- ❌ **Action**: Check database connectivity and permissions
- ❌ **Impact**: No cleanup occurs, manual intervention needed

### **Debug Commands:**

```bash
# Local debugging
npm run scripts:cleanup-abandoned-payments

# Check database for pending payments
npx prisma studio

# View GitHub Actions logs
# Go to Actions tab > Select workflow run > View logs
```

This comprehensive setup provides robust, automated cleanup with excellent monitoring and debugging capabilities! 🎉
