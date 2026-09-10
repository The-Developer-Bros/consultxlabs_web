/**
 * #support-hub — the PLATFORM-scope flow registry (stateless SELF_SERVE).
 *
 * Platform issues (account, payments, site-wide technical, general) have no
 * appointment to hang a thread on, so their intake is STATELESS: the client
 * holds the cursor for the length of one sitting and replays it to the server
 * each turn; the server validates every transition against this registry. A
 * terminal either self-serves (resolved — nothing persisted) or escalates,
 * which is the ONLY write: a `SupportTicket` created via the shared factory
 * with the walked path summarized into the description.
 *
 * Reuses the appointment scope's FlowNode/FlowOption node shapes and the same
 * pure walk (`flow-walk.ts`), so an AI resolver can later take over either
 * scope with one contract.
 *
 * `issueTypeByReason` maps each terminal reason onto the existing rich
 * `SupportIssueType` ticket taxonomy — no new enums, ops queue stays uniform.
 */

import type { SupportIssueType } from "@prisma/client";
import type { FlowNode } from "./types";

export type PlatformFlowId =
  | "PAYMENTS_BILLING"
  | "ACCOUNT_ACCESS"
  | "PLATFORM_TECHNICAL"
  | "ORG_OPERATOR_BILLING"
  | "GENERAL";

/** Facts the platform intake resolves per request. */
export interface PlatformSupportContext {
  userId: string;
  /** Caller holds an ACTIVE org membership with operator grants. */
  isOperator: boolean;
  /** The caller's ACTIVE-membership org ids (attribution candidates). */
  organizationIds: string[];
}

export interface PlatformFlowDefinition {
  id: PlatformFlowId;
  title: string;
  /** One-line chip subtitle in the intake UI. */
  description: string;
  entryNodeId: string;
  nodes: Record<string, FlowNode>;
  /** Default ticket taxonomy when this flow escalates. */
  issueType: SupportIssueType;
  /** Per-reason overrides (one flow can escalate into different queues). */
  issueTypeByReason?: Record<string, SupportIssueType>;
  available?: (ctx: PlatformSupportContext) => boolean;
}

// --- Payments & billing -------------------------------------------------------
const paymentsBillingFlow: PlatformFlowDefinition = {
  id: "PAYMENTS_BILLING",
  title: "Payments & billing",
  description: "Charges, refunds, invoices and GST receipts",
  entryNodeId: "start",
  issueType: "BILLING_QUESTION",
  issueTypeByReason: {
    payment_deducted_unconfirmed: "PAYMENT_FAILED",
    double_charge: "CHARGED_TWICE",
    refund_missing: "REFUND_REQUEST",
  },
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What does the payment issue look like?",
      options: [
        {
          id: "deducted",
          label: "Money deducted but booking not confirmed",
          next: "deducted",
        },
        { id: "twice", label: "Charged twice", next: "twice" },
        { id: "refund", label: "Refund question", next: "refund" },
        { id: "invoice", label: "Invoice or GST receipt", next: "invoice" },
      ],
    },
    deducted: {
      id: "deducted",
      kind: "TERMINAL",
      body: "Banks usually release a pending deduction within 5–7 working days, and no booking is created in that case. We've flagged the charge to our payments team to confirm.",
      escalate: true,
      reason: "payment_deducted_unconfirmed",
    },
    twice: {
      id: "twice",
      kind: "TERMINAL",
      body: "Duplicate charges are refunded in full — our payments team will confirm here and over email.",
      escalate: true,
      reason: "double_charge",
    },
    refund: {
      id: "refund",
      kind: "PROMPT",
      body: "What's the refund question?",
      options: [
        {
          id: "status",
          label: "Tracking a refund I requested",
          next: "tracking",
        },
        {
          id: "missing",
          label: "I'm owed one and see nothing",
          next: "missing",
        },
      ],
    },
    tracking: {
      id: "tracking",
      kind: "TERMINAL",
      body: "Gateway refunds typically land in 5–7 working days depending on your bank. You can watch its status on your Payments page.",
      action: { kind: "SHOW_REFUND_STATUS" },
      resolved: true,
    },
    missing: {
      id: "missing",
      kind: "TERMINAL",
      body: "Our payments team will trace it against your payment history and update you.",
      escalate: true,
      reason: "refund_missing",
    },
    invoice: {
      id: "invoice",
      kind: "TERMINAL",
      body: "Invoices and GST receipts live on your Payments page — download any of them anytime.",
      action: { kind: "SHOW_INVOICES" },
      resolved: true,
    },
  },
};

