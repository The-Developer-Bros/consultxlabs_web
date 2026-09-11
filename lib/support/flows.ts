/**
 * #appt-support / #support-hub — the versioned, type-safe FLOW REGISTRY
 * (SELF_SERVE channel).
 *
 * Each intent is a `FlowDefinition` in code (PR-reviewed, testable) — not DB
 * rows. `flowsForContext` returns the intents offered for a given appointment;
 * availability gates encode the Swiggy order-state pattern (you can't cancel a
 * completed session, you can't no-show an upcoming one) plus role/context
 * gates (provider vs attendee, org-sponsored, org operator). This is the
 * deterministic layer; an AI resolver later shares the SAME context and can
 * take over any thread.
 *
 * Terminal nodes carry machine-readable `reason`s — they flow into the
 * escalated ticket's description and the priority map in service.escalate().
 * Money is never moved by a flow: terminals REQUEST actions (OFFER_*) that the
 * validated seams execute (booking doctrine: refunds have two front doors).
 */

import type { FlowDefinition, SupportContext } from "./types";

const notUpcoming = (ctx: SupportContext) => ctx.stage !== "UPCOMING";
const notCompleted = (ctx: SupportContext) => ctx.stage !== "COMPLETED";

// --- Provider/expert no-show (attendee side) — the #1 marketplace complaint ---
const noShowFlowAttendee: FlowDefinition = {
  category: "NO_SHOW",
  title: "The expert didn't join",
  entryNodeId: "start",
  available: (ctx) => notUpcoming(ctx) && !ctx.isProvider,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "Sorry about that. What happened?",
      options: [
        { id: "expert", label: "The expert didn't join", next: "expert" },
        { id: "me", label: "I couldn't join", next: "tech" },
      ],
    },
    expert: {
      id: "expert",
      kind: "TERMINAL",
      body: "That qualifies for a full refund or a free reschedule — our team is reviewing and will confirm here shortly.",
      escalate: true,
      reason: "provider_no_show",
    },
    tech: {
      id: "tech",
      kind: "TERMINAL",
      body: "Let's get you set up to try again, or pick a new time.",
      action: { kind: "OFFER_RESCHEDULE" },
    },
  },
};

// --- No-show (provider side): the consultee didn't turn up -------------------
const noShowFlowProvider: FlowDefinition = {
  category: "NO_SHOW",
  title: "The participant didn't join",
  entryNodeId: "start",
  available: (ctx) => notUpcoming(ctx) && ctx.isProvider,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "Sorry about that. What happened?",
      options: [
        { id: "client", label: "The participant didn't join", next: "client" },
        { id: "me", label: "I couldn't join", next: "tech" },
      ],
    },
    client: {
      id: "client",
      kind: "TERMINAL",
      body: "Noted — this session is recorded as a no-show and your fee for it stays with you. The participant can rebook or request support separately.",
      resolved: true,
      reason: "attendee_no_show",
    },
    tech: {
      id: "tech",
      kind: "TERMINAL",
      body: "Let's get you set up to try again, or free the slot for a rebook.",
      action: { kind: "OFFER_RESCHEDULE" },
    },
  },
};

// --- Cancel & refund (policy-driven; refund % comes from context) ------------
const cancelRefundFlow: FlowDefinition = {
  category: "CANCEL_REFUND",
  title: "Cancel this session",
  entryNodeId: "start",
  available: (ctx) => ctx.stage === "UPCOMING",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What would you like to do about this session?",
      options: [
        { id: "cancel", label: "Cancel and request a refund", next: "confirm" },
        { id: "keep", label: "Never mind, keep it", next: "kept" },
      ],
    },
    confirm: {
      id: "confirm",
      kind: "TERMINAL",
      // The concrete % is rendered by the caller from ctx.refundPctIfCancelledNow.
      body: "Here's the refund you're eligible for under the cancellation policy. Confirm to proceed.",
      action: { kind: "OFFER_CANCEL_REFUND", refundPct: 0 },
    },
    kept: {
      id: "kept",
      kind: "TERMINAL",
      body: "Great — your session is unchanged. Anything else?",
      resolved: true,
    },
  },
};

