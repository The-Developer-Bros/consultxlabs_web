# Payment Status Flows & Mock Payment Guide

## Overview

This document explains the complete status lifecycle for all 4 event types, including both **real payment** and **mock payment** flows. It also covers the cleanup mechanisms for abandoned payments.

---

## Table of Contents

1. [Status Definitions](#status-definitions)
2. [Consultation Flow](#consultation-flow)
3. [Subscription Flow](#subscription-flow)
4. [Webinar Flow](#webinar-flow)
5. [Class Flow](#class-flow)
6. [Mock vs Real Payment Comparison](#mock-vs-real-payment-comparison)
7. [Cleanup Mechanisms](#cleanup-mechanisms)

---

## Status Definitions

### Appointment Status (Consultation & Subscription)

> **Rename note:** The DB field was `status` (enum `AppointmentStatus`); after the terminology-unification refactor it is `status` (enum `AppointmentStatus`). The enum *values* are unchanged.

| Status                     | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `PENDING`                  | User submitted request, awaiting payment or consultant action |
| `APPROVED_PENDING_PAYMENT` | Consultant approved (Pay Later flow), waiting for user to pay |
| `APPROVED`                 | Payment received, booking confirmed                           |
| `REJECTED`                 | Consultant rejected OR payment expired                        |
| `CANCELLED`                | User or consultant cancelled                                  |
| `EXPIRED`                  | Request timed out without action                              |

### Event Status (Webinar & Class)

| Status        | Description                              |
| ------------- | ---------------------------------------- |
| `DRAFT`       | Event created but not published          |
| `SCHEDULED`   | Event published with confirmed date/time |
| `IN_PROGRESS` | Event is currently happening             |
| `COMPLETED`   | Event finished                           |
| `CANCELLED`   | Event was cancelled                      |

### Payment Status

| Status      | Description                            |
| ----------- | -------------------------------------- |
| `PENDING`   | Payment initiated, awaiting completion |
| `SUCCEEDED` | Payment completed successfully         |
| `FAILED`    | Payment failed or was cancelled        |

---

## Consultation Flow

### Complete Status Flow Diagram

```mermaid
flowchart TD
    subgraph "User Actions"
        START([User Visits<br/>Consultant Page]) --> SELECT[Select Consultation Plan]
        SELECT --> CHOOSE_SLOT[Choose Available Slot]
        CHOOSE_SLOT --> CHECKOUT[Click Book/Checkout]
    end

    subgraph "Direct Payment Flow"
        CHECKOUT --> |"Real Payment"| CREATE_INTENT[Create Payment Intent<br/>Stripe/Razorpay]
        CREATE_INTENT --> REDIRECT[Redirect to<br/>Payment Gateway]
        REDIRECT --> PAY{User Pays?}
        PAY --> |"Success"| WEBHOOK[Webhook Received]
        PAY --> |"Abandon/Fail"| EXPIRE[Payment Expires<br/>30 min timeout]

        CHECKOUT --> |"Mock Payment"| MOCK_INTENT[Create Mock Intent<br/>order_mock_xxx]
        MOCK_INTENT --> MOCK_SUCCESS[Instant Success<br/>No Gateway UI]
    end

    subgraph "Database State"
        CREATE_INTENT --> DB_PENDING["Payment: PENDING<br/>Consultation: PENDING<br/>Slots: isTentative=true"]
        MOCK_INTENT --> DB_PENDING

        WEBHOOK --> DB_SUCCESS["Payment: SUCCEEDED<br/>Consultation: APPROVED<br/>Slots: isTentative=false"]
        MOCK_SUCCESS --> DB_SUCCESS

        EXPIRE --> CLEANUP["Cleanup Job Runs<br/>(every 15 min)"]
        CLEANUP --> DB_CLEANUP["Payment: FAILED<br/>Consultation: DELETED<br/>Slots: DELETED"]
    end

    subgraph "Pay Later Flow (Approval Required)"
        CHECKOUT --> |"Request Approval"| REQ_PENDING["Consultation: PENDING<br/>No Payment Yet"]
        REQ_PENDING --> CONSULTANT{Consultant<br/>Decision}
        CONSULTANT --> |"Reject"| REJECTED["Consultation: REJECTED"]
        CONSULTANT --> |"Approve"| APPROVED_PP["Consultation: APPROVED_PENDING_PAYMENT<br/>Payment Link Sent"]
        APPROVED_PP --> USER_PAYS{User Pays<br/>within 48hrs?}
        USER_PAYS --> |"Yes"| DB_SUCCESS
        USER_PAYS --> |"No"| CLEANUP_APP["Cleanup Job<br/>→ REJECTED"]
    end

    style DB_SUCCESS fill:#90EE90
    style DB_CLEANUP fill:#FF6B6B
    style REJECTED fill:#FF6B6B
    style CLEANUP_APP fill:#FF6B6B
    style MOCK_SUCCESS fill:#87CEEB
```

### Consultation: Mock vs Real Payment

| Step              | Real Payment (Razorpay)               | Mock Payment                             |
| ----------------- | ------------------------------------- | ---------------------------------------- |
| 1. Checkout       | `handleCheckout(data, userId, false)` | `handleCheckout(data, userId, true)`     |
| 2. Payment Intent | Real Razorpay Order created           | Fake ID: `order_mock_abc123`             |
| 3. User Action    | Redirected to Razorpay checkout       | No redirect, instant success             |
| 4. Confirmation   | Webhook from Razorpay                 | Direct DB update in same transaction     |
| 5. Status Update  | `handlePaymentSuccess()` via webhook  | `handlePaymentSuccess()` called directly |

---

## Subscription Flow

### Complete Status Flow Diagram

```mermaid
flowchart TD
    subgraph "User Actions"
        START([User Visits<br/>Consultant Page]) --> SELECT[Select Subscription Plan]
        SELECT --> CHOOSE{Booking Type}
        CHOOSE --> |"Scheduling Period"| PERIOD[Select Start/End Dates<br/>e.g., Dec 1 - Dec 31]
        CHOOSE --> |"Specific Slots"| SLOTS[Select Specific Time Slots]
        PERIOD --> CHECKOUT[Click Subscribe]
        SLOTS --> CHECKOUT
    end

    subgraph "Payment Processing"
        CHECKOUT --> |"Real Payment"| CREATE_INTENT[Create Razorpay Order]
        CHECKOUT --> |"Mock Payment"| MOCK_INTENT[Create Mock Intent]

        CREATE_INTENT --> GATEWAY[User Completes Payment<br/>on Razorpay]
        GATEWAY --> WEBHOOK[Webhook Received]

        MOCK_INTENT --> MOCK_SUCCESS[Instant Success]
    end

    subgraph "Post-Payment State"
        WEBHOOK --> STAY_PENDING["Subscription: PENDING ✓<br/>Payment: SUCCEEDED<br/>Appointment: Placeholder<br/>(No slots yet)"]
        MOCK_SUCCESS --> STAY_PENDING

        STAY_PENDING --> REQUESTS["Appears in Consultant's<br/>REQUESTS Tab"]
    end

    subgraph "Consultant Actions"
        REQUESTS --> ALLOCATE[Consultant Clicks<br/>'Allocate Slots']
        ALLOCATE --> CALENDAR[Opens Calendar View]
        CALENDAR --> SELECT_SLOTS[Selects Time Slots<br/>for Sessions]
        SELECT_SLOTS --> CONFIRM[Confirms Allocation]
        CONFIRM --> APPROVED["Subscription: APPROVED ✓<br/>Slots Created<br/>isTentative=false"]
    end

    subgraph "User Dashboard"
        APPROVED --> SCHEDULED_VIEW["User Sees:<br/>'Scheduled' Status<br/>with Session Times"]
    end

    style STAY_PENDING fill:#FFA500
    style APPROVED fill:#90EE90
    style REQUESTS fill:#87CEEB
    style MOCK_SUCCESS fill:#87CEEB
```

### Key Difference: Subscription Status After Payment

**Important:** Unlike consultations, subscriptions do NOT become `APPROVED` after payment. They stay `PENDING` so they appear in the consultant's Requests tab for slot allocation.

```
Consultation: PENDING → (payment) → APPROVED
Subscription: PENDING → (payment) → PENDING → (consultant allocates slots) → APPROVED
```

### Subscription: Mock vs Real Payment

| Step                     | Real Payment (Razorpay)               | Mock Payment               |
| ------------------------ | ------------------------------------- | -------------------------- |
| 1. Checkout              | Creates real Razorpay order           | Creates `order_mock_xxx`   |
| 2. Payment UI            | User sees Razorpay checkout           | No UI, instant completion  |
| 3. Webhook               | Razorpay sends webhook                | Skipped - direct DB update |
| 4. Status After Payment  | `PENDING` (stays for slot allocation) | `PENDING` (same behavior)  |
| 5. Appears in Requests   | Yes                                   | Yes                        |
| 6. After Slot Allocation | `APPROVED`                            | `APPROVED`                 |

---

## Webinar Flow

### Complete Status Flow Diagram

```mermaid
flowchart TD
    subgraph "Consultant Creates Webinar"
        CREATE([Consultant Creates<br/>Webinar]) --> DRAFT["Status: DRAFT<br/>No date set yet"]
        DRAFT --> SET_DATE[Set Date & Time]
        SET_DATE --> PUBLISH[Publish Webinar]
        PUBLISH --> SCHEDULED["Status: SCHEDULED<br/>Open for Registration"]
    end

    subgraph "User Registration"
        SCHEDULED --> USER_FINDS[User Finds Webinar]
        USER_FINDS --> REGISTER[Click Register/Join]

        REGISTER --> |"Real Payment"| PAY_REAL[Razorpay Checkout]
        REGISTER --> |"Mock Payment"| PAY_MOCK[Mock Payment]

        PAY_REAL --> WEBHOOK[Webhook Success]
        PAY_MOCK --> MOCK_SUCCESS[Instant Success]
    end

    subgraph "Registration State"
        WEBHOOK --> JOINED["User Added to Webinar<br/>SlotOfAppointment created<br/>isTentative=false"]
        MOCK_SUCCESS --> JOINED

        JOINED --> MULTI_USERS["Multiple Users Can Join<br/>Same Shared Appointment"]
    end

    subgraph "Event Lifecycle"
        SCHEDULED --> |"Event Time"| IN_PROGRESS["Status: IN_PROGRESS"]
        IN_PROGRESS --> |"Event Ends"| COMPLETED["Status: COMPLETED"]
    end

    style DRAFT fill:#D3D3D3
    style SCHEDULED fill:#90EE90
    style IN_PROGRESS fill:#FFD700
    style COMPLETED fill:#87CEEB
    style JOINED fill:#90EE90
```

### Webinar: Mock vs Real Payment

| Step              | Real Payment                | Mock Payment          |
| ----------------- | --------------------------- | --------------------- |
| 1. Register       | Creates payment intent      | Creates mock intent   |
| 2. Payment        | User pays via gateway       | Instant success       |
| 3. Slot Creation  | Via webhook                 | Direct in transaction |
| 4. User Joins     | Added to shared appointment | Same                  |
| 5. Webinar Status | Stays `SCHEDULED`           | Stays `SCHEDULED`     |

**Note:** Webinar status doesn't change based on user payments. It only changes based on event lifecycle (DRAFT → SCHEDULED → IN_PROGRESS → COMPLETED).

---

## Class Flow

### Complete Status Flow Diagram

```mermaid
flowchart TD
    subgraph "Consultant Creates Class"
        CREATE([Consultant Creates<br/>Class]) --> DRAFT["Status: DRAFT"]
        DRAFT --> CONFIG[Configure:<br/>- Duration in weeks<br/>- Sessions per week<br/>- Start date]
        CONFIG --> PUBLISH[Publish Class]
        PUBLISH --> SCHEDULED["Status: SCHEDULED<br/>Multiple Appointments Created<br/>(one per session)"]
    end

    subgraph "User Enrollment"
        SCHEDULED --> USER_FINDS[User Finds Class]
        USER_FINDS --> ENROLL[Click Enroll]

        ENROLL --> |"Real Payment"| PAY_REAL[Razorpay Checkout]
        ENROLL --> |"Mock Payment"| PAY_MOCK[Mock Payment]

        PAY_REAL --> WEBHOOK[Webhook Success]
        PAY_MOCK --> MOCK_SUCCESS[Instant Success]
    end

    subgraph "Enrollment State"
        WEBHOOK --> ENROLLED["User Added to ALL Sessions<br/>Tentative slots → Confirmed<br/>for each appointment"]
        MOCK_SUCCESS --> ENROLLED
    end

    subgraph "Class Sessions"
        ENROLLED --> SESSION1["Session 1: User attends"]
        SESSION1 --> SESSION2["Session 2: User attends"]
        SESSION2 --> SESSIONN["Session N: User attends"]
        SESSIONN --> COMPLETED["Class: COMPLETED"]
    end

    style DRAFT fill:#D3D3D3
    style SCHEDULED fill:#90EE90
    style ENROLLED fill:#90EE90
    style COMPLETED fill:#87CEEB
```

### Class: Mock vs Real Payment

| Step              | Real Payment                     | Mock Payment                |
| ----------------- | -------------------------------- | --------------------------- |
| 1. Enroll         | Creates payment intent           | Creates mock intent         |
| 2. Payment        | User pays via gateway            | Instant success             |
| 3. Session Access | Via webhook - joins all sessions | Direct - joins all sessions |
| 4. Class Status   | Stays `SCHEDULED`                | Stays `SCHEDULED`           |

---

## Mock vs Real Payment Comparison

### Complete Comparison Table

| Aspect                  | Real Payment (Razorpay/Stripe)      | Mock Payment                                          |
| ----------------------- | ----------------------------------- | ----------------------------------------------------- |
| **API Call**            | Real gateway API                    | None (fake ID generated)                              |
| **Payment ID Format**   | `order_abc123...` (Razorpay)        | `order_mock_abc123...`                                |
| **User Experience**     | Redirect to payment page            | No redirect, instant                                  |
| **Confirmation Method** | Webhook callback                    | Direct DB update                                      |
| **Time to Complete**    | User-dependent (seconds to minutes) | ~500ms (simulated delay)                              |
| **Money Charged**       | Yes (real money)                    | No                                                    |
| **Use Case**            | Production                          | Development/Testing                                   |
| **Environment**         | Any                                 | `NODE_ENV=development` or `ENABLE_MOCK_PAYMENTS=true` |

### How Mock Payments Work

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as Backend
    participant DB as Database

    U->>F: Click "Book" (with mock flag)
    F->>B: POST /api/checkout {isMockPayment: true}
    B->>B: createMockPaymentIntent()
    Note over B: Generates fake ID:<br/>order_mock_abc123...
    B->>DB: Create Payment (PENDING)
    B->>DB: Create Tentative Appointment
    B->>DB: Update Payment (SUCCEEDED)
    B->>B: confirmExistingAppointment()
    B->>DB: Set slots isTentative=false
    B-->>F: {success: true, skipPayment: true}
    F-->>U: "Booking Confirmed!"
    Note over U,DB: Total time: ~1 second
```

### How Real Payments Work

```mermaid
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as Backend
    participant G as Razorpay
    participant DB as Database

    U->>F: Click "Book"
    F->>B: POST /api/checkout
    B->>G: Create Order
    G-->>B: order_id + checkout_url
    B->>DB: Create Payment (PENDING)
    B->>DB: Create Tentative Appointment
    B-->>F: {checkoutUrl: "..."}
    F->>U: Redirect to Razorpay
    U->>G: Complete Payment
    G->>B: POST /api/webhooks/razorpay
    B->>B: Verify Signature
    B->>DB: Update Payment (SUCCEEDED)
    B->>B: confirmExistingAppointment()
    B->>DB: Set slots isTentative=false
    G-->>U: Redirect to success page
    Note over U,DB: Total time: User-dependent
```

---

## Cleanup Mechanisms

### Cleanup Job Overview

The cleanup job runs every **15 minutes** via GitHub Actions and handles two scenarios:

```mermaid
flowchart TD
    subgraph "Cleanup Job (every 15 min)"
        START([Job Starts]) --> FIND_ABANDONED[Find Abandoned Appointments]

        FIND_ABANDONED --> CHECK{Has Expired<br/>Pending Payment?}
        CHECK --> |"Yes"| RECHECK[Re-check Payment Status<br/>Prevent Race Condition]
        CHECK --> |"No"| SKIP[Skip]

        RECHECK --> STILL_PENDING{Still<br/>PENDING?}
        STILL_PENDING --> |"No - Succeeded"| SKIP
        STILL_PENDING --> |"Yes"| CANCEL[Cancel Payment Intent<br/>with Gateway]

        CANCEL --> UPDATE_PAYMENT[Payment → FAILED]
        UPDATE_PAYMENT --> DELETE_SLOTS[Delete Tentative Slots]
        DELETE_SLOTS --> CHECK_CONFIRMED{Has Confirmed<br/>Slots?}
        CHECK_CONFIRMED --> |"No"| DELETE_ALL[Delete Appointment<br/>+ Consultation/Subscription]
        CHECK_CONFIRMED --> |"Yes"| KEEP[Keep Appointment<br/>Only Remove Tentative]
    end

    subgraph "Expired Approval Cleanup"
        FIND_EXPIRED[Find APPROVED_PENDING_PAYMENT<br/>with Expired Payments] --> RESET[Reset to REJECTED]
        RESET --> DELETE_TENT[Delete Tentative Slots]
        DELETE_TENT --> MARK_FAILED[Mark Payments FAILED]
    end

    style CANCEL fill:#FF6B6B
    style DELETE_ALL fill:#FF6B6B
    style RESET fill:#FFA500
```

### Cleanup Timing

| Scenario                     | Timeout                                | Cleanup Action               |
| ---------------------------- | -------------------------------------- | ---------------------------- |
| Direct payment abandoned     | 30 min (explicit) or 35 min (fallback) | Delete appointment + payment |
| Pay Later payment expired    | 48 hours                               | Reset to REJECTED            |
| Mock payment (never expires) | N/A                                    | Same cleanup if abandoned    |

### Files Involved

| File                                          | Purpose                         |
| --------------------------------------------- | ------------------------------- |
| `jobs/cleanup-abandoned-payments.ts`          | Main cleanup job                |
| `app/api/cleanup/abandoned-payments/route.ts` | API endpoint for manual trigger |
| `app/api/cleanup/approval-payments/route.ts`  | Revert APPROVED_PENDING_PAYMENT |

---

## Quick Reference: Status After Each Action

| Event Type       | After Checkout      | After Payment | After Slot Allocation | After Event |
| ---------------- | ------------------- | ------------- | --------------------- | ----------- |
| **Consultation** | PENDING             | APPROVED      | N/A                   | COMPLETED\* |
| **Subscription** | PENDING             | PENDING       | APPROVED              | COMPLETED\* |
| **Webinar**      | N/A (pre-scheduled) | User joins    | N/A                   | COMPLETED   |
| **Class**        | N/A (pre-scheduled) | User enrolls  | N/A                   | COMPLETED   |

\*Consultation/Subscription don't have a formal COMPLETED status - they're marked via meeting completion.
