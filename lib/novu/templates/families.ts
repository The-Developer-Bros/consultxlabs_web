/**
 * The Novu plan caps an environment at 20 workflows and the app has 67 events,
 * so each Novu workflow is a FAMILY — one per audience-and-opt-out — and the
 * event travels as `payload.event`. The app still triggers by event id; the
 * wire layer (`toWire`) maps it to the family. One id with a discriminator
 * is the idiom #1085 established for `outcome`; this applies it one level up.
 *
 * Splitting a family back out later is a change to this map and a sync.
 */

import type { NOVU_WORKFLOWS } from "../workflows";
import type { NovuWorkflowId, PreferenceCategory } from "./types";

export type FamilyId =
  | "appointment"
  | "session-media"
  | "payment"
  | "refund"
  | "payout"
  | "referral"
  | "subscription"
  | "trial"
  | "support-ticket"
  | "feedback"
  | "account"
  | "collaborator"
  | "platform"
  | "org-billing"
  | "org-membership"
  | "org-program";

export type Family = {
  id: FamilyId;
  name: string;
  description: string;
  category: PreferenceCategory | null;
};

export const FAMILIES: readonly Family[] = [
  {
    id: "appointment",
    name: "Appointments",
    description: "Booking lifecycle for both parties.",
    category: "appointments",
  },
  {
    id: "session-media",
    name: "Recordings & documents",
    description: "What a session produced: recordings and shared documents.",
    category: "appointments",
  },
  {
    id: "payment",
    name: "Payments",
    description: "The payer's money going out.",
    category: "payments",
  },
  {
    id: "refund",
    name: "Refunds & disputes",
    description: "Money contested or coming back; consultant and ops.",
    category: "payments",
  },
  {
    id: "payout",
    name: "Payouts",
    description: "The consultant's earnings leaving for their bank.",
    category: "payments",
  },
  {
    id: "referral",
    name: "Referrals",
    description: "Referral credits earned and granted.",
    category: "payments",
  },
  {
    id: "subscription",
    name: "Subscriptions",
    description: "Subscription lifecycle.",
    category: "subscriptions",
  },
  {
    id: "trial",
    name: "Trial sessions",
    description: "Free-trial lifecycle.",
    category: "trials",
  },
  {
    id: "support-ticket",
    name: "Support tickets",
    description: "Ops-facing and owner-facing ticket events.",
    category: "support",
  },
  {
    id: "feedback",
    name: "Feedback & reviews",
    description: "Product feedback to admins; reviews to consultants.",
    category: "feedback",
  },
  {
    id: "account",
    name: "Account",
    description: "Verification, moderation and applications. No opt-out.",
    category: null,
  },
  {
    id: "collaborator",
    name: "Collaborators",
    description: "Co-hosting invitations on a plan.",
    category: "appointments",
  },
  {
    id: "platform",
    name: "Platform",
    description: "Announcements and maintenance. No opt-out.",
    category: null,
  },
  {
    id: "org-billing",
    name: "Organisation billing",
    description: "Invoices, wallet, payouts and member overages.",
    category: "orgBilling",
  },
  {
    id: "org-membership",
    name: "Organisation membership",
    description: "Roster and single sign-on.",
    category: "orgMembership",
  },
  {
    id: "org-program",
    name: "Organisation programmes",
    description: "Entitlement, capacity, renewals and exports.",
    category: "orgProgram",
  },
];

type Ids = typeof NOVU_WORKFLOWS;

export const EVENT_FAMILY: Record<Ids[keyof Ids], FamilyId> = {
  "appointment-booked": "appointment",
  "appointment-partially-scheduled": "appointment",
  "appointment-cancelled": "appointment",
  "appointment-rescheduled": "appointment",
  "appointment-reminder": "appointment",
  "appointment-completed": "appointment",
  "new-booking-request": "appointment",

  "recording-available": "session-media",
  "recording-failed": "session-media",
  "recording-expiring": "session-media",
  "document-uploaded": "session-media",
  "document-reviewed": "session-media",

  "payment-success": "payment",
  "payment-failed": "payment",
  "referral-credits-applied": "payment",

  "refund-requested": "refund",
  "refund-processed": "refund",
  "refund-failed": "refund",
  "dispute-created": "refund",
  "dispute-resolved": "refund",

  "payout-processed": "payout",

  "referral-bonus-earned": "referral",
  "referee-welcome-bonus": "referral",

  "subscription-started": "subscription",
  "subscription-cancelled": "subscription",
  "subscription-renewed": "subscription",

  "trial-session-requested": "trial",
  "trial-session-scheduled": "trial",
  "trial-session-completed": "trial",
  "trial-session-cancelled": "trial",

  "support-ticket-created": "support-ticket",
  "support-ticket-activity": "support-ticket",
  "support-ticket-update": "support-ticket",
  "support-ticket-response": "support-ticket",

  "feedback-received": "feedback",
  "new-review-received": "feedback",

  "verification-status-changed": "account",
  "new-consultant-application": "account",
  "moderation-warning": "account",
  "account-suspended": "account",
  "account-banned": "account",

  "collaborator-invited": "collaborator",
  "collaborator-accepted": "collaborator",
  "collaborator-removed": "collaborator",

  "general-announcement": "platform",
  "maintenance-scheduled": "platform",
  "maintenance-started": "platform",
  "maintenance-ended": "platform",

  "org-invoice-issued": "org-billing",
  "org-invoice-paid": "org-billing",
  "org-invoice-overdue": "org-billing",
  "org-wallet-topup-confirmed": "org-billing",
  "org-wallet-low": "org-billing",
  "org-payout-completed": "org-billing",
  "org-payout-failed": "org-billing",
  "org-payout-reversed": "org-billing",
  "org-member-overage-timed-out": "org-billing",
  "org-program-overage-due": "org-billing",

  "org-invite-sent": "org-membership",
  "org-invite-accepted": "org-membership",
  "org-expert-removed": "org-membership",
  "org-sso-provider-deleted": "org-membership",
  "org-sso-cert-expiring": "org-membership",

  "org-program-exhausted": "org-program",
  "org-program-cap-near": "org-program",
  "org-license-renewal-upcoming": "org-program",
  "org-data-export-ready": "org-program",
};

export function familyOf(event: NovuWorkflowId): FamilyId {
  return EVENT_FAMILY[event];
}