// --- Reschedule ---------------------------------------------------------------
const rescheduleFlow: FlowDefinition = {
  category: "RESCHEDULE",
  title: "Reschedule this session",
  entryNodeId: "start",
  available: notCompleted,
  nodes: {
    start: {
      id: "start",
      kind: "TERMINAL",
      body: "You can pick a new time from the available slots.",
      action: { kind: "OFFER_RESCHEDULE" },
    },
  },
};

// --- Payment status (any stage) ----------------------------------------------
const paymentStatusFlow: FlowDefinition = {
  category: "PAYMENT_STATUS",
  title: "Payment or refund status",
  entryNodeId: "start",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What does the payment issue look like?",
      options: [
        {
          id: "deducted",
          label: "Money was deducted but the booking isn't confirmed",
          next: "deducted",
        },
        { id: "twice", label: "I was charged twice", next: "twice" },
        { id: "refund", label: "Where is my refund?", next: "refund" },
        { id: "invoice", label: "I need an invoice or GST receipt", next: "invoice" },
      ],
    },
    deducted: {
      id: "deducted",
      kind: "TERMINAL",
      body: "Usually the bank releases a pending deduction within 5–7 working days, and the booking was not created. We've flagged the charge to our payments team to confirm.",
      escalate: true,
      reason: "payment_deducted_unconfirmed",
    },
    twice: {
      id: "twice",
      kind: "TERMINAL",
      body: "We're on it — duplicate charges are refunded in full. Our payments team will confirm here shortly.",
      escalate: true,
      reason: "double_charge",
    },
    refund: {
      id: "refund",
      kind: "PROMPT",
      body: "Do you see the refund initiated anywhere (bank statement / Payments page)?",
      options: [
        { id: "initiated", label: "Yes, it's initiated", next: "tracking" },
        { id: "nothing", label: "No refund at all", next: "missing" },
      ],
    },
    tracking: {
      id: "tracking",
      kind: "TERMINAL",
      body: "Gateway refunds typically land in 5–7 working days depending on your bank.",
      action: { kind: "SHOW_REFUND_STATUS" },
      resolved: true,
    },
    missing: {
      id: "missing",
      kind: "TERMINAL",
      body: "That shouldn't happen — our payments team will trace it and update you here.",
      escalate: true,
      reason: "refund_missing",
    },
    invoice: {
      id: "invoice",
      kind: "TERMINAL",
      body: "You can download invoices and GST receipts from your Payments page.",
      action: { kind: "SHOW_INVOICES" },
      resolved: true,
    },
  },
};

// --- Recording access (completed sessions) -----------------------------------
const recordingAccessFlow: FlowDefinition = {
  category: "RECORDING_ACCESS",
  title: "Recording access",
  entryNodeId: "start",
  available: (ctx) => ctx.stage === "COMPLETED",
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What's the problem with the recording?",
      options: [
        { id: "missing", label: "I can't find the recording", next: "missing" },
        { id: "play", label: "It's there but won't play", next: "play" },
      ],
    },
    missing: {
      id: "missing",
      kind: "PROMPT",
      body: "Recordings are processed within 48 hours of the session. How long has it been?",
      options: [
        { id: "within", label: "Less than 48 hours", next: "within" },
        { id: "beyond", label: "More than 48 hours", next: "beyond" },
      ],
    },
    within: {
      id: "within",
      kind: "TERMINAL",
      body: "You're within the processing window — it will appear in your Recordings page (with a notification) once ready.",
      resolved: true,
    },
    beyond: {
      id: "beyond",
      kind: "TERMINAL",
      body: "That's longer than it should take — our team will chase the processing and update you here.",
      escalate: true,
      reason: "recording_missing",
    },
    play: {
      id: "play",
      kind: "PROMPT",
      body: "Try a different browser or the native app, and check your network. Did that help?",
      options: [
        { id: "fixed", label: "Yes, it plays now", next: "fixed" },
        { id: "broken", label: "No, still broken", next: "broken" },
      ],
    },
    fixed: {
      id: "fixed",
      kind: "TERMINAL",
      body: "Glad that worked.",
      resolved: true,
    },
    broken: {
      id: "broken",
      kind: "TERMINAL",
      body: "Our team will look into the file and get you a working copy.",
      escalate: true,
      reason: "recording_broken",
    },
  },
};

