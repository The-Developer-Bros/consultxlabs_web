# Novu Dashboard — Workflow Template Specs

> Copy-paste-ready specs for configuring all Tier 1 workflows in the Novu Dashboard.
> Each workflow ID must match `lib/novu/workflows.ts` exactly.

**Status**: Ready for Configuration
**Created**: 2026-03-24
**Source of Truth**: `lib/novu/workflows.ts` (payload types)

> **Payload values are customer-ready before they reach a template (#536).** Every field named below without a unit suffix already holds the string a person should read: `dateTime` is a sentence in the recipient's own timezone, `amount` is formatted money including its currency symbol, and `appointmentType` is a label rather than an enum member. The machine-readable original travels alongside under a unit-suffixed name (`dateTimeIso`, `amountPaise`, `appointmentTypeCode`). See "Payload conventions" in `02-workflows-and-api.md` for the full rule. A template must never format a date itself. The one exception to "print the field as-is" is money: the four templates that already render `{{payload.currency}} {{payload.amount}}` receive `amount` with the symbol stripped, so they keep printing the ISO code and read correctly; every other money template gets the symbol inside `amount` and must not print a currency code beside it.

## Source of truth

The in-app templates described below are generated from `lib/novu/templates/` and written to the Novu environment by `scripts/novu/sync-workflows.ts`. The environment itself holds one workflow per family rather than one workflow per event, with a Liquid `case` over `payload.event` selecting the branch for the triggering event (see ADR 30, `docs/enterprise/70-design-decisions/30-novu-templates-as-code-and-workflow-families.md`). The per-workflow sections below describe the email bodies that go with each event; those are not yet created as steps in any family and must be written in Liquid, not Handlebars, when they are.

---

## Table of Contents

- [Setup: Resend Integration](#setup-resend-integration)
- [Setup: Preference Categories](#setup-preference-categories)
- [Workflow Specs](#workflow-specs)
  - [1. appointment-booked](#1-appointment-booked)
  - [2. appointment-cancelled](#2-appointment-cancelled)
  - [3. appointment-reminder](#3-appointment-reminder)
  - [4. payment-success](#4-payment-success)
  - [5. payment-failed](#5-payment-failed)
  - [6. new-booking-request](#6-new-booking-request)
  - [7. subscription-started](#7-subscription-started)
  - [8. subscription-cancelled](#8-subscription-cancelled)
  - [9. trial-session-requested](#9-trial-session-requested)
  - [10. trial-session-scheduled](#10-trial-session-scheduled)
  - [11. trial-session-completed](#11-trial-session-completed)
  - [12. trial-session-cancelled](#12-trial-session-cancelled)
  - [13. support-ticket-created](#13-support-ticket-created)
  - [14. support-ticket-update](#14-support-ticket-update)
  - [15. support-ticket-activity](#15-support-ticket-activity)
  - [16. support-ticket-response](#16-support-ticket-response)
  - [17. new-review-received](#17-new-review-received)
  - [18. verification-status-changed](#18-verification-status-changed)

---

## Setup: Resend Integration

1. Go to **Novu Dashboard → Integrations → Email**
2. Select **Resend** as provider
3. Configure:
   - **API Key**: Your `RESEND_API_KEY`
   - **From Email**: `notifications@familiarise.com`
   - **From Name**: `Familiarise`
4. Save and activate

---

## Setup: Preference Categories

The opt-out categories below are no longer per-workflow settings; they are tags carried by a workflow family, written by the sync from `PreferenceCategory` in `lib/novu/templates/types.ts` and applied to every event in that family. The table names the events each category currently covers.

| Category ID     | Display Name                | Mapped Workflows                                                                                   |
| --------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `appointments`  | Appointment Notifications   | appointment-booked, appointment-cancelled, appointment-reminder, new-booking-request               |
| `payments`      | Payment Notifications       | payment-success, payment-failed                                                                    |
| `subscriptions` | Subscription Notifications  | subscription-started, subscription-cancelled                                                       |
| `trials`        | Trial Session Notifications | trial-session-requested, trial-session-scheduled, trial-session-completed, trial-session-cancelled |
| `support`       | Support Updates             | support-ticket-created, support-ticket-update, support-ticket-activity, support-ticket-response    |
| `feedback`      | Feedback & Reviews          | new-review-received                                                                                |

`verification-status-changed` is a system notification — no opt-out category (always sends).

### Workflow families

The Novu environment holds one workflow per family, not one per event; a family groups events that share an audience and an opt-out switch, and the sixteen families are defined in `EVENT_FAMILY` in `lib/novu/templates/families.ts`. The table below lists every family and the events it carries.

| Family ID        | Events                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appointment`    | appointment-booked, appointment-partially-scheduled, appointment-cancelled, appointment-rescheduled, appointment-reminder, appointment-completed, new-booking-request                                                      |
| `session-media`  | recording-available, recording-failed, recording-expiring, document-uploaded, document-reviewed                                                                                                                            |
| `payment`        | payment-success, payment-failed, referral-credits-applied                                                                                                                                                                  |
| `refund`         | refund-requested, refund-processed, refund-failed, dispute-created, dispute-resolved                                                                                                                                       |
| `payout`         | payout-processed                                                                                                                                                                                                           |
| `referral`       | referral-bonus-earned, referee-welcome-bonus                                                                                                                                                                               |
| `subscription`   | subscription-started, subscription-cancelled, subscription-renewed                                                                                                                                                         |
| `trial`          | trial-session-requested, trial-session-scheduled, trial-session-completed, trial-session-cancelled                                                                                                                         |
| `support-ticket` | support-ticket-created, support-ticket-activity, support-ticket-update, support-ticket-response                                                                                                                            |
| `feedback`       | feedback-received, new-review-received                                                                                                                                                                                     |
| `account`        | verification-status-changed, new-consultant-application, moderation-warning, account-suspended, account-banned                                                                                                             |
| `collaborator`   | collaborator-invited, collaborator-accepted, collaborator-removed, collaborator-declined, collaborator-withdrawn                                                                                                           |
| `platform`       | general-announcement, maintenance-scheduled, maintenance-started, maintenance-ended                                                                                                                                        |
| `org-billing`    | org-invoice-issued, org-invoice-paid, org-invoice-overdue, org-wallet-topup-confirmed, org-wallet-low, org-payout-completed, org-payout-failed, org-payout-reversed, org-member-overage-timed-out, org-program-overage-due |
| `org-membership` | org-invite-sent, org-invite-accepted, org-expert-removed, org-sso-provider-deleted, org-sso-cert-expiring                                                                                                                  |
| `org-program`    | org-program-exhausted, org-program-cap-near, org-license-renewal-upcoming, org-data-export-ready                                                                                                                           |

---

## Design Notes

All email templates follow the existing Familiarise email design language:

- **Background**: `#f5f5f5`
- **Content card**: White (`#ffffff`), `30px` padding, `5px` border-radius
- **Heading**: `28px` bold, `#333`
- **Body text**: `16px`, `#444`, `1.5` line-height
- **CTA button**: Black (`#000000`) background, white text, `5px` border-radius, `12px 20px` padding
- **Footer**: `12px`, `#666`, centered, includes "© 2026 Familiarise" + privacy/terms links
- **Font family**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`

In the Novu editor, replicate this using their visual builder or paste the HTML snippets below into the "Custom Code" mode.

---

## Workflow Specs

### 1. appointment-booked

**Workflow ID**: `appointment-booked`
**Trigger function**: `notifyAppointmentBooked(userIds[], payload)`
**Recipient**: Both consultant and consultee
**Preference category**: `appointments`

**Payload variables** (`AppointmentPayload`):

```
{{payload.appointmentId}}     - Appointment ID
{{payload.appointmentType}}   - "consultation" | "subscription session" | "webinar" | "class" | "trial session"
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan/service title
{{payload.dateTime}}           - Recipient-zone date/time, e.g. "Sat, 6 Sep 2026 · 7:53 AM IST"
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
Your {{payload.appointmentType}} for {{payload.planTitle}} is booked{% if payload.dateTime %} for {{payload.dateTime}}{% endif %}.
```

**Email subject**:

```
Booking Confirmed — {{payload.planTitle}}
```

**Email body** (not yet created as a step; write it in Liquid when it is):

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Booking Confirmed!
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Your {{payload.appointmentType}} <strong>"{{payload.planTitle}}"</strong> has
  been successfully booked.
</p>

<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultant</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consultantName}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultee</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consulteeName}}
    </td>
  </tr>
  {% if payload.dateTime %}
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Date & Time</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.dateTime}}
    </td>
  </tr>
  {% endif %}
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Type</td>
    <td
      style="padding:8px 0;color:#333;font-size:14px;font-weight:600;text-transform:capitalize"
    >
      {{payload.appointmentType}}
    </td>
  </tr>
</table>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View in Dashboard
  </a>
</div>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  You'll receive a reminder before your session. If you need to make changes,
  visit your dashboard.
</p>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 2. appointment-cancelled

**Workflow ID**: `appointment-cancelled`
**Trigger function**: `notifyAppointmentCancelled(userIds[], payload)`
**Recipient**: Both consultant and consultee
**Preference category**: `appointments`

**Payload variables** (`AppointmentCancelledPayload`):

```
{{payload.appointmentId}}     - Appointment ID
{{payload.appointmentType}}   - "consultation" | "subscription session" | "webinar" | "class" | "trial session"
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan/service title
{{payload.dateTime}}           - Original date/time, rendered in the recipient's timezone
{{payload.dashboardUrl}}       - Link to dashboard
{{payload.reason}}             - Cancellation reason. Always present — "No reason given" when there is none
{{payload.cancelledBy}}        - Who cancelled, as a name or "The platform". Capitalised: it opens the sentence
{{payload.cancelledByRole}}    - "consultant" | "consultee" | "system" (for branching)
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
{{payload.cancelledBy}} cancelled the {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %}. Reason: {{payload.reason}}.
```

**Email subject**:

```
Appointment Cancelled — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Appointment Cancelled
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Your {{payload.appointmentType}} <strong>"{{payload.planTitle}}"</strong> was
  cancelled by {{payload.cancelledBy}}.
</p>

{% if payload.reason %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>Reason:</strong> {{payload.reason}}
</p>
{% endif %}

<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultant</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consultantName}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultee</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consulteeName}}
    </td>
  </tr>
  {% if payload.dateTime %}
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Original Date</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.dateTime}}
    </td>
  </tr>
  {% endif %}
</table>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  If a refund is applicable, it will be processed automatically. Visit your
  dashboard for details.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View Details
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 3. appointment-reminder

**Workflow ID**: `appointment-reminder`
**Trigger function**: `notifyAppointmentReminder(userIds[], payload)`
**Recipient**: Both consultant and consultee
**Preference category**: `appointments`

**Payload variables** (`AppointmentPayload`):

```
{{payload.appointmentType}}   - "consultation" | "subscription session" | "webinar" | "class" | "trial session"
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan/service title
{{payload.dateTime}}           - Upcoming date/time, rendered in the recipient's timezone
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
Your {{payload.appointmentType}} for {{payload.planTitle}} is coming up — {{payload.dateTime}}.
```

**Email subject**:

```
Reminder — {{payload.planTitle}} is coming up
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Your Session is Coming Up
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  This is a friendly reminder that your {{payload.appointmentType}}
  <strong>"{{payload.planTitle}}"</strong> is scheduled for
  <strong>{{payload.dateTime}}</strong>.
</p>

<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultant</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consultantName}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultee</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consulteeName}}
    </td>
  </tr>
</table>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Make sure you're ready and have a stable internet connection. The session will
  be accessible from your dashboard.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Go to Dashboard
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 4. payment-success

**Workflow ID**: `payment-success`
**Trigger function**: `notifyPaymentSuccess(userId, payload)`
**Recipient**: Payer (consultee)
**Preference category**: `payments`

**Payload variables** (`PaymentSuccessPayload`):

```
{{payload.amount}}            - Localised figure without a symbol, e.g. "55,679.48"
{{payload.amountFormatted}}   - The same figure with the symbol, e.g. "₹55,679.48"
{{payload.amountPaise}}       - The same amount in integer minor units
{{payload.currency}}          - Currency code (e.g., "INR", "USD") — printed before {{payload.amount}}
{{payload.consultantName}}    - Consultant display name
{{payload.appointmentType}}   - Service label, e.g. "consultation"
{{payload.planTitle}}          - Plan title
{{payload.receiptUrl}}         - Receipt URL (optional)
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
Payment of {{payload.amountFormatted}} received for {{payload.planTitle}} with {{payload.consultantName}}.
```

**Email subject**:

```
Payment Confirmed — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Payment Confirmed
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Your payment has been successfully processed.
</p>

<table
  style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#f9f9f9;border-radius:5px;padding:15px"
>
  <tr>
    <td style="padding:8px 15px;color:#666;font-size:14px">Amount</td>
    <td style="padding:8px 15px;color:#333;font-size:14px;font-weight:600">
      {{payload.currency}} {{payload.amount}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 15px;color:#666;font-size:14px">Service</td>
    <td style="padding:8px 15px;color:#333;font-size:14px;font-weight:600">
      {{payload.planTitle}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 15px;color:#666;font-size:14px">Consultant</td>
    <td style="padding:8px 15px;color:#333;font-size:14px;font-weight:600">
      {{payload.consultantName}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 15px;color:#666;font-size:14px">Type</td>
    <td
      style="padding:8px 15px;color:#333;font-size:14px;font-weight:600;text-transform:capitalize"
    >
      {{payload.appointmentType}}
    </td>
  </tr>
</table>

{% if payload.receiptUrl %}
<p style="font-size:14px;line-height:1.5;color:#666;margin:0 0 20px">
  <a href="{{payload.receiptUrl}}" style="color:#000;text-decoration:underline"
    >Download Receipt</a
  >
</p>
{% endif %}

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View in Dashboard
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 5. payment-failed

**Workflow ID**: `payment-failed`
**Trigger function**: `notifyPaymentFailed(userId, payload)`
**Recipient**: Payer (consultee)
**Preference category**: `payments`

**Payload variables** (`PaymentFailedPayload`):

```
{{payload.amount}}            - Localised figure without a symbol, e.g. "55,679.48"
{{payload.amountFormatted}}   - The same figure with the symbol, e.g. "₹55,679.48"
{{payload.amountPaise}}       - The same amount in integer minor units
{{payload.currency}}          - Currency code — printed before {{payload.amount}}
{{payload.consultantName}}    - Consultant display name
{{payload.appointmentType}}   - Service label, e.g. "consultation"
{{payload.planTitle}}          - Plan title (optional)
{{payload.failureReason}}      - Reason for failure
{{payload.retryUrl}}           - Retry URL (optional)
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
Your payment of {{payload.amountFormatted}}{% if payload.planTitle %} for {{payload.planTitle}}{% endif %} did not go through. {{payload.failureReason}}
```

**Email subject**:

```
Payment Failed — Action Required
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Payment Failed
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Unfortunately, your payment could not be processed.
</p>

<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Amount</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.currency}} {{payload.amount}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Consultant</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.consultantName}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Reason</td>
    <td style="padding:8px 0;color:#c00;font-size:14px;font-weight:600">
      {{payload.failureReason}}
    </td>
  </tr>
</table>

{% if payload.retryUrl %}
<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.retryUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Retry Payment
  </a>
</div>
{% endif %}

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Please check your payment method and try again. If the issue persists, contact
  our support team.
</p>
```

**Redirect URL**: `{{payload.retryUrl}}`

---

### 6. new-booking-request

**Workflow ID**: `new-booking-request`
**Trigger function**: `notifyNewBookingRequest(consultantUserId, payload)`
**Recipient**: Consultant only
**Preference category**: `appointments`

**Payload variables** (`BookingRequestPayload`):

```
{{payload.consulteeName}}      - Consultee display name
{{payload.planTitle}}           - Plan title
{{payload.appointmentType}}    - "consultation" | "subscription session"
{{payload.requestedDateTime}}  - Requested date/time, rendered in the recipient's timezone (optional)
{{payload.dashboardUrl}}        - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
{{payload.consulteeName}} requested a {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.requestedDateTime %} on {{payload.requestedDateTime}}{% endif %}.
```

**Email subject**:

```
New Booking Request — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  New Booking Request
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  You've received a new {{payload.appointmentType}} request from
  <strong>{{payload.consulteeName}}</strong> for
  <strong>"{{payload.planTitle}}"</strong>.
</p>

{% if payload.requestedDateTime %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>Requested time:</strong> {{payload.requestedDateTime}}
</p>
{% endif %}

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Please review and approve or decline this request from your dashboard.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Review Request
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 7. subscription-started

**Workflow ID**: `subscription-started`
**Trigger function**: `notifySubscriptionStarted(userId, payload)`
**Recipient**: Subscriber (consultee)
**Preference category**: `subscriptions`

**Payload variables** (`SubscriptionPayload`):

```
{{payload.subscriptionId}}    - Subscription ID (optional)
{{payload.planTitle}}          - Plan title
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name (optional)
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
Your subscription to {{payload.planTitle}} with {{payload.consultantName}} is now active.
```

**Email subject**:

```
Subscription Active — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Subscription Started
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Your subscription to <strong>"{{payload.planTitle}}"</strong> with
  <strong>{{payload.consultantName}}</strong> is now active.
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  You can now book sessions, access resources, and manage your subscription from
  your dashboard.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Go to Dashboard
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 8. subscription-cancelled

**Workflow ID**: `subscription-cancelled`
**Trigger function**: `notifySubscriptionCancelled(userIds[], payload)`
**Recipient**: Both consultant and consultee
**Preference category**: `subscriptions`

**Payload variables** (`SubscriptionPayload`):

```
{{payload.planTitle}}          - Plan title
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name (optional)
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
The subscription to {{payload.planTitle}} has been cancelled.
```

**Email subject**:

```
Subscription Cancelled — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Subscription Cancelled
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  The subscription <strong>"{{payload.planTitle}}"</strong> with
  <strong>{{payload.consultantName}}</strong> has been cancelled.
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Any remaining sessions in the current billing period are still available.
  Visit your dashboard for details.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View Details
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 9. trial-session-requested

**Workflow ID**: `trial-session-requested`
**Trigger function**: `notifyTrialSessionRequested(consultantUserId, payload)`
**Recipient**: Consultant only
**Preference category**: `trials`

**Payload variables** (`TrialSessionPayload`):

```
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan title
{{payload.dateTime}}           - Requested date/time, rendered in the recipient's timezone (optional)
{{payload.status}}             - Current status
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
{{payload.consulteeName}} requested a free trial session for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %}.
```

**Email subject**:

```
New Trial Request — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Trial Session Requested
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>{{payload.consulteeName}}</strong> has requested a trial session for
  <strong>"{{payload.planTitle}}"</strong>.
</p>

{% if payload.dateTime %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>Preferred time:</strong> {{payload.dateTime}}
</p>
{% endif %}

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Review and schedule this trial from your dashboard. Trial sessions are a great
  way to convert potential clients.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Review Trial Request
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 10. trial-session-scheduled

**Workflow ID**: `trial-session-scheduled`
**Trigger function**: `notifyTrialSessionScheduled(consulteeUserId, payload)`
**Recipient**: Consultee only
**Preference category**: `trials`

**Payload variables** (`TrialSessionPayload`):

```
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan title
{{payload.dateTime}}           - Scheduled date/time, rendered in the recipient's timezone
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
The trial session for {{payload.planTitle}} between {{payload.consulteeName}} and {{payload.consultantName}} is scheduled for {{payload.dateTime}}.
```

**Email subject**:

```
Trial Scheduled — {{payload.planTitle}} with {{payload.consultantName}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Trial Session Scheduled
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Great news! Your trial session for
  <strong>"{{payload.planTitle}}"</strong> with
  <strong>{{payload.consultantName}}</strong> has been scheduled.
</p>

{% if payload.dateTime %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>Date & Time:</strong> {{payload.dateTime}}
</p>
{% endif %}

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Make sure you have a stable internet connection. You can join the session from
  your dashboard when it's time.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View Session Details
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 11. trial-session-completed

**Workflow ID**: `trial-session-completed`
**Trigger function**: `notifyTrialSessionCompleted(userIds[], payload)`
**Recipient**: Both parties
**Preference category**: `trials`

**Payload variables** (`TrialSessionPayload`):

```
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan title
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
The trial session for {{payload.planTitle}} with {{payload.consultantName}} has ended.
```

**Email subject**:

```
Trial Completed — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Trial Session Completed
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Your trial session for <strong>"{{payload.planTitle}}"</strong> has been
  completed. We hope you found it valuable!
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Ready to continue? You can book the full service from your dashboard.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Book Full Session
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 12. trial-session-cancelled

**Workflow ID**: `trial-session-cancelled`
**Trigger function**: `notifyTrialSessionCancelled(userIds[], payload)`
**Recipient**: Both parties
**Preference category**: `trials`

**Payload variables** (`TrialSessionPayload`):

```
{{payload.consultantName}}    - Consultant display name
{{payload.consulteeName}}     - Consultee display name
{{payload.planTitle}}          - Plan title
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
The trial session for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %} was cancelled.
```

**Email subject**:

```
Trial Cancelled — {{payload.planTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Trial Session Cancelled
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  The trial session for <strong>"{{payload.planTitle}}"</strong> has been
  cancelled.
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  You can request a new trial or explore other options from your dashboard.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Explore Options
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 13. support-ticket-created

**Workflow ID**: `support-ticket-created`
**Trigger function**: `notifySupportTicketCreated(staffUserIds[], payload)`
**Recipient**: Staff members
**Preference category**: `support`

**Payload variables** (`SupportTicketPayload`):

```
{{payload.ticketId}}          - Ticket ID
{{payload.reference}}         - Human-facing ticket reference, e.g. "FAM-2026-000007" (optional)
{{payload.ticketTitle}}       - Ticket subject
{{payload.status}}            - Sentence fragment, e.g. "in progress" (optional)
{{payload.statusCode}}        - Raw status enum, for branching (optional)
{{payload.userName}}          - The customer who opened or acted on the ticket (optional)
{{payload.activity}}          - "replied" | "reopened" (optional; SUPPORT_TICKET_ACTIVITY only)
{{payload.message}}           - Ticket body (optional)
{{payload.dashboardUrl}}       - Link to staff dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim; `TICKET` is `{% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}`):

```
{{payload.userName | default: "A customer"}} opened {% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}.
```

**Email subject**:

```
New Support Ticket — {{payload.ticketTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  New Support Ticket
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  A new support ticket has been submitted.
</p>

<table style="width:100%;border-collapse:collapse;margin:0 0 20px">
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Ticket ID</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.ticketId}}
    </td>
  </tr>
  <tr>
    <td style="padding:8px 0;color:#666;font-size:14px">Subject</td>
    <td style="padding:8px 0;color:#333;font-size:14px;font-weight:600">
      {{payload.ticketTitle}}
    </td>
  </tr>
</table>

{% if payload.message %}
<div
  style="background:#f9f9f9;border-left:3px solid #ddd;padding:15px;margin:0 0 20px;font-size:14px;color:#555"
>
  {{payload.message}}
</div>
{% endif %}

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View Ticket
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 14. support-ticket-update

**Workflow family**: `support-ticket`
**Trigger function**: `notifySupportTicketUpdate(userId, payload)`
**Recipient**: The ticket's owner, when ops changes its status
**Preference category**: `support`

**Payload variables** (`SupportTicketPayload`):

```
{{payload.ticketId}}          - Ticket ID
{{payload.reference}}         - Human-facing ticket reference, e.g. "FAM-2026-000007" (optional)
{{payload.ticketTitle}}       - Ticket subject
{{payload.status}}            - Sentence fragment, e.g. "in progress"
{{payload.statusCode}}        - Raw status enum, for branching (optional)
{{payload.userName}}          - The ticket's owner (optional)
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim; `TICKET` is `{% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}`):

```
Your ticket {% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}} is now {{payload.status}}.
```

**Email subject** (not yet created as a step):

```
Update on Your Ticket — {{payload.ticketTitle}}
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 15. support-ticket-activity

**Workflow family**: `support-ticket`
**Trigger function**: `notifySupportTicketActivity(staffUserIds[], payload, dedupeKey?)`
**Recipient**: The ticket's assignee, or the whole staff queue if there is none, when the customer replies or reopens
**Preference category**: `support`

**Payload variables** (`SupportTicketPayload`):

```
{{payload.ticketId}}          - Ticket ID
{{payload.reference}}         - Human-facing ticket reference, e.g. "FAM-2026-000007" (optional)
{{payload.ticketTitle}}       - Ticket subject
{{payload.userName}}          - The customer who replied or reopened (optional)
{{payload.activity}}          - "replied" | "reopened" (optional)
{{payload.dashboardUrl}}       - Link to staff dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim; `TICKET` is `{% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}`):

```
{{payload.userName | default: "The customer"}} {{payload.activity | default: "replied"}} on {% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}.
```

**Email subject** (not yet created as a step):

```
Ticket Activity — {{payload.ticketTitle}}
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 16. support-ticket-response

**Workflow ID**: `support-ticket-response`
**Trigger function**: `notifySupportTicketResponse(userId, payload)`
**Recipient**: Ticket creator (user)
**Preference category**: `support`

**Payload variables** (`SupportTicketPayload`):

```
{{payload.ticketId}}          - Ticket ID
{{payload.reference}}         - Human-facing ticket reference, e.g. "FAM-2026-000007" (optional)
{{payload.ticketTitle}}       - Ticket subject
{{payload.statusCode}}        - Raw status enum, for branching (optional)
{{payload.userName}}          - The ticket's owner (optional)
{{payload.message}}           - Response content (optional)
{{payload.respondedBy}}       - Staff member name (optional)
{{payload.dashboardUrl}}       - Link to user dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim; `TICKET` is `{% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}`):

```
{{payload.respondedBy | default: "Support"}} replied on {% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}{% if payload.message %}: "{{payload.message | truncate: 140}}"{% endif %}
```

**Email subject**:

```
Update on Your Ticket — {{payload.ticketTitle}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Support Ticket Update
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  There's a new response on your support ticket
  <strong>"{{payload.ticketTitle}}"</strong>.
</p>

{% if payload.respondedBy %}
<p style="font-size:14px;line-height:1.5;color:#666;margin:0 0 10px">
  <em>Response from {{payload.respondedBy}}:</em>
</p>
{% endif %} {% if payload.message %}
<div
  style="background:#f9f9f9;border-left:3px solid #ddd;padding:15px;margin:0 0 20px;font-size:14px;color:#555"
>
  {{payload.message}}
</div>
{% endif %}

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View Full Thread
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 17. new-review-received

**Workflow ID**: `new-review-received`
**Trigger function**: `notifyNewReview(consultantUserId, payload)`
**Recipient**: Consultant only
**Preference category**: `feedback`

**Payload variables** (`ReviewPayload`):

```
{{payload.reviewerName}}      - Reviewer display name
{{payload.rating}}            - Rating (1-5)
{{payload.comment}}           - Review text (optional)
{{payload.planTitle}}          - Plan title (optional)
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
{{payload.reviewerName}} left a {{payload.rating}}-star review{% if payload.planTitle %} on {{payload.planTitle}}{% endif %}{% if payload.comment %}: "{{payload.comment | truncate: 140}}"{% endif %}
```

**Email subject**:

```
New Review — {{payload.rating}} Stars from {{payload.reviewerName}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  New Review Received
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>{{payload.reviewerName}}</strong> just left you a review!
</p>

<div style="text-align:center;margin:20px 0;font-size:24px">
  {{payload.rating}} / 5 Stars
</div>

{% if payload.planTitle %}
<p style="font-size:14px;line-height:1.5;color:#666;margin:0 0 10px">
  For: <strong>{{payload.planTitle}}</strong>
</p>
{% endif %} {% if payload.comment %}
<div
  style="background:#f9f9f9;border-left:3px solid #ddd;padding:15px;margin:0 0 20px;font-size:14px;color:#555;font-style:italic"
>
  "{{payload.comment}}"
</div>
{% endif %}

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Reviews help build trust with potential clients. View your full review history
  in your dashboard.
</p>

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    View Reviews
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

### 18. verification-status-changed

**Workflow ID**: `verification-status-changed`
**Trigger function**: `notifyVerificationStatusChanged(consultantUserId, payload)`
**Recipient**: Consultant only
**Preference category**: None (system notification — always sends)

**Payload variables** (`VerificationPayload`):

```
{{payload.status}}            - "VERIFIED" | "REJECTED" | "PENDING_VERIFICATION" (the profile enum after the routes map APPROVED→VERIFIED and NEEDS_INFO→PENDING_VERIFICATION)
{{payload.reason}}            - Reason for status change (optional)
{{payload.dashboardUrl}}       - Link to dashboard
```

**In-App notification** (`lib/novu/templates/b2c.ts`, verbatim):

```
{% case payload.status %}{% when "VERIFIED" %}Your profile is verified and now visible to clients.{% when "REJECTED" %}Your profile verification was not approved.{% else %}Your profile verification is pending review.{% endcase %}{% if payload.reason %} {{payload.reason}}{% endif %}
```

**Email subject**:

```
Verification Update — {{payload.status}}
```

**Email body**:

```html
<h1 style="font-size:28px;font-weight:bold;color:#333;margin:0 0 20px">
  Verification Status Update
</h1>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Hi {{subscriber.firstName}},
</p>

<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Your consultant verification status has been updated to:
  <strong>{{payload.status}}</strong>.
</p>

{% if payload.reason %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  <strong>Details:</strong> {{payload.reason}}
</p>
{% endif %} {% if payload.status == "APPROVED" %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Congratulations! Your profile is now verified and visible to potential
  clients. Start creating your service plans to begin receiving bookings.
</p>
{% endif %} {% if payload.status == "REJECTED" %}
<p style="font-size:16px;line-height:1.5;color:#444;margin:0 0 20px">
  Please review the feedback and update your profile accordingly. You can
  resubmit for verification from your dashboard.
</p>
{% endif %}

<div style="text-align:center;margin:30px 0">
  <a
    href="{{payload.dashboardUrl}}"
    style="background-color:#000;border-radius:5px;color:#fff;font-size:16px;text-decoration:none;padding:12px 20px;display:inline-block"
  >
    Go to Dashboard
  </a>
</div>
```

**Redirect URL**: `{{payload.dashboardUrl}}`

---

## Quick Reference: All Workflow IDs

```
appointment-booked
appointment-cancelled
appointment-reminder
payment-success
payment-failed
new-booking-request
subscription-started
subscription-cancelled
trial-session-requested
trial-session-scheduled
trial-session-completed
trial-session-cancelled
support-ticket-created
support-ticket-update
support-ticket-activity
support-ticket-response
new-review-received
verification-status-changed
```

## Next: Tier 2 Workflows (Post-Launch)

These need Dashboard configuration after Tier 1 is done:

- `appointment-rescheduled` — AppointmentRescheduledPayload
- `appointment-completed` — AppointmentPayload
- `appointment-partially-scheduled` — AppointmentPartiallyScheduledPayload (#1206). Consultee only, fired alongside `appointment-booked` when a consultant accepts a partial allocation. The copy must name `placedSessions` of `requiredSessions` and say the remaining `unplacedSessions` are still to be timed.
- `refund-processed` — RefundPayload
- `payout-processed` — PayoutPayload
- `collaborator-invited` — CollaboratorInvitedPayload
- `collaborator-accepted` — CollaboratorAcceptedPayload
- `collaborator-removed` — CollaboratorRemovedPayload
- `collaborator-declined` — CollaboratorDeclinedPayload (#1580 C-P1-5). In-app + email to the host when an invitee declines; the same shape as `collaborator-accepted`.
- `collaborator-withdrawn` — CollaboratorWithdrawnPayload (#1580 C-P1-7). In-app + email to the HOST when a collaborator withdraws their own pending or accepted row; the payload is the removed shape plus `collaboratorName`, so the copy can say who left.
- `new-consultant-application` — ConsultantApplicationPayload
- `document-uploaded` — DocumentUploadedPayload (`lib/novu/workflows.ts`). In-app + email to the reviewer (consultant) on a new submission, or to the uploader on a consultant response. Payload carries `versionNo` + `isThreaded` so copy can say "Revision v3 uploaded" vs "New document".
- `document-reviewed` — DocumentReviewedPayload. In-app to the consultee when their submission moves status; templates branch on `reviewStatus` (APPROVED / REJECTED / NEEDS_REVISION / IN_REVIEW). Both workflows must exist in the Novu dashboard with matching slugs before enabling in production.
