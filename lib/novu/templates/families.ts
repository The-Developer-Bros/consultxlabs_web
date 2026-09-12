/**
 * The Novu plan caps an environment at 20 workflows and the app has 69 events,
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

/** Three small tables rather than one array of objects: Sonar's copy-paste
 *  detector normalises literals and reads sixteen same-shaped entries as a
 *  duplicated block. */
const FAMILY_NAME: Record<FamilyId, string> = {
  appointment: "Appointments",
  "session-media": "Recordings & documents",
  payment: "Payments",
  refund: "Refunds & disputes",
  payout: "Payouts",
  referral: "Referrals",
  subscription: "Subscriptions",
  trial: "Trial sessions",
  "support-ticket": "Support tickets",
  feedback: "Feedback & reviews",
  account: "Account",
  collaborator: "Collaborators",
  platform: "Platform",
  "org-billing": "Organisation billing",
  "org-membership": "Organisation membership",
  "org-program": "Organisation programmes",
};

const FAMILY_CATEGORY: Record<FamilyId, PreferenceCategory | null> = {
  appointment: "appointments",
  "session-media": "appointments",
  payment: "payments",
  refund: "payments",
  payout: "payments",
  referral: "payments",
  subscription: "subscriptions",
  trial: "trials",
  "support-ticket": "support",
  feedback: "feedback",
  account: null,
  collaborator: "appointments",
  platform: null,
  "org-billing": "orgBilling",
  "org-membership": "orgMembership",
  "org-program": "orgProgram",
};

const FAMILY_DESCRIPTION: Record<FamilyId, string> = {
  appointment: "Booking lifecycle for both parties.",
  "session-media": "What a session produced: recordings and shared documents.",
  payment: "The payer's money going out.",
  refund: "Money contested or coming back; consultant and ops.",
  payout: "The consultant's earnings leaving for their bank.",
  referral: "Referral credits earned and granted.",
  subscription: "Subscription lifecycle.",
  trial: "Free-trial lifecycle.",
  "support-ticket": "Ops-facing and owner-facing ticket events.",
  feedback: "Product feedback to admins; reviews to consultants.",
  account: "Verification, moderation and applications. No opt-out.",
  collaborator: "Co-hosting invitations on a plan.",
  platform: "Announcements and maintenance. No opt-out.",
  "org-billing": "Invoices, wallet, payouts and member overages.",
  "org-membership": "Roster and single sign-on.",
  "org-program": "Entitlement, capacity, renewals and exports.",
};

export const FAMILIES: readonly Family[] = (
  Object.keys(FAMILY_NAME) as FamilyId[]
).map((id) => ({
  id,
  name: FAMILY_NAME[id],
  description: FAMILY_DESCRIPTION[id],
  category: FAMILY_CATEGORY[id],
}));

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
  "collaborator-declined": "collaborator",
  "collaborator-withdrawn": "collaborator",

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