// --- Quality complaint (after the session) -----------------------------------
const qualityComplaintFlow: FlowDefinition = {
  category: "QUALITY_COMPLAINT",
  title: "Session quality",
  entryNodeId: "start",
  available: (ctx) => notUpcoming(ctx),
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What went wrong? You can also type details below — they go straight to the reviewing team.",
      options: [
        {
          id: "early",
          label: "Session ended much earlier than booked",
          next: "early",
        },
        { id: "poor", label: "Session quality was poor", next: "poor" },
        { id: "wrong", label: "It wasn't the expert I booked", next: "wrong" },
        {
          id: "av",
          label: "Audio or video problems during the call",
          next: "av",
        },
        { id: "other", label: "Something else", next: "other" },
      ],
    },
    early: {
      id: "early",
      kind: "TERMINAL",
      body: "Thanks — our team will review the session duration and follow up with a fair resolution.",
      escalate: true,
      reason: "quality_ended_early",
    },
    poor: {
      id: "poor",
      kind: "TERMINAL",
      body: "Thanks for telling us — our team will review and follow up here.",
      escalate: true,
      reason: "quality_poor",
    },
    av: {
      id: "av",
      kind: "TERMINAL",
      // The TECHNICAL intent is gated notCompleted, so once the session ends
      // this is the only route for "the call itself was broken" — which is
      // COMMUNICATION_ISSUE in the ticket taxonomy.
      body: "Sorry — a call that won't hold together wastes the session. Our team will check the call logs for this session and follow up here.",
      escalate: true,
      reason: "quality_av",
    },
    wrong: {
      id: "wrong",
      kind: "TERMINAL",
      body: "That's a serious mismatch — our team will investigate the booking and make it right.",
      escalate: true,
      reason: "quality_wrong_expert",
    },
    other: {
      id: "other",
      kind: "TERMINAL",
      body: "Our team will review what happened and follow up with you here.",
      escalate: true,
      reason: "quality_other",
    },
  },
};

// --- Technical (before/during) ------------------------------------------------
const technicalFlow: FlowDefinition = {
  category: "TECHNICAL",
  title: "Technical trouble",
  entryNodeId: "start",
  available: notCompleted,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "Where are you stuck?",
      options: [
        { id: "join", label: "I can't join the session", next: "join" },
        { id: "av", label: "Audio or video problems in the call", next: "av" },
        {
          id: "timezone",
          label: "The session time looks wrong to me",
          next: "timezone",
        },
      ],
    },
    timezone: {
      id: "timezone",
      kind: "PROMPT",
      body: "Times are shown in the timezone set on your profile, not the expert's. Check Settings → your timezone, then reopen this session. Does the time look right now?",
      options: [
        { id: "fixed", label: "Yes, that explains it", next: "fixed" },
        { id: "tzstuck", label: "No, it still looks wrong", next: "tzstuck" },
      ],
    },
    tzstuck: {
      id: "tzstuck",
      kind: "TERMINAL",
      body: "Thanks — our team will confirm the correct time for this session and can move it if the listing was wrong.",
      action: { kind: "OFFER_RESCHEDULE" },
      escalate: true,
      reason: "timezone_mismatch",
    },
    join: {
      id: "join",
      kind: "PROMPT",
      body: "Try re-opening the session from your Appointments page in a fresh tab, and allow camera/mic permissions when asked. Did that work?",
      options: [
        { id: "fixed", label: "Yes, I'm in", next: "fixed" },
        { id: "stuck", label: "No, still can't join", next: "stuck" },
      ],
    },
    av: {
      id: "av",
      kind: "PROMPT",
      body: "Leave and rejoin the call, and switch to a headset if possible. Did that help?",
      options: [
        { id: "fixed", label: "Yes, it's fine now", next: "fixed" },
        { id: "stuck", label: "No, still broken", next: "stuck" },
      ],
    },
    fixed: {
      id: "fixed",
      kind: "TERMINAL",
      body: "Glad that worked — enjoy the session.",
      resolved: true,
    },
    stuck: {
      id: "stuck",
      kind: "TERMINAL",
      body: "Our team can help get you in, or move the session to a new time.",
      action: { kind: "OFFER_RESCHEDULE" },
      escalate: true,
      reason: "technical_unresolved",
    },
  },
};

