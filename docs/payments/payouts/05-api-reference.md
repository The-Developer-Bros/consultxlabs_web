# API Reference

> Complete endpoint documentation for the payout system

---

## Endpoint Overview

| Category       | Endpoint                               | Method           | Access       |
| -------------- | -------------------------------------- | ---------------- | ------------ |
| **Admin**      | `/api/admin/payouts`                   | GET, POST        | Admin only   |
| **Admin**      | `/api/admin/payouts/{id}`              | GET, POST        | Admin only   |
| **Admin**      | `/api/admin/payouts/process`           | POST             | Admin only   |
| **Admin**      | `/api/admin/earnings`                  | GET              | Admin only   |
| **Admin**      | `/api/admin/earnings/stats`            | GET              | Admin only   |
| **Staff**      | `/api/staff/payouts`                   | GET              | Staff, Admin |
| **Staff**      | `/api/staff/invoices`                  | GET              | Staff, Admin |
| **Consultant** | `/api/consultant/earnings`             | GET              | Consultant   |
| **Consultant** | `/api/consultant/payout-accounts`      | GET, POST        | Consultant   |
| **Consultant** | `/api/consultant/payout-accounts/{id}` | GET, PUT, DELETE | Consultant   |

---

## Admin Endpoints

### List Payouts

```http
GET /api/admin/payouts
```

**Query Parameters:**

| Param      | Type   | Description                                                                   |
| ---------- | ------ | ----------------------------------------------------------------------------- |
| `status`   | string | Filter by status: PENDING, APPROVED, PROCESSING, COMPLETED, FAILED, CANCELLED |
| `provider` | string | Filter by provider: RAZORPAY, STRIPE                                          |
| `search`   | string | Search by consultant name                                                     |
| `limit`    | number | Results per page (default: 20)                                                |
| `offset`   | number | Pagination offset (default: 0)                                                |

**Response:**

