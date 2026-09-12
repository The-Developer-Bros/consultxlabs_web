/**
 * In-app copy for the organisation workflows (ADR 23). Categories follow the
 * audience, per docs/enterprise/50-operations/09-novu-console-conditions.md:
 * an operator who wants invoices but not roster churn, and an expert who
 * wants the reverse, are the two cases the split serves.
 */

import { NOVU_WORKFLOWS as W } from "../workflows";
import type { WorkflowTemplate } from "./types";

export const ORG_TEMPLATES: WorkflowTemplate[] = [
  // ── Billing ─────────────────────────────────────────────────────────────
  {
    workflowId: W.ORG_INVOICE_ISSUED,
    name: "Org invoice issued",
    description: "Billing admins, when an invoice is raised.",
    category: "orgBilling",
    inApp: {
      subject: "Invoice issued",
      body: "Invoice {{payload.invoiceNumber}} for {{payload.total}} is due on {{payload.dueDate}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_INVOICE_PAID,
    name: "Org invoice paid",
    description: "Billing admins, when payment settles an invoice.",
    category: "orgBilling",
    inApp: {
      subject: "Invoice paid",
      body: "Invoice {{payload.invoiceNumber}} for {{payload.total}} was paid on {{payload.paidAt}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_INVOICE_OVERDUE,
    name: "Org invoice overdue",
    description: "Billing admins. `reminderStage` counts the dunning notices.",
    category: "orgBilling",
    inApp: {
      subject: "Invoice overdue",
      body: "Invoice {{payload.invoiceNumber}} for {{payload.total}} is {{payload.daysLate}} day{% if payload.daysLate != 1 %}s{% endif %} overdue.{% if payload.reminderStage > 1 %} This is reminder {{payload.reminderStage}}.{% endif %}",
      redirect: "payUrl",
    },
  },
  {
    workflowId: W.ORG_WALLET_TOPUP_CONFIRMED,
    name: "Org wallet topped up",
    description: "Billing admins, when a top-up is captured.",
    category: "orgBilling",
    inApp: {
      subject: "Wallet topped up",
      body: "{{payload.amount}} was added to {{payload.orgName}}'s wallet. New balance: {{payload.newBalance}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_WALLET_LOW,
    name: "Org wallet low",
    description:
      "Billing admins, when the balance drops below the floor (#777).",
    category: "orgBilling",
    inApp: {
      subject: "Wallet running low",
      body: "{{payload.orgName}}'s wallet is down to {{payload.balance}}, below the {{payload.minimum}} minimum. Top up to keep bookings flowing.",
      redirect: "topUpUrl",
    },
  },
  {
    workflowId: W.ORG_PAYOUT_COMPLETED,
    name: "Org payout sent",
    description: "Billing admins, when a payout leaves for the org's bank.",
    category: "orgBilling",
    inApp: {
      subject: "Payout sent",
      body: "A payout of {{payload.amount}} to {{payload.orgName}} has been sent.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PAYOUT_FAILED,
    name: "Org payout failed",
    description: "Billing admins. `reason` is the gateway's sentence.",
    category: "orgBilling",
    inApp: {
      subject: "Payout failed",
      body: "A payout of {{payload.amount}} to {{payload.orgName}} failed: {{payload.reason}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PAYOUT_REVERSED,
    name: "Org payout reversed",
    description: "Billing admins, when the bank returns a payout.",
    category: "orgBilling",
    inApp: {
      subject: "Payout reversed",
      body: "A payout of {{payload.amount}} to {{payload.orgName}} was reversed: {{payload.reason}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_MEMBER_OVERAGE_TIMED_OUT,
    name: "Member overage lapsed",
    description: "The member, when their side-charge window closes (#779).",
    category: "orgBilling",
    inApp: {
      subject: "Payment window closed",
      body: "The payment window for your {{payload.programName}} overage of {{payload.amount}} at {{payload.orgName}} has closed. Contact your programme administrator to continue.",
      redirect: "payUrl",
    },
  },
  {
    workflowId: W.ORG_PROGRAM_OVERAGE_DUE,
    name: "Member overage due",
    description:
      "The member, when an over-cap booking creates a side-charge (#775).",
    category: "orgBilling",
    inApp: {
      subject: "Payment due",
      body: "Your booking went over the {{payload.programName}} allowance at {{payload.orgName}}. {{payload.amount}} is due from you to keep it.",
      redirect: "payUrl",
    },
  },

  // ── Membership ──────────────────────────────────────────────────────────
  {
    workflowId: W.ORG_INVITE_SENT,
    name: "Org invite",
    description: "The invitee.",
    category: "orgMembership",
    inApp: {
      subject: "You're invited",
      body: "{{payload.inviterName}} invited you to join {{payload.orgName}} as {{payload.role | downcase | replace: '_', ' '}}. The invitation expires on {{payload.expiresAt}}.",
      redirect: "inviteUrl",
    },
  },
  {
    workflowId: W.ORG_INVITE_ACCEPTED,
    name: "Org invite accepted",
    description: "Org admins, when an invitee joins.",
    category: "orgMembership",
    inApp: {
      subject: "New member",
      body: "{{payload.accepteeName}} ({{payload.accepteeEmail}}) joined {{payload.orgName}} as {{payload.role | downcase | replace: '_', ' '}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_EXPERT_REMOVED,
    name: "Removed from org",
    description: "The consultant whose EXPERT membership was removed.",
    category: "orgMembership",
    inApp: {
      subject: "Membership ended",
      body: "You were removed from {{payload.orgName}} by {{payload.removedByName}}{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_SSO_PROVIDER_DELETED,
    name: "SSO provider removed",
    description: "Org admins.",
    category: "orgMembership",
    inApp: {
      subject: "SSO removed",
      body: "{{payload.deletedByName}} removed the SSO provider {{payload.providerId}} from {{payload.orgName}}. Members now sign in with email.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_SSO_CERT_EXPIRING,
    name: "SSO certificate expiring",
    description: "Org admins. `severity` is WARN, CRITICAL or EXPIRED.",
    category: "orgMembership",
    inApp: {
      subject: "SSO certificate",
      body: "{% if payload.severity == 'EXPIRED' %}The SSO certificate for {{payload.orgName}} ({{payload.providerId}}) expired on {{payload.notAfter}} and single sign-on is failing.{% else %}The SSO certificate for {{payload.orgName}} ({{payload.providerId}}) expires on {{payload.notAfter}} — {{payload.daysRemaining}} day{% if payload.daysRemaining != 1 %}s{% endif %} left.{% endif %} Upload a new certificate.",
      redirect: "dashboardUrl",
    },
  },

  // ── Programmes ──────────────────────────────────────────────────────────
  {
    workflowId: W.ORG_PROGRAM_EXHAUSTED,
    name: "Programme cap reached",
    description: "Org admins, when an assignee hits 100% of their cap.",
    category: "orgProgram",
    inApp: {
      subject: "Programme cap reached",
      body: "{{payload.assigneeName}} has used every engagement in {{payload.programName}} at {{payload.orgName}}. Further bookings will be refused until the cap is raised.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_PROGRAM_CAP_NEAR,
    name: "Programme cap near",
    description: "Org admins, on the 80% crossing (#768).",
    category: "orgProgram",
    inApp: {
      subject: "Programme nearly used up",
      body: "{{payload.assigneeName}} has used {{payload.engagementsUsed}} of {{payload.cap}} engagements ({{payload.usedPct}}%) in {{payload.programName}} at {{payload.orgName}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_LICENSE_RENEWAL_UPCOMING,
    name: "Licence renewal upcoming",
    description: "Billing admins, ahead of a licence cycle renewing.",
    category: "orgProgram",
    inApp: {
      subject: "Licence renews soon",
      body: "{{payload.orgName}}'s {{payload.cycle}} licence renews on {{payload.renewalDate}} — {{payload.daysUntilRenewal}} day{% if payload.daysUntilRenewal != 1 %}s{% endif %} away — for about {{payload.expectedTotal}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.ORG_DATA_EXPORT_READY,
    name: "Data export ready",
    description: "The admin who requested the export.",
    category: "orgProgram",
    inApp: {
      subject: "Export ready",
      body: "The data export for {{payload.orgName}} is ready to download. The link expires on {{payload.expiresAt}}.",
      redirect: "downloadUrl",
    },
  },
];