// --- B2B: sponsorship / who's paying (org-context only) ----------------------
const sponsorshipBillingFlow: FlowDefinition = {
  category: "SPONSORSHIP_BILLING",
  title: "Sponsorship & billing for this session",
  entryNodeId: "start",
  available: (ctx: SupportContext) => ctx.isOrgContext,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "This session is sponsored by your organization. What do you need?",
      options: [
        { id: "who", label: "Who paid for this?", next: "who" },
        { id: "charged", label: "I think I was charged by mistake", next: "escalate" },
      ],
    },
    who: {
      id: "who",
      kind: "TERMINAL",
      body: "Your organization covered this session — you weren't charged personally.",
      resolved: true,
    },
    escalate: {
      id: "escalate",
      kind: "TERMINAL",
      body: "Let me connect you with support to check the charge.",
      escalate: true,
      reason: "sponsorship_charge",
    },
  },
};

// --- B2B: org-operator dispute on a member's session (org operators only) ----
const orgAdminDisputeFlow: FlowDefinition = {
  category: "ORG_ADMIN_DISPUTE",
  title: "Raise a concern about this session",
  entryNodeId: "start",
  available: (ctx: SupportContext) => ctx.isOrgOperator,
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What kind of concern are you raising?",
      options: [
        {
          id: "billing",
          label: "A billing or charge dispute",
          next: "billing",
        },
        {
          id: "conduct",
          label: "A concern about how the session was conducted",
          next: "conduct",
        },
      ],
    },
    billing: {
      id: "billing",
      kind: "TERMINAL",
      body: "Charge and invoice disputes are handled on your organization's Disputes page (Billing → Disputes), where the finance team can act on the specific invoice.",
      resolved: true,
      reason: "routed_org_disputes",
    },
    conduct: {
      id: "conduct",
      kind: "TERMINAL",
      body: "Our team will review the session and coordinate with everyone involved. We'll update you here.",
      escalate: true,
      reason: "org_conduct_dispute",
    },
  },
};

// --- Session materials (handouts, pre-reads, uploads) -------------------------
const documentsFlow: FlowDefinition = {
  category: "DOCUMENTS",
  title: "Session materials",
  entryNodeId: "start",
  // Deliberately ungated: pre-reads matter before, handouts after, and a
  // wrong file is worth reporting whenever it is noticed.
  nodes: {
    start: {
      id: "start",
      kind: "PROMPT",
      body: "What's wrong with the materials for this session?",
      options: [
        {
          id: "missing",
          label: "I haven't received the materials",
          next: "missing",
        },
        {
          id: "wrong",
          label: "The file is wrong or won't open",
          next: "wrong",
        },
      ],
    },
    missing: {
      id: "missing",
      kind: "PROMPT",
      body: "Materials appear on this appointment's page once the expert uploads them — they aren't emailed. Can you see anything under Documents there?",
      options: [
        { id: "found", label: "Yes, found them", next: "found" },
        { id: "stillmissing", label: "No, nothing is there", next: "stillmissing" },
      ],
    },
    found: {
      id: "found",
      kind: "TERMINAL",
      body: "Good — they'll stay on that page for as long as you need them.",
      resolved: true,
    },
    stillmissing: {
      id: "stillmissing",
      kind: "TERMINAL",
      body: "Thanks — our team will chase the materials for this session and follow up here.",
      escalate: true,
      reason: "documents_missing",
    },
    wrong: {
      id: "wrong",
      kind: "TERMINAL",
      body: "Thanks — tell us which file below and our team will get the right one to you.",
      escalate: true,
      reason: "documents_wrong",
    },
  },
};

/** Every per-appointment flow, gates ignored. Exported so a test can assert
 *  the intents the GET may offer are all accepted by the POST. */
export const ALL_FLOWS: FlowDefinition[] = [
  noShowFlowAttendee,
  noShowFlowProvider,
  cancelRefundFlow,
  rescheduleFlow,
  paymentStatusFlow,
  recordingAccessFlow,
  qualityComplaintFlow,
  technicalFlow,
  documentsFlow,
  sponsorshipBillingFlow,
  orgAdminDisputeFlow,
];

/** The intents offered for a given appointment (respects `available` gates). */
export function flowsForContext(ctx: SupportContext): FlowDefinition[] {
  return ALL_FLOWS.filter((f) => !f.available || f.available(ctx));
}

/** Look up a flow by category (or undefined if not offered for this context). */
export function flowForCategory(
  ctx: SupportContext,
  category: FlowDefinition["category"],
): FlowDefinition | undefined {
  return flowsForContext(ctx).find((f) => f.category === category);
}