```json
{
  "payouts": [
    {
      "id": "payout_123",
      "consultantId": "cp_456",
      "consultantName": "John Doe",
      "amount": 80000,
      "currency": "INR",
      "status": "PENDING",
      "method": "BANK_TRANSFER",
      "provider": "RAZORPAY",
      "batchId": "batch_2025_01_week4",
      "earningsCount": 3,
      "createdAt": "2025-01-27T01:30:00Z"
    }
  ],
  "pagination": {
    "total": 45,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

---

### Create Payout Batch (Manual)

```http
POST /api/admin/payouts
```

**Request Body:**

```json
{
  "action": "create_batch"
}
```

**Response:**

```json
{
  "message": "Batch created successfully",
  "batchId": "batch_2025_01_week4",
  "summary": {
    "payoutsCreated": 12,
    "autoApproved": 8,
    "pendingApproval": 4,
    "totalAmount": 450000,
    "skippedBelowMinimum": 3,
    "skippedNoAccount": 2
  }
}
```

---

### Get Payout Details

```http
GET /api/admin/payouts/{id}
```

**Response:**

```json
{
  "payout": {
    "id": "payout_123",
    "consultantProfile": {
      "id": "cp_456",
      "user": {
        "name": "John Doe",
        "email": "john@example.com"
      }
    },
    "amount": 80000,
    "currency": "INR",
    "status": "PENDING",
    "method": "BANK_TRANSFER",
    "provider": "RAZORPAY",
    "providerPayoutId": null,
    "batchId": "batch_2025_01_week4",
    "failureReason": null,
    "retryCount": 0,
    "approvedAt": null,
    "approvedBy": null,
    "processedAt": null,
    "createdAt": "2025-01-27T01:30:00Z"
  },
  "earnings": [
    {
      "id": "earn_789",
      "grossAmount": 50000,
      "consultantShare": 40000,
      "paymentId": "pay_abc",
      "status": "READY",
      "createdAt": "2025-01-20T10:00:00Z"
    }
  ],
  "payoutAccount": {
    "accountType": "BANK_ACCOUNT",
    "bankName": "HDFC Bank",
    "accountNumberLast4": "1234",
    "ifscCode": "HDFC0001234"
  }
}
```

---

### Approve/Reject Payout

```http
POST /api/admin/payouts/{id}
```

**Approve Request:**

```json
{
  "action": "approve"
}
```

**Reject Request:**

```json
{
  "action": "reject",
  "reason": "Account details need verification"
}
```

**Response (Approve):**

```json
{
  "message": "Payout approved successfully",
  "payout": {
    "id": "payout_123",
    "status": "APPROVED",
    "approvedAt": "2025-01-27T10:30:00Z",
    "approvedBy": "admin_user_id"
  }
}
```

**Response (Reject):**

```json
{
  "message": "Payout rejected successfully",
  "payout": {
    "id": "payout_123",
    "status": "CANCELLED"
  },
  "earningsUnlinked": 3
}
```

---

### Process Approved Payouts

```http
POST /api/admin/payouts/process
```

**Request Body:**

```json
{
  "action": "process"
}
```

**Response:**

```json
{
  "message": "Processing complete",
  "summary": {
    "processed": 8,
    "succeeded": 7,
    "failed": 1,
    "totalAmount": 320000
  },
  "failures": [
    {
      "payoutId": "payout_999",
      "error": "Invalid fund account"
    }
  ]
}
```

---

### Get Earnings (Admin View)

```http
GET /api/admin/earnings
```

**Query Parameters:**

| Param          | Type   | Description                          |
| -------------- | ------ | ------------------------------------ |
| `status`       | string | PENDING, READY, HELD, BATCHED, PAID, REFUNDED |
| `consultantId` | string | Filter by consultant                 |
| `limit`        | number | Results per page                     |
| `offset`       | number | Pagination offset                    |

**Response:**

```json
{
  "earnings": [
    {
      "id": "earn_123",
      "consultantName": "John Doe",
      "grossAmount": 50000,
      "platformFee": 10000,
      "consultantShare": 40000,
      "status": "READY",
      "holdUntil": "2025-01-26T10:00:00Z",
      "payoutId": null,
      "createdAt": "2025-01-25T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 156,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

---

### Get Earnings Stats

```http
GET /api/admin/earnings/stats
```

**Response:**

```json
{
  "stats": {
    "totalEarnings": 15000000,
    "pendingEarnings": 500000,
    "readyForPayout": 800000,
    "heldEarnings": 50000,
    "paidOutEarnings": 13600000,
    "platformRevenue": 3750000
  },
  "period": {
    "start": "2025-01-01T00:00:00Z",
    "end": "2025-01-31T23:59:59Z"
  }
}
```

---

## Staff Endpoints

### List Payouts (Staff View)

```http
GET /api/staff/payouts
```

**Note:** Same as admin but read-only. No approval actions.

**Response:** Same format as `/api/admin/payouts`

---

### List Invoices (Staff View)

```http
GET /api/staff/invoices
```

**Query Parameters:**

| Param    | Type   | Description                           |
| -------- | ------ | ------------------------------------- |
| `status` | string | PENDING, SUCCEEDED, FAILED            |
| `search` | string | Search by invoice number, name, email |
| `limit`  | number | Results per page                      |
| `offset` | number | Pagination offset                     |

**Response:**

```json
{
  "invoices": [
    {
      "id": "inv_123",
      "invoiceNumber": "FAM-202501-00042",
      "amount": 50000,
      "currency": "INR",
      "status": "SUCCEEDED",
      "gateway": "RAZORPAY",
      "userName": "Jane Smith",
      "userEmail": "jane@example.com",
      "appointmentType": "CONSULTATION",
      "consultantName": "John Doe",
      "createdAt": "2025-01-25T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 234,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

---

## Consultant Endpoints

### Get My Earnings

```http
GET /api/consultant/earnings
```

**Response:**

```json
{
  "summary": {
    "totalEarnings": 150000,
    "pendingEarnings": 20000,
    "readyForPayout": 50000,
    "heldEarnings": 0,
    "paidOutEarnings": 80000,
    "refundedEarnings": 0
  },
  "earnings": [
    {
      "id": "earn_123",
      "grossAmount": 50000,
      "platformFee": 10000,
      "consultantShare": 40000,
      "status": "READY",
      "holdUntil": "2025-01-26T10:00:00Z",
      "paidAt": null,
      "payment": {
        "id": "pay_abc",
        "appointmentType": "CONSULTATION"
      },
      "createdAt": "2025-01-25T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 15,
    "limit": 20,
    "offset": 0,
    "hasMore": false
  }
}
```

---

### List Payout Accounts

```http
GET /api/consultant/payout-accounts
```

**Response:**

```json
{
  "accounts": [
    {
      "id": "pa_123",
      "provider": "RAZORPAY",
      "accountType": "BANK_ACCOUNT",
      "accountHolderName": "John Doe",
      "bankName": "HDFC Bank",
      "accountNumberLast4": "1234",
      "ifscCode": "HDFC0001234",
      "isDefault": true,
      "isVerified": true,
      "createdAt": "2025-01-01T10:00:00Z"
    },
    {
      "id": "pa_456",
      "provider": "RAZORPAY",
      "accountType": "UPI",
      "upiId": "johndoe@upi",
      "isDefault": false,
      "isVerified": true,
      "createdAt": "2025-01-15T10:00:00Z"
    }
  ]
}
```

---

### Add Payout Account

```http
POST /api/consultant/payout-accounts
```

**Bank Account Request:**

```json
{
  "provider": "RAZORPAY",
  "accountType": "BANK_ACCOUNT",
  "accountHolderName": "John Doe",
  "bankName": "HDFC Bank",
  "accountNumber": "1234567890123456",
  "ifscCode": "HDFC0001234",
  "setAsDefault": true
}
```

**UPI Request:**

```json
{
  "provider": "RAZORPAY",
  "accountType": "UPI",
  "upiId": "johndoe@upi",
  "setAsDefault": false
}
```

**Stripe Connect Request:**

```json
{
  "provider": "STRIPE",
  "accountType": "STRIPE_CONNECT",
  "country": "US",
  "setAsDefault": true
}
```

**Response (Bank/UPI):**

```json
{
  "account": {
    "id": "pa_789",
    "provider": "RAZORPAY",
    "accountType": "BANK_ACCOUNT",
    "accountNumberLast4": "3456",
    "isDefault": true,
    "isVerified": true,
    "razorpayContactId": "cont_abc",
    "razorpayFundAccId": "fa_xyz"
  }
}
```

**Response (Stripe - requires onboarding):**

```json
{
  "account": {
    "id": "pa_789",
    "provider": "STRIPE",
    "accountType": "STRIPE_CONNECT",
    "stripeAccountId": "acct_abc",
    "stripeAccountStatus": "pending",
    "isDefault": true,
    "isVerified": false
  },
  "onboardingUrl": "https://connect.stripe.com/setup/..."
}
```

---

### Update Payout Account

```http
PUT /api/consultant/payout-accounts/{id}
```

**Request Body:**

```json
{
  "setAsDefault": true
}
```

**Response:**

```json
{
  "account": {
    "id": "pa_456",
    "isDefault": true
  },
  "message": "Account updated successfully"
}
```

---

### Delete Payout Account

```http
DELETE /api/consultant/payout-accounts/{id}
```

**Response:**

```json
{
  "message": "Account deleted successfully"
}
```

**Error (if default account):**

```json
{
  "error": "Cannot delete default account. Set another account as default first."
}
```

---

## Error Responses

All endpoints return consistent error formats:

```json
{
  "error": "Error message here",
  "code": "ERROR_CODE",
  "details": {}
}
```

### Common Error Codes

| Code               | HTTP Status | Description                             |
| ------------------ | ----------- | --------------------------------------- |
| `UNAUTHORIZED`     | 401         | Not authenticated                       |
| `FORBIDDEN`        | 403         | Insufficient permissions                |
| `NOT_FOUND`        | 404         | Resource not found                      |
| `VALIDATION_ERROR` | 400         | Invalid request data                    |
| `INVALID_STATUS`   | 400         | Cannot perform action in current status |
| `PROVIDER_ERROR`   | 500         | Payment provider error                  |

---

## Currency Display (Mar 2026)

All amounts in the API and database are stored in **paise** (smallest currency unit). Admin dashboard pages now use `formatCurrencyAmount()` (which divides by 100) instead of the previous `formatCurrencyFromMajorUnit()` when displaying DB-sourced values. This ensures correct rendering -- e.g., a DB value of `80000` (paise) is displayed as "800.00 INR" rather than "80,000.00 INR".

---

## Authentication

All endpoints require authentication via NextAuth session.

```typescript
// Session check in API routes
const session = await getServerSession(authOptions);
if (!session?.user?.id) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Role check
const user = await prisma.user.findUnique({
  where: { id: session.user.id },
  select: { role: true },
});

if (user?.role !== "ADMIN") {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

---

## Next: [05-configuration.md](./05-configuration.md)