// --- Account & access ----------------------------------------------------------
const accountAccessFlow: PlatformFlowDefinition = {
  id: "ACCOUNT_ACCESS",
  title: "Account & sign-in",
  description: "Login, OTP, email changes, account deletion",
  entryNodeId: "start",
  issueType: "ACCOUNT_ISSUE",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What do you need help with?",
      options: [
        { id: "login", label: "I can't sign in", next: "login" },
        { id: "email", label: "I want to change my email", next: "email" },
        { id: "delete", label: "I want to delete my account", next: "delete" },
      ],
    },
    login: {
      id: "login",
      kind: "PROMPT",
      body: "Try requesting a fresh OTP (it expires in 10 minutes) and check spam for the email link. Still locked out?",
      options: [
        { id: "fixed", label: "That worked", next: "fixed" },
        { id: "stuck", label: "Still can't sign in", next: "stuck" },
      ],
    },
    fixed: {
      id: "fixed",
      kind: "TERMINAL",
      body: "Welcome back in.",
      resolved: true,
    },
    stuck: {
      id: "stuck",
      kind: "TERMINAL",
      body: "Our team will verify your identity and restore access — expect an update here.",
      escalate: true,
      reason: "login_failure",
    },
    email: {
      id: "email",
      kind: "TERMINAL",
      body: "You can change your email yourself: Settings → Account → Email. Verification lands at the new address.",
      resolved: true,
    },
    delete: {
      id: "delete",
      kind: "TERMINAL",
      body: "Account deletion is a formal data-erasure request (DPDP §12): Settings → Privacy → Delete account. Financial records are retained as the law requires; everything else is scrubbed.",
      resolved: true,
      reason: "routed_erasure",
    },
  },
};

// --- Platform technical --------------------------------------------------------
const platformTechnicalFlow: PlatformFlowDefinition = {
  id: "PLATFORM_TECHNICAL",
  title: "Site or app trouble",
  description: "Pages not loading, notifications, uploads",
  entryNodeId: "start",
  issueType: "TECHNICAL_ISSUES",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What's misbehaving?",
      options: [
        { id: "load", label: "A page won't load / errors out", next: "load" },
        {
          id: "notify",
          label: "I'm not getting notifications",
          next: "notify",
        },
      ],
    },
    load: {
      id: "load",
      kind: "PROMPT",
      body: "Hard-refresh the page (Ctrl/Cmd+Shift+R) or try another browser. Did that fix it?",
      options: [
        { id: "fixed", label: "Yes, all good", next: "fixed" },
        { id: "stuck", label: "No, still broken", next: "stuck" },
      ],
    },
    notify: {
      id: "notify",
      kind: "PROMPT",
      body: "Check that notifications are enabled in Settings → Notifications and that your browser hasn't muted this site. Still nothing?",
      options: [
        { id: "fixed", label: "Working now", next: "fixed" },
        { id: "stuck", label: "Still nothing", next: "stuck" },
      ],
    },
    fixed: {
      id: "fixed",
      kind: "TERMINAL",
      body: "Glad that sorted it.",
      resolved: true,
    },
    stuck: {
      id: "stuck",
      kind: "TERMINAL",
      body: "Our team will dig in — tell us what you were trying to do when it broke and we'll take it from there.",
      escalate: true,
      reason: "platform_technical",
    },
  },
};

// --- B2B operator: org billing & sponsorship -----------------------------------
const orgOperatorBillingFlow: PlatformFlowDefinition = {
  id: "ORG_OPERATOR_BILLING",
  title: "Organization billing & sponsorship",
  description: "Invoices, POs, payment terms, sponsorship programs",
  entryNodeId: "start",
  issueType: "BILLING_QUESTION",
  issueTypeByReason: {
    operator_invoice: "BILLING_QUESTION",
    operator_procurement: "BILLING_QUESTION",
  },
  available: (ctx) => ctx.isOperator,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What does your organization need?",
      options: [
        { id: "invoice", label: "Invoice / GST question", next: "invoice" },
        {
          id: "po",
          label: "PO, payment terms or sponsorship programs",
          next: "po",
        },
      ],
    },
    invoice: {
      id: "invoice",
      kind: "TERMINAL",
      body: "Your org's invoices and credit notes are on the Billing page; charge disputes go through Billing → Disputes where finance can act on the specific invoice.",
      action: { kind: "SHOW_INVOICES" },
      resolved: true,
    },
    po: {
      id: "po",
      kind: "TERMINAL",
      body: "Our enterprise team will pick this up and respond with your organization's account manager copied.",
      escalate: true,
      reason: "operator_procurement",
    },
  },
};

