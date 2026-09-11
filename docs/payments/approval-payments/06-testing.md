# Testing Guide

## Overview

Comprehensive testing strategy for the payment approval workflow, covering unit tests, integration tests, and end-to-end scenarios.

## Test Environment Setup

### Dependencies

```bash
# Install testing libraries
npm install --save-dev @testing-library/react @testing-library/jest-dom
npm install --save-dev @testing-library/user-event vitest
npm install --save-dev supertest msw
```

### Environment Variables

```bash
# .env.test
DATABASE_URL="postgresql://test:test@localhost:5432/familiarise_test"
UPSTASH_REDIS_REST_URL="https://test-redis.upstash.io"
UPSTASH_REDIS_REST_TOKEN="test_token"
RESEND_API_KEY="re_test_key"
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_PUBLISHABLE_KEY="pk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_test_..."
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

### Test Database Setup

```bash
# Create test database
createdb familiarise_test

# Run migrations
npx prisma migrate deploy

# Seed test data
npx prisma db seed --env test
```

---

## Unit Tests

### 1. Distributed Locking

```typescript
// __tests__/utils/appointmentlock.test.ts
import {
  lockConsultationApproval,
  lockSubscriptionApproval,
  unlockApproval,
} from "@/utils/appointmentlock";

describe("Distributed Locking", () => {
  describe("lockConsultationApproval", () => {
    it("should acquire lock successfully", async () => {
      const consultationId = "test-consultation-123";
      const lock = await lockConsultationApproval(consultationId, 5000);

      expect(lock).toBeDefined();
      expect(lock.value).toContain(consultationId);

      await unlockApproval(lock);
    });

    it("should fail when lock already held", async () => {
      const consultationId = "test-consultation-456";

      // Acquire first lock
      const lock1 = await lockConsultationApproval(consultationId, 5000);

      // Second acquisition should fail
      await expect(
        lockConsultationApproval(consultationId, 100),
      ).rejects.toThrow("Another approval is in progress");

      await unlockApproval(lock1);
    });

    it("should auto-expire after TTL", async () => {
      const consultationId = "test-consultation-789";

      // Acquire lock with 1 second TTL
      await lockConsultationApproval(consultationId, 1000);
      // Don't release - let it expire

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Lock should be available again
      const lock2 = await lockConsultationApproval(consultationId, 5000);
      expect(lock2).toBeDefined();

      await unlockApproval(lock2);
    });

    it("should use correct key format", async () => {
      const consultationId = "clx123abc";
      const lock = await lockConsultationApproval(consultationId);

      expect(lock.value).toBe(`consultation-approval:${consultationId}`);

      await unlockApproval(lock);
    });
  });

  describe("lockSubscriptionApproval", () => {
    it("should use subscription-specific key", async () => {
      const subscriptionId = "clx456def";
      const lock = await lockSubscriptionApproval(subscriptionId);

      expect(lock.value).toBe(`subscription-approval:${subscriptionId}`);

      await unlockApproval(lock);
    });
  });
});
```

### 2. Email Service

```typescript
// __tests__/lib/email.test.ts
import { sendPaymentLinkEmail } from "@/lib/email";
import { render } from "@react-email/render";

// Mock Resend
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ id: "email_123" }),
    },
  })),
}));

