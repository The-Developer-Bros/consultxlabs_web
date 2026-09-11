/**
 * Lifecycle bucketing for the appointments VM. One place decides which tab
 * (Upcoming / Needs action / Past / Cancelled) a row belongs to; schedule
 * proximity ("Today", "in 45 min") is deliberately NOT a status here — it is
 * derived display text (slots.getProximityLabel), fixing the consultant
 * page's old conflation of proximity and lifecycle in a single badge.
 */

import {
  isCancelledLikeStatus,
  isCompletedLikeStatus,
  isPendingPaymentStatus,
  isPendingStatus,
  normalizeStatus,
} from "./status";
import { activeSessions, allSessionsOver } from "./slots";
import type {
  AppointmentBucket,
  NeedsActionReason,
  SessionVM,
} from "./view-model";

export interface BucketInput {
  status: string | null | undefined;
  sessions: SessionVM[];
  /** Consultant-side event with no Appointment rows yet — always needs scheduling. */
  isUnscheduled?: boolean;
  now?: Date;
}

export interface BucketResult {
  bucket: AppointmentBucket;
  needsActionReason: NeedsActionReason | null;
}

export function deriveBucket(input: BucketInput): BucketResult {
  const { sessions, isUnscheduled } = input;
  const now = input.now ?? new Date();
  const status = normalizeStatus(input.status);

  if (isCancelledLikeStatus(status)) {
    return { bucket: "cancelled", needsActionReason: null };
  }
  if (isCompletedLikeStatus(status)) {
    return { bucket: "past", needsActionReason: null };
  }
  if (isUnscheduled) {
    return { bucket: "needsAction", needsActionReason: "UNSCHEDULED" };
  }
  if (isPendingPaymentStatus(status)) {
    return { bucket: "needsAction", needsActionReason: "PAY_NOW" };
  }
  if (isPendingStatus(status)) {
    return { bucket: "needsAction", needsActionReason: "PENDING_APPROVAL" };
  }
  if (allSessionsOver(sessions, now)) {
    return { bucket: "past", needsActionReason: null };
  }

  const active = activeSessions(sessions);
  if (active.length > 0 && active.every((s) => s.isTentative)) {
    return { bucket: "needsAction", needsActionReason: "TENTATIVE" };
  }

  return { bucket: "upcoming", needsActionReason: null };
}
