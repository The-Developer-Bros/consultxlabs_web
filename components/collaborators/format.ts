/**
 * Formatting helpers + label maps for the collaborations surface.
 *
 * CollaboratorStatus (PENDING/ACCEPTED) is deliberately NOT in
 * lib/labels/session-labels.ts (it's a two-value invitation state, not a
 * session lifecycle enum) — the map here follows the same pill
 * conventions so the badges render consistently.
 */

import type { StatusBadgeStyle } from "@/lib/labels/session-labels";

export function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatRole(role: string): string {
  const labels: Record<string, string> = {
    CO_HOST: "Co-Host",
    MODERATOR: "Moderator",
    GUEST_SPEAKER: "Guest Speaker",
    TECHNICAL_SUPPORT: "Technical Support",
    CO_INSTRUCTOR: "Co-Instructor",
    TEACHING_ASSISTANT: "TA",
    GUEST_LECTURER: "Guest Lecturer",
    CONTENT_CREATOR: "Content Creator",
  };
  return labels[role] || role.replace(/_/g, " ");
}

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  CO_HOST: "Co-hosts can manage the session alongside the owner",
  MODERATOR: "Moderators manage participants and Q&A during sessions",
  GUEST_SPEAKER: "Guest speakers present during specific session segments",
  TECHNICAL_SUPPORT:
    "Technical support handles session setup and troubleshooting",
  CO_INSTRUCTOR: "Co-instructors teach alongside the primary instructor",
  TEACHING_ASSISTANT: "TAs assist with student questions and grading",
  GUEST_LECTURER: "Guest lecturers present on specific topics",
  CONTENT_CREATOR: "Content creators prepare materials and resources",
};

export const COLLABORATOR_STATUS_BADGE: Record<
  "PENDING" | "ACCEPTED",
  StatusBadgeStyle
> = {
  PENDING: {
    label: "Pending",
    className: "bg-amber-100 text-amber-900 border-amber-200",
  },
  ACCEPTED: {
    label: "Accepted",
    className: "bg-emerald-100 text-emerald-900 border-emerald-200",
  },
};