describe("Email Service", () => {
  describe("sendPaymentLinkEmail", () => {
    it("should send email with correct data", async () => {
      const result = await sendPaymentLinkEmail({
        email: "test@example.com",
        name: "Test User",
        consultantName: "Dr. Test",
        appointmentType: "consultation",
        amount: 100,
        currency: "USD",
        paymentUrl: "https://checkout.stripe.com/test",
        expiresAt: new Date("2025-01-15T10:00:00Z"),
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("id");
    });

    it("should handle missing API key gracefully", async () => {
      // Temporarily remove API key
      const originalKey = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;

      const result = await sendPaymentLinkEmail({
        email: "test@example.com",
        name: "Test User",
        consultantName: "Dr. Test",
        appointmentType: "consultation",
        amount: 100,
        currency: "USD",
        paymentUrl: "https://test.com",
        expiresAt: new Date(),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Email service not configured");

      // Restore API key
      process.env.RESEND_API_KEY = originalKey;
    });
  });
});
```

### 3. Payment Helpers

```typescript
// __tests__/lib/payments/operations/approval-payment.test.ts
import { createApprovalPaymentIntent } from "@/lib/payments/operations/approval-payment";

describe("Approval Payment Operations", () => {
  it("should create payment intent with correct metadata", async () => {
    const result = await createApprovalPaymentIntent({
      userId: "clxUser123",
      appointmentType: "CONSULTATION",
      consultationId: "clxConsult123",
      planId: "clxPlan123",
      paymentGateway: "STRIPE",
      startsAt: "2025-01-20T14:00:00.000Z",     // renamed from `slotStartTimeInUTC`
      endsAt: "2025-01-20T14:30:00.000Z",       // renamed from `slotEndTimeInUTC`
    });

    expect(result).toHaveProperty("checkoutUrl");
    expect(result).toHaveProperty("paymentIntentId");
    expect(result).toHaveProperty("amount");
    expect(result).toHaveProperty("currency");
  });
});
```

---

## Integration Tests

### 1. Approval Flow

```typescript
// __tests__/api/bookings/consultations/approval.test.ts
import { createMocks } from "node-mocks-http";
import { PATCH } from "@/app/api/bookings/consultations/[consultationId]/route";
import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client"; // renamed from `RequestStatus`

describe("Consultation Approval API", () => {
  let testConsultation: any;

  beforeEach(async () => {
    // Create test consultation
    testConsultation = await prisma.consultation.create({
      data: {
        status: AppointmentStatus.PENDING,
        consultationPlan: {
          connect: { id: "test-plan-id" },
        },
        requestedBy: {
          connect: { id: "test-consultee-id" },
        },
      },
    });
  });

  afterEach(async () => {
    await prisma.consultation.delete({
      where: { id: testConsultation.id },
    });
  });

  it("should generate payment link when approving without payment", async () => {
    const { req, res } = createMocks({
      method: "PATCH",
      body: { status: AppointmentStatus.APPROVED },
    });

    const response = await PATCH(req, {
      params: Promise.resolve({ consultationId: testConsultation.id }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.requiresPayment).toBe(true);
    expect(data.paymentUrl).toBeDefined();
    expect(data.data.status).toBe(
      AppointmentStatus.APPROVED_PENDING_PAYMENT,
    );
  });

  it("should prevent duplicate approvals", async () => {
    // First approval
    const response1 = await PATCH(
      createMocks({ method: "PATCH", body: { status: AppointmentStatus.APPROVED } })
        .req,
      { params: Promise.resolve({ consultationId: testConsultation.id }) },
    );

    // Second approval (concurrent)
    const response2 = await PATCH(
      createMocks({ method: "PATCH", body: { status: AppointmentStatus.APPROVED } })
        .req,
      { params: Promise.resolve({ consultationId: testConsultation.id }) },
    );

    const data1 = await response1.json();
    const data2 = await response2.json();

    // One should succeed, one should be duplicate
    const successCount = [data1, data2].filter((d) => !d.duplicate).length;
    expect(successCount).toBe(1);
  });

  it("should return 409 if lock cannot be acquired", async () => {
    // Hold lock manually
    const lock = await lockConsultationApproval(testConsultation.id, 10000);

    try {
      const response = await PATCH(
        createMocks({
          method: "PATCH",
          body: { status: AppointmentStatus.APPROVED },
        }).req,
        { params: Promise.resolve({ consultationId: testConsultation.id }) },
      );

      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toContain("Another approval is in progress");
    } finally {
      await unlockApproval(lock);
    }
  });
});
```

### 2. Webhook Processing

```typescript
// __tests__/lib/payments/webhooks/handlers.test.ts
import {
  handlePaymentSuccess,
  handlePaymentFailure,
} from "@/lib/payments/webhooks/handlers";
import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";

describe("Webhook Handlers", () => {
  let testPayment: any;

  beforeEach(async () => {
    testPayment = await prisma.payment.create({
      data: {
        paymentIntent: "pi_test_123",
        amount: 10000,
        currency: "usd",
        paymentStatus: PaymentStatus.PENDING,
        paymentGateway: "STRIPE",
        user: { connect: { id: "test-user-id" } },
      },
    });
  });

  afterEach(async () => {
    await prisma.payment.delete({ where: { id: testPayment.id } });
  });

  describe("handlePaymentSuccess", () => {
    it("should update payment status and create appointment", async () => {
      const metadata = {
        appointmentType: "CONSULTATION",
        consultationId: "test-consultation-id",
        planId: "test-plan-id",
      };

      await handlePaymentSuccess("pi_test_123", metadata);

      const updatedPayment = await prisma.payment.findUnique({
        where: { id: testPayment.id },
      });

      expect(updatedPayment?.paymentStatus).toBe(PaymentStatus.SUCCEEDED);
    });

    it("should be idempotent (safe to retry)", async () => {
      const metadata = {
        appointmentType: "CONSULTATION",
        consultationId: "test-consultation-id",
      };

      // Process twice
      await handlePaymentSuccess("pi_test_123", metadata);
      await handlePaymentSuccess("pi_test_123", metadata);

      // Should only update once
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: testPayment.id },
      });

      expect(updatedPayment?.paymentStatus).toBe(PaymentStatus.SUCCEEDED);
    });
  });

  describe("handlePaymentFailure", () => {
    it("should update payment status to FAILED", async () => {
      await handlePaymentFailure("pi_test_123");

      const updatedPayment = await prisma.payment.findUnique({
        where: { id: testPayment.id },
      });

      expect(updatedPayment?.paymentStatus).toBe(PaymentStatus.FAILED);
    });
  });
});
```

---

## End-to-End Tests

### Full Approval Flow

```typescript
// __tests__/e2e/approval-workflow.test.ts
import { test, expect } from "@playwright/test";

test.describe("Payment Approval Workflow", () => {
  test("consultant approves request and consultee completes payment", async ({
    page,
    context,
  }) => {
    // 1. Login as consultant
    await page.goto("/auth/signin");
    await page.fill('input[name="email"]', "consultant@test.com");
    await page.fill('input[name="password"]', "testpass123");
    await page.click('button[type="submit"]');

    // 2. Navigate to requests page
    await page.goto("/dashboard/consultant/test-id/requests");
    await expect(page.locator("text=Pending Requests")).toBeVisible();

    // 3. Approve request
    await page.click('button:has-text("Approve")');
    await expect(page.locator("text=Payment link sent")).toBeVisible();

    // 4. Switch to consultee
    const consulteePage = await context.newPage();
    await consulteePage.goto("/auth/signin");
    await consulteePage.fill('input[name="email"]', "consultee@test.com");
    await consulteePage.fill('input[name="password"]', "testpass123");
    await consulteePage.click('button[type="submit"]');

    // 5. See pending payment widget
    await consulteePage.goto("/dashboard/consultee/test-id/home");
    await expect(consulteePage.locator("text=Payment Required")).toBeVisible();

    // 6. Click "Pay Now"
    await consulteePage.click('button:has-text("Pay Now")');

    // 7. Complete payment (Stripe test mode)
    await consulteePage.fill('input[name="cardNumber"]', "4242424242424242");
    await consulteePage.fill('input[name="cardExpiry"]', "12/25");
    await consulteePage.fill('input[name="cardCvc"]', "123");
    await consulteePage.click('button:has-text("Pay")');

    // 8. Verify success
    await expect(
      consulteePage.locator("text=Payment Successful"),
    ).toBeVisible();

    // 9. Check consultant dashboard shows approved status
    await page.reload();
    await expect(page.locator('text="APPROVED"')).toBeVisible();
  });

  test("payment link expires after 48 hours", async ({ page }) => {
    // 1. Create expired approval (mock system time)
    await page.addInitScript(() => {
      Date.now = () => new Date("2025-01-17T10:00:00Z").getTime();
    });

    // 2. Run cleanup job
    const response = await page.request.get("/api/cleanup/approval-payments");
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(data.summary.total.reverted).toBeGreaterThan(0);

    // 3. Verify status reverted to PENDING
    await page.goto("/dashboard/consultant/test-id/requests");
    await expect(page.locator('text="PENDING"')).toBeVisible();
  });
});
```

---

## Performance Tests

### Load Testing

```typescript
// __tests__/performance/approval-load.test.ts
import autocannon from "autocannon";

describe("Approval Endpoint Performance", () => {
  it("should handle 100 concurrent approvals", async () => {
    const result = await autocannon({
      url: "http://localhost:3000/api/bookings/consultations/test-id",
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "APPROVED" }),
      connections: 100,
      duration: 30, // 30 seconds
    });

    console.log(`Requests/sec: ${result.requests.average}`);
    console.log(`Latency p99: ${result.latency.p99}ms`);

    expect(result.non2xx).toBe(0); // No errors
    expect(result.latency.p99).toBeLessThan(3000); // < 3s
  });
});
```

---

## Testing Checklist

### Unit Tests

- [ ] Distributed locking (acquire, release, expiry)
- [ ] Email service (send success, failures, missing config)
- [ ] Payment helpers (intent creation, metadata)
- [ ] Database queries (optimized, correct joins)

### Integration Tests

- [ ] Approval flow (no payment, with payment, duplicate)
- [ ] Webhook processing (success, failure, idempotency)
- [ ] Dashboard endpoints (consultee, admin)
- [ ] Cleanup job (expired items, partial failures)

### End-to-End Tests

- [ ] Full approval → payment → confirmation flow
- [ ] Payment link expiry and reversion
- [ ] Concurrent approvals (race conditions)
- [ ] Email delivery (payment link, success, failure)

### Performance Tests

- [ ] Approval endpoint under load (100 concurrent)
- [ ] Lock contention handling (multiple instances)
- [ ] Database query performance (< 500ms p99)
- [ ] Email sending throughput (rate limits)

### Security Tests

- [ ] Authentication required for all endpoints
- [ ] Authorization checks (consultant owns resource)
- [ ] Webhook signature verification
- [ ] SQL injection prevention
- [ ] XSS prevention in email templates

---

## Continuous Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: familiarise_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: "18"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Run migrations
        run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgresql://postgres:test@localhost:5432/familiarise_test

      - name: Run unit tests
        run: npm run test:unit

      - name: Run integration tests
        run: npm run test:integration

      - name: Run E2E tests
        run: npm run test:e2e

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

---

## Mock Services

### Mock Stripe

```typescript
// __mocks__/stripe.ts
export const mockStripe = {
  paymentIntents: {
    create: jest.fn().mockResolvedValue({
      id: "pi_test_123",
      client_secret: "pi_test_123_secret_456",
      amount: 10000,
      currency: "usd",
    }),
  },
  checkout: {
    sessions: {
      create: jest.fn().mockResolvedValue({
        url: "https://checkout.stripe.com/test",
        id: "cs_test_123",
      }),
    },
  },
};
```

### Mock Resend

```typescript
// __mocks__/resend.ts
export const mockResend = {
  emails: {
    send: jest.fn().mockResolvedValue({
      id: "email_test_123",
    }),
  },
};
```

### Mock Redis

```typescript
// __mocks__/redis.ts
export const mockRedis = {
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(1),
};
```

---

## Test Data Factories

```typescript
// __tests__/factories/consultation.ts
import { faker } from "@faker-js/faker";
import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client"; // renamed from `RequestStatus`

export async function createTestConsultation(overrides = {}) {
  return await prisma.consultation.create({
    data: {
      status: AppointmentStatus.PENDING,
      requestNotes: faker.lorem.paragraph(),
      consultationPlan: {
        create: {
          title: faker.lorem.words(3),
          amount: faker.number.int({ min: 50, max: 500 }),
          currency: "USD",
          durationInHours: 1,
          consultantProfile: {
            create: {
              user: {
                create: {
                  email: faker.internet.email(),
                  name: faker.person.fullName(),
                  role: "CONSULTANT",
                },
              },
            },
          },
        },
      },
      requestedBy: {
        create: {
          user: {
            create: {
              email: faker.internet.email(),
              name: faker.person.fullName(),
              role: "CONSULTEE",
            },
          },
        },
      },
      ...overrides,
    },
  });
}
```

---

## Best Practices

### ✅ DO

1. **Isolate tests**: Each test should be independent
2. **Clean up**: Delete test data after each test
3. **Mock external services**: Don't call real Stripe/Resend in tests
4. **Test edge cases**: Concurrent requests, expired links, etc.
5. **Use factories**: Create test data consistently

### ❌ DON'T

1. **Don't share state**: Tests should not depend on each other
2. **Don't skip cleanup**: Always delete test data
3. **Don't hardcode IDs**: Use faker or factories
4. **Don't test implementation details**: Test behavior, not internals
5. **Don't ignore flaky tests**: Fix or skip them

---

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests only
npm run test:e2e

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Specific file
npm test -- approval.test.ts

# Verbose output
npm test -- --verbose
```