// --- General --------------------------------------------------------------------
const generalFlow: PlatformFlowDefinition = {
  id: "GENERAL",
  title: "Something else",
  description: "Reach a human, or leave feedback",
  entryNodeId: "start",
  issueType: "GENERAL_INQUIRY",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "Sure — what would you like to do?",
      options: [
        { id: "human", label: "Talk to a person", next: "human" },
        {
          id: "feedback",
          label: "Leave feedback or a suggestion",
          next: "feedback",
        },
      ],
    },
    human: {
      id: "human",
      kind: "TERMINAL",
      body: "Tell us what's on your mind in the ticket our team will pick up — they'll reply to you here and by email.",
      escalate: true,
      reason: "general_human",
    },
    feedback: {
      id: "feedback",
      kind: "TERMINAL",
      body: "Tell us here and it goes straight to the product team — every entry is read and tracked.",
      resolved: true,
      reason: "routed_feedback",
      // #705 — this terminal claimed the entry was "read and tracked" and then
      // wrote nothing at all: the turn returned before any persistence. The
      // action asks the sheet for a box, and what the user types is stored as
      // product Feedback. This is also COLLECT_FEEDBACK's first emitter — it
      // had been declared in lib/support/types.ts and never used.
      //
      // Bound to the TERMINAL NODE rather than to a ticket, deliberately: a
      // suggestion is not a support request, and filing one would put every
      // opinion in the ops queue.
      action: { kind: "COLLECT_FEEDBACK" },
    },
  },
};

/** Every platform flow, gates ignored. Exported for the offer/accept parity
 *  test — see __tests__/support/intent-offer-accept-parity.test.ts. */
export const ALL_PLATFORM_FLOWS: PlatformFlowDefinition[] = [
  paymentsBillingFlow,
  accountAccessFlow,
  platformTechnicalFlow,
  orgOperatorBillingFlow,
  generalFlow,
];

/** The platform intents offered to this caller (respects `available` gates). */
export function platformFlowsForContext(
  ctx: PlatformSupportContext,
): PlatformFlowDefinition[] {
  return ALL_PLATFORM_FLOWS.filter((f) => !f.available || f.available(ctx));
}

export function platformFlowForId(
  ctx: PlatformSupportContext,
  id: string,
): PlatformFlowDefinition | undefined {
  return platformFlowsForContext(ctx).find((f) => f.id === id);
}

/** Ticket taxonomy for an escalated platform turn. */
export function issueTypeForFlow(
  flow: PlatformFlowDefinition,
  reason: string | undefined,
): SupportIssueType {
  if (reason && flow.issueTypeByReason?.[reason]) {
    return flow.issueTypeByReason[reason];
  }
  return flow.issueType;
}

/**
 * Org attribution for a platform-intake escalation.
 *
 * Two separate rules, kept together because getting either wrong changes who a
 * ticket is billed and routed to:
 *
 *   1. An explicit `orgId` that is NOT one of the caller's ACTIVE memberships
 *      is a forged attribution. It must be REFUSED, never silently downgraded
 *      to a B2C ticket — a silent downgrade hides the attempt.
 *   2. Inference from a sole membership applies only to the operator-billing
 *      flow, where org context is the entire point. A B2C flow must never
 *      inherit an org just because the caller happens to belong to one.
 *
 * Extracted from the route so the rule is unit-testable on its own and so any
 * future intake surface enforces the same one.
 */
export function resolveOrgAttribution(args: {
  flowId: string;
  requestedOrgId: string | null | undefined;
  activeOrganizationIds: readonly string[];
}):
  | { ok: true; organizationId: string | null }
  | { ok: false; reason: "FORGED_ORG" } {
  const { flowId, requestedOrgId, activeOrganizationIds } = args;

  if (requestedOrgId && !activeOrganizationIds.includes(requestedOrgId)) {
    return { ok: false, reason: "FORGED_ORG" };
  }
  if (flowId !== "ORG_OPERATOR_BILLING") {
    return { ok: true, organizationId: null };
  }
  if (requestedOrgId) return { ok: true, organizationId: requestedOrgId };
  if (activeOrganizationIds.length === 1) {
    return { ok: true, organizationId: activeOrganizationIds[0] };
  }
  return { ok: true, organizationId: null };
}
