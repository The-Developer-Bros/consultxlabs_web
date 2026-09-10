# Payments Documentation

Complete documentation for the Familiarise payment system — checkout, gateways, refunds, disputes, payouts, webhooks, and more.

> For business-level financial docs (revenue strategy, pricing, metrics, taxes), see [finances/](../finances/).

---

## Overview

| #   | Document                                                 | Description                                                                                |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 01  | [Architecture](./01-architecture.md)                     | System design, database models, complete data flow                                         |
| 02  | [Setup](./02-setup.md)                                   | Payment gateway configuration, environment variables                                       |
| 03  | [Status Enums Reference](./03-status-enums-reference.md) | All payment, refund, dispute, and booking status values                                    |
| 04  | [Abandoned Solutions](./04-abandoned-solutions.md)       | Previous approaches and why they were abandoned                                            |
| 05  | [B2C/B2B Funding Seam](./05-b2c-b2b-funding-seam.md)     | Where the consumer and organisation funding paths meet and diverge                         |
| 06  | [High-Level Design](./06-high-level-design.md)           | Four Mermaid diagrams: B2C payment, refunds and payouts, B2B funding, cross-cutting layers |
| 07  | [B2C Tax Invoices](./07-b2c-tax-invoice.md)              | Consumer tax invoices, credit notes, and the outward-supplies register                     |

## Subsections

| Section                                                       | Description                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| [Checkout Flow](./checkout-flow/)                             | 4 appointment types, payment processing, edge cases        |
| [Gateways](./gateways/)                                       | Stripe and Razorpay setup, architecture, KYC               |
| [Approval Payments](./approval-payments/)                     | Consultant-approves-first workflow (formerly "pay later")  |
| [Refunds & Disputes](./refunds-disputes/)                     | Two-phase refund pattern, dispute lifecycle                |
| [Cancellations & Rescheduling](./cancellations-rescheduling/) | Refund triggers, payment reuse on reschedule               |
| [Payouts](./payouts/)                                         | Earnings lifecycle, batch processing, gateway disbursement |
| [Webhooks](./webhooks/)                                       | Monitoring, Razorpay webhook schema                        |
