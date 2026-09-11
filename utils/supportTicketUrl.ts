import { SupportIssueType, SupportPriority } from "@prisma/client";

/**
 * Support ticket URL utility for contextual ticket creation
 * Generates URLs with pre-filled context from appointments/payments
 */

export type AppointmentStatus = "COMPLETED" | "UPCOMING";

/**
 * Priority options for support tickets
 */
export const PRIORITY_OPTIONS: {
  value: SupportPriority;
  label: string;
  color: string;
}[] = [
  { value: "LOW", label: "Low", color: "text-green-600" },
  { value: "MEDIUM", label: "Medium", color: "text-amber-600" },
  { value: "HIGH", label: "High", color: "text-orange-600" },
  { value: "URGENT", label: "Urgent", color: "text-red-600" },
];

/**
 * #support-hub — issue types the PLATFORM-level form may offer. Session-scoped
 * types ("consultant didn't show up", cancellation help…) are deliberately
 * absent: they describe what happened IN a session, so they are raised on the
 * appointment's "Get help" flowchart thread, which routes them with full
 * context. The server enforces the same line (422 on session-scoped types).
 */
export const PLATFORM_ISSUE_TYPE_CATEGORIES = {
  "Payment Issues": [
    SupportIssueType.PAYMENT_FAILED,
    SupportIssueType.CHARGED_TWICE,
    SupportIssueType.REFUND_REQUEST,
    SupportIssueType.BILLING_QUESTION,
  ],
  "Account & Access": [
    SupportIssueType.ACCOUNT_ISSUE,
    SupportIssueType.TECHNICAL_ISSUES,
  ],
  General: [SupportIssueType.GENERAL_INQUIRY, SupportIssueType.OTHER],
} as const;

/**
 * Human-readable labels for issue types
 */
export const ISSUE_TYPE_LABELS: Record<SupportIssueType, string> = {
  // Session Issues
  [SupportIssueType.CONSULTANT_NO_SHOW]: "Consultant didn't show up",
  [SupportIssueType.CONSULTANT_LATE]: "Consultant was late",
  [SupportIssueType.SESSION_ENDED_EARLY]: "Session ended earlier than expected",
  [SupportIssueType.SESSION_QUALITY_POOR]: "Poor session quality",
  [SupportIssueType.COMMUNICATION_ISSUE]: "Audio/video problems during call",
  // Platform-scoped ON PURPOSE. An unqualified "Technical issues" on the
  // platform form is the one item a user whose CALL broke reaches for, and
  // that ticket then arrives with no session attached. In-session audio/video
  // trouble is COMMUNICATION_ISSUE (session-scoped, raised from the
  // appointment's Get help).
  [SupportIssueType.TECHNICAL_ISSUES]: "Site or app not working",
  [SupportIssueType.WRONG_CONSULTANT]: "Wrong consultant assigned",

  // Access & Scheduling
  [SupportIssueType.ACCESS_ISSUE]: "Cannot join or access session",
  [SupportIssueType.TIMEZONE_CONFUSION]: "Wrong time zone displayed",
  [SupportIssueType.RESCHEDULING_HELP]: "Need help rescheduling",

  // Payment Issues
  [SupportIssueType.PAYMENT_FAILED]: "Payment failed",
  [SupportIssueType.CHARGED_TWICE]: "Charged twice",
  [SupportIssueType.REFUND_REQUEST]: "Refund request",
  [SupportIssueType.BILLING_QUESTION]: "Invoice or receipt inquiry",

  // Documents
  [SupportIssueType.DOCUMENT_ISSUE]: "Materials not received or incorrect",

  // Cancellation
  [SupportIssueType.WANT_TO_CANCEL]: "Want to cancel booking",
  [SupportIssueType.CANCELLATION_ISSUE]: "Issue with cancellation",

  // General
  [SupportIssueType.ACCOUNT_ISSUE]: "Account issue",
  [SupportIssueType.GENERAL_INQUIRY]: "General inquiry",
  [SupportIssueType.OTHER]: "Other",
};

/**
 * #705 — how a ticket is named on screen. Prefer the minted reference; fall back
 * to the LAST eight characters of the uuid for tickets that predate it. One
 * definition because there were two: the staff table truncated from the front
 * and the staff home from the back, so the same ticket had two names.
 */
export function ticketLabel(ticket: {
  referenceNumber?: string | null;
  id: string;
}): string {
  return ticket.referenceNumber ?? ticket.id.slice(-8).toUpperCase();
}
