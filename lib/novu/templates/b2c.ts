/**
 * In-app copy for every B2C workflow. Payload fields are documented on the
 * types in `../workflows`; unit-free names carry human values (`dateTime`,
 * `amountFormatted`), the suffixed twins carry raw ones.
 */

import { NOVU_WORKFLOWS as W } from "../workflows";
import type { WorkflowTemplate } from "./types";

/** `FAM-2026-000007 — Support for Basic Consultation`, or just the title. */
const TICKET =
  "{% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}";

const CANCELLED_COUNT =
  "{% if payload.appointmentsCancelled > 0 %} {{payload.appointmentsCancelled}} upcoming appointment{% if payload.appointmentsCancelled != 1 %}s were{% else %} was{% endif %} cancelled.{% endif %}";

export const B2C_TEMPLATES: WorkflowTemplate[] = [
  // ── Appointments ────────────────────────────────────────────────────────
  {
    workflowId: W.APPOINTMENT_BOOKED,
    name: "Appointment booked",
    description: "Both parties, once a booking is confirmed.",
    category: "appointments",
    inApp: {
      subject: "Booking confirmed",
      body: "Your {{payload.appointmentType}} for {{payload.planTitle}} is booked{% if payload.dateTime %} for {{payload.dateTime}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_PARTIALLY_SCHEDULED,
    name: "Appointment partly scheduled",
    description:
      "Both parties, when only some of a programme's sessions fit the calendar.",
    category: "appointments",
    inApp: {
      subject: "Partly scheduled",
      body: "{{payload.placedSessions}} of {{payload.requiredSessions}} sessions for {{payload.planTitle}} are booked. The remaining {{payload.unplacedSessions}} will be scheduled as availability opens.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_CANCELLED,
    name: "Appointment cancelled",
    description: "Both parties. `cancelledBy` is a name or a capitalised role.",
    category: "appointments",
    inApp: {
      subject: "Session cancelled",
      body: "{{payload.cancelledBy}} cancelled the {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %}. Reason: {{payload.reason}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_RESCHEDULED,
    name: "Appointment rescheduled",
    description:
      "Both parties. `outcome` is MOVED, PROPOSED, RELEASED, DECLINED or WITHDRAWN (#1085).",
    category: "appointments",
    inApp: {
      subject: "Schedule change",
      body: '{% if payload.outcome == "MOVED" %}Your {{payload.appointmentType}} for {{payload.planTitle}} moved from {{payload.oldDateTime}} to {{payload.newDateTime}}.{% elsif payload.outcome == "PROPOSED" %}A new time was proposed for your {{payload.appointmentType}} for {{payload.planTitle}}: {{payload.newDateTime}} instead of {{payload.oldDateTime}}. Please review it.{% elsif payload.outcome == "RELEASED" %}The {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.oldDateTime %} on {{payload.oldDateTime}}{% endif %} was released. You will be told once a new time is set.{% elsif payload.outcome == "DECLINED" %}The proposed new time for your {{payload.appointmentType}} for {{payload.planTitle}} was declined{% if payload.oldDateTime %}; it stays on {{payload.oldDateTime}}{% endif %}.{% else %}The reschedule request for your {{payload.appointmentType}} for {{payload.planTitle}} was withdrawn{% if payload.oldDateTime %}; it stays on {{payload.oldDateTime}}{% endif %}.{% endif %}',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_REMINDER,
    name: "Appointment reminder",
    description: "Both parties, ahead of the start time.",
    category: "appointments",
    inApp: {
      subject: "Coming up",
      body: "Your {{payload.appointmentType}} for {{payload.planTitle}} is coming up — {{payload.dateTime}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_COMPLETED,
    name: "Appointment completed",
    description: "Both parties, when the auto-complete sweep closes a session.",
    category: "appointments",
    inApp: {
      subject: "Session complete",
      body: "Your {{payload.appointmentType}} for {{payload.planTitle}} has ended. Open it to rate the session or find the recording.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.NEW_BOOKING_REQUEST,
    name: "New booking request",
    description: "The consultant, when a request needs their approval.",
    category: "appointments",
    inApp: {
      subject: "New booking request",
      body: "{{payload.consulteeName}} requested a {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.requestedDateTime %} on {{payload.requestedDateTime}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },

  // ── Money ───────────────────────────────────────────────────────────────
  {
    workflowId: W.PAYMENT_SUCCESS,
    name: "Payment received",
    description: "The payer, on capture.",
    category: "payments",
    inApp: {
      subject: "Payment received",
      body: "Payment of {{payload.amountFormatted}} received for {{payload.planTitle}} with {{payload.consultantName}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PAYMENT_FAILED,
    name: "Payment failed",
    description: "The payer. `failureReason` is a sentence.",
    category: "payments",
    inApp: {
      subject: "Payment failed",
      body: "Your payment of {{payload.amountFormatted}}{% if payload.planTitle %} for {{payload.planTitle}}{% endif %} did not go through. {{payload.failureReason}}",
      redirect: "retryUrl",
    },
  },
  {
    workflowId: W.REFUND_REQUESTED,
    name: "Refund requested",
    description: "The consultant and ops, when a refund is raised.",
    category: "payments",
    inApp: {
      subject: "Refund requested",
      body: "A refund of {{payload.amountFormatted}} was requested{% if payload.consultantName %} for a session with {{payload.consultantName}}{% endif %}.{% if payload.reason %} Reason: {{payload.reason}}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFUND_PROCESSED,
    name: "Refund processed",
    description: "The payer, once the gateway confirms the refund.",
    category: "payments",
    inApp: {
      subject: "Refund on its way",
      body: "Your refund of {{payload.amountFormatted}}{% if payload.consultantName %} for the session with {{payload.consultantName}}{% endif %} has been processed. Banks usually post it within 5–7 working days.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFUND_FAILED,
    name: "Refund failed",
    description: "The payer, when the gateway rejects a refund (#779).",
    category: "payments",
    inApp: {
      subject: "Refund needs attention",
      body: "The refund of {{payload.amountFormatted}} could not be completed. Our team will retry it — please contact support if it has not arrived in a few days.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PAYOUT_PROCESSED,
    name: "Payout sent",
    description: "The consultant, when a payout leaves for their bank.",
    category: "payments",
    inApp: {
      subject: "Payout sent",
      body: "A payout of {{payload.amount}} has been sent to your bank account.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DISPUTE_CREATED,
    name: "Dispute opened",
    description: "The consultant and ops, when a chargeback is raised.",
    category: "payments",
    inApp: {
      subject: "Payment dispute",
      body: "A payment dispute of {{payload.amount}} was opened{% if payload.consulteeName %} by {{payload.consulteeName}}{% endif %}{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DISPUTE_RESOLVED,
    name: "Dispute resolved",
    description: "The consultant and ops, when the gateway closes a dispute.",
    category: "payments",
    inApp: {
      subject: "Dispute resolved",
      body: 'The dispute of {{payload.amount}} has been resolved{% if payload.status %} — {{payload.status | downcase | replace: "_", " "}}{% endif %}.',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFERRAL_BONUS_EARNED,
    name: "Referral bonus earned",
    description: "The referrer, when someone they invited completes signup.",
    category: "payments",
    inApp: {
      subject: "Referral bonus",
      body: "{{payload.refereeName}} joined with your link — {{payload.bonusAmount}} in credits has been added to your account.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFEREE_WELCOME_BONUS,
    name: "Welcome bonus",
    description: "The new user who signed up through a referral.",
    category: "payments",
    inApp: {
      subject: "Welcome bonus",
      body: "Welcome! {{payload.bonusAmount}} in credits from {{payload.referrerName}}'s referral has been added to your account.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFERRAL_CREDITS_APPLIED,
    name: "Credits applied",
    description: "The payer, when referral credits reduce a checkout.",
    category: "payments",
    inApp: {
      subject: "Credits applied",
      body: "{{payload.creditsUsed}} in referral credits was applied to your {{payload.appointmentType}}. {{payload.remainingCredits}} remains.",
      redirect: "dashboardUrl",
    },
  },

  // ── Subscriptions & trials ──────────────────────────────────────────────
  {
    workflowId: W.SUBSCRIPTION_STARTED,
    name: "Subscription started",
    description: "The consultee, once the subscription is approved and paid.",
    category: "subscriptions",
    inApp: {
      subject: "Subscription active",
      body: "Your subscription to {{payload.planTitle}} with {{payload.consultantName}} is now active.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUBSCRIPTION_CANCELLED,
    name: "Subscription cancelled",
    description: "Both parties.",
    category: "subscriptions",
    inApp: {
      subject: "Subscription cancelled",
      body: "The subscription to {{payload.planTitle}} has been cancelled.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUBSCRIPTION_RENEWED,
    name: "Subscription renewed",
    description: "The consultee, on renewal.",
    category: "subscriptions",
    inApp: {
      subject: "Subscription renewed",
      body: "Your subscription to {{payload.planTitle}} with {{payload.consultantName}} has renewed for another cycle.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_REQUESTED,
    name: "Trial requested",
    description: "The consultant, when a consultee asks for a free trial.",
    category: "trials",
    inApp: {
      subject: "Trial requested",
      body: "{{payload.consulteeName}} requested a free trial session for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_SCHEDULED,
    name: "Trial scheduled",
    description: "Both parties, once the trial is confirmed.",
    category: "trials",
    inApp: {
      subject: "Trial scheduled",
      body: "The trial session for {{payload.planTitle}} between {{payload.consulteeName}} and {{payload.consultantName}} is scheduled for {{payload.dateTime}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_COMPLETED,
    name: "Trial completed",
    description: "Both parties.",
    category: "trials",
    inApp: {
      subject: "Trial complete",
      body: "The trial session for {{payload.planTitle}} with {{payload.consultantName}} has ended.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_CANCELLED,
    name: "Trial cancelled",
    description: "Both parties.",
    category: "trials",
    inApp: {
      subject: "Trial cancelled",
      body: "The trial session for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %} was cancelled.",
      redirect: "dashboardUrl",
    },
  },

  // ── Support ─────────────────────────────────────────────────────────────
  {
    workflowId: W.SUPPORT_TICKET_CREATED,
    name: "Support ticket opened",
    description: "Ops, when a ticket lands in the queue.",
    category: "support",
    inApp: {
      subject: "New support ticket",
      body: `{{payload.userName | default: "A customer"}} opened ${TICKET}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_ACTIVITY,
    name: "Support ticket activity",
    description:
      "Ops (the assignee, else everyone), when the customer replies or reopens.",
    category: "support",
    inApp: {
      subject: "Ticket activity",
      body: `{{payload.userName | default: "The customer"}} {{payload.activity | default: "replied"}} on ${TICKET}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_UPDATE,
    name: "Support ticket status",
    description: "The ticket's owner, when ops changes its status.",
    category: "support",
    inApp: {
      subject: "Ticket updated",
      body: `Your ticket ${TICKET} is now {{payload.status}}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_RESPONSE,
    name: "Support ticket reply",
    description: "The ticket's owner, when ops replies.",
    category: "support",
    inApp: {
      subject: "Reply from support",
      body: `{{payload.respondedBy | default: "Support"}} replied on ${TICKET}{% if payload.message %}: "{{payload.message | truncate: 140}}"{% endif %}`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.FEEDBACK_RECEIVED,
    name: "Feedback received",
    description: "Admins, when a user sends product feedback.",
    category: "feedback",
    inApp: {
      subject: "New feedback",
      body: '{{payload.userName}} sent feedback{% if payload.category %} ({{payload.category}}){% endif %}: "{{payload.message | truncate: 140}}"',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.NEW_REVIEW_RECEIVED,
    name: "New review",
    description: "The consultant, when a review is published.",
    category: "feedback",
    inApp: {
      subject: "New review",
      body: '{{payload.reviewerName}} left a {{payload.rating}}-star review{% if payload.planTitle %} on {{payload.planTitle}}{% endif %}{% if payload.comment %}: "{{payload.comment | truncate: 140}}"{% endif %}',
      redirect: "dashboardUrl",
    },
  },

  // ── Account & moderation (no opt-out) ───────────────────────────────────
  {
    workflowId: W.VERIFICATION_STATUS_CHANGED,
    name: "Verification status",
    description: "The consultant. `status` is the raw profile enum.",
    category: null,
    inApp: {
      subject: "Verification update",
      body: '{% case payload.status %}{% when "VERIFIED" %}Your profile is verified and now visible to clients.{% when "REJECTED" %}Your profile verification was not approved.{% else %}Your profile verification is pending review.{% endcase %}{% if payload.reason %} {{payload.reason}}{% endif %}',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.NEW_CONSULTANT_APPLICATION,
    name: "Expert application",
    description: "Admins, when someone applies to become an expert.",
    category: null,
    inApp: {
      subject: "New expert application",
      body: "{{payload.applicantName}} ({{payload.applicantEmail}}) applied to become an expert.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.MODERATION_WARNING,
    name: "Moderation warning",
    description: "The reported user, after a staff warning (#693).",
    category: null,
    inApp: {
      subject: "Warning",
      body: "You have received a warning from our moderation team{% if payload.reason %}: {{payload.reason}}{% endif %}. Further reports may lead to suspension.",
    },
  },
  {
    workflowId: W.ACCOUNT_SUSPENDED,
    name: "Account suspended",
    description: "The suspended user (#693, #1604).",
    category: null,
    inApp: {
      subject: "Account suspended",
      body: `Your account is suspended until {{payload.suspendedUntil}}{% if payload.reason %}. Reason: {{payload.reason}}{% endif %}.${CANCELLED_COUNT}`,
    },
  },
  {
    workflowId: W.ACCOUNT_BANNED,
    name: "Account closed",
    description: "The banned user (#693, #1604).",
    category: null,
    inApp: {
      subject: "Account closed",
      body: `Your account has been permanently closed{% if payload.reason %}. Reason: {{payload.reason}}{% endif %}.${CANCELLED_COUNT}`,
    },
  },
  {
    workflowId: W.GENERAL_ANNOUNCEMENT,
    name: "Announcement",
    description: "Everyone. Admin-authored title and body.",
    category: null,
    inApp: {
      subject: "{{payload.title}}",
      body: "{{payload.content}}",
      redirect: "linkUrl",
    },
  },
  {
    workflowId: W.MAINTENANCE_SCHEDULED,
    name: "Maintenance scheduled",
    description: "Everyone, ahead of a maintenance window.",
    category: null,
    inApp: {
      subject: "Scheduled maintenance",
      body: "Maintenance is coming up{% if payload.estimatedEnd %}; we expect to be back by {{payload.estimatedEnd}}{% endif %}.{% if payload.reason %} {{payload.reason}}{% endif %}",
    },
  },
  {
    workflowId: W.MAINTENANCE_STARTED,
    name: "Maintenance started",
    description: "Everyone, as the window opens.",
    category: null,
    inApp: {
      subject: "Under maintenance",
      body: "Familiarise is under maintenance{% if payload.estimatedEnd %} and should be back by {{payload.estimatedEnd}}{% endif %}.{% if payload.reason %} {{payload.reason}}{% endif %}",
    },
  },
  {
    workflowId: W.MAINTENANCE_ENDED,
    name: "Maintenance ended",
    description: "Everyone, once the window closes.",
    category: null,
    inApp: {
      subject: "Back online",
      body: "Maintenance is finished — everything is back to normal.",
    },
  },

  // ── Recordings & documents ──────────────────────────────────────────────
  {
    workflowId: W.RECORDING_AVAILABLE,
    name: "Recording ready",
    description: "Both parties, once a recording is published.",
    category: "appointments",
    inApp: {
      subject: "Recording ready",
      body: "A recording from your {{payload.appointmentType}} is ready to watch.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.RECORDING_FAILED,
    name: "Recording failed",
    description: "The host, when Stream could not save a recording.",
    category: "appointments",
    inApp: {
      subject: "Recording failed",
      body: "A recording could not be saved{% if payload.errorMessage %}: {{payload.errorMessage}}{% endif %}. The call itself was not affected.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.RECORDING_EXPIRING,
    name: "Recordings expiring",
    description: "The host, before Stream-only recordings lapse (STR-3).",
    category: "appointments",
    inApp: {
      subject: "Recordings expiring",
      body: "{{payload.recordingCount}} recording{% if payload.recordingCount != 1 %}s{% endif %} will expire on {{payload.expiresAt}}. Download anything you want to keep before then.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DOCUMENT_UPLOADED,
    name: "Document shared",
    description: "The other party, when a document is uploaded to a booking.",
    category: "appointments",
    inApp: {
      subject: "Document shared",
      body: '{% if payload.uploadedByRole == "CONSULTEE" %}{{payload.consulteeName}}{% else %}{{payload.consultantName}}{% endif %} shared {{payload.fileName}}{% if payload.versionNo > 1 %} (version {{payload.versionNo}}){% endif %}.',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DOCUMENT_REVIEWED,
    name: "Document reviewed",
    description: "The uploader, when the consultant records a decision.",
    category: "appointments",
    inApp: {
      subject: "Document reviewed",
      body: '{{payload.consultantName}} {% case payload.reviewStatus %}{% when "APPROVED" %}approved{% when "REJECTED" %}declined{% when "NEEDS_REVISION" %}sent back{% when "IN_REVIEW" %}is reviewing{% else %}has queued{% endcase %} {{payload.originalName}}.{% if payload.reviewNotes %} "{{payload.reviewNotes | truncate: 140}}"{% endif %}',
      redirect: "dashboardUrl",
    },
  },

  // ── Collaborators ───────────────────────────────────────────────────────
  {
    workflowId: W.COLLABORATOR_INVITED,
    name: "Collaborator invited",
    description: "The invited consultant.",
    category: "appointments",
    inApp: {
      subject: "Collaboration invite",
      body: '{{payload.ownerName}} invited you to join {{payload.planTitle}} ({{payload.planType | downcase}}) as {{payload.role | downcase | replace: "_", " "}} with a {{payload.revenueSharePercentage}}% revenue share.',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_ACCEPTED,
    name: "Collaborator accepted",
    description: "The plan's owner.",
    category: "appointments",
    inApp: {
      subject: "Invite accepted",
      body: '{{payload.collaboratorName}} accepted your invitation to {{payload.planTitle}} as {{payload.role | downcase | replace: "_", " "}}.',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_REMOVED,
    name: "Collaborator removed",
    description: "The removed consultant.",
    category: "appointments",
    inApp: {
      subject: "Removed from a plan",
      body: "You are no longer a collaborator on {{payload.planTitle}} ({{payload.planType | downcase}}).",
      redirect: "dashboardUrl",
    },
  },
];
