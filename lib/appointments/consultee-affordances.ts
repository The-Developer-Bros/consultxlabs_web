/**
 * #1005 — which consultee overflow actions are honest for each appointment kind.
 *
 * Server routes already 403 impossible actions; the UI must not offer them.
 */

import type { AppointmentKind } from "@/lib/appointments/view-model";

export type ConsulteeDestructiveAction =
  | "cancel-booking"
  | "cancel-trial"
  | "leave-event"
  | "none";

/** Reschedule is 1:1 only — group events are organiser-managed; trials have no path. */
export function consulteeMayReschedule(kind: AppointmentKind): boolean {
  return kind === "CONSULTATION" || kind === "SUBSCRIPTION";
}

/** What destructive action the overflow menu should offer. */
export function consulteeDestructiveAction(
  kind: AppointmentKind,
): ConsulteeDestructiveAction {
  switch (kind) {
    case "CONSULTATION":
    case "SUBSCRIPTION":
      return "cancel-booking";
    case "TRIAL":
      return "cancel-trial";
    case "WEBINAR":
    case "CLASS":
      return "leave-event";
    default:
      return "none";
  }
}

/**
 * A live reschedule proposal as the reads select it (#1163). Structural, not
 * Prisma-derived: the payload crosses JSON on the client path, so Date fields
 * may arrive as strings.
 */
export interface OpenRescheduleProposal {
  id: string;
  status: string;
  reason: string | null;
  round: number;
  expiresAt: string | Date;
  initiatorRole: string;
  initiatedById: string;
  proposedSlots: {
    startsAt: string | Date;
    endsAt: string | Date;
    round: number;
  }[];
}

type AppointmentWithProposals =
  | { id: string; rescheduleRequests?: OpenRescheduleProposal[] }
  | null
  | undefined;

/**
 * The open proposal on a row, and WHICH appointment carries it.
 *
 * The reads already narrow `rescheduleRequests` to open statuses and take one,
 * so presence is the whole test. The id matters because a subscription row
 * anchors on its next actionable child while the proposal may sit on another
 * child — navigating to the anchor would land on a detail page with no card.
 */
export function openProposalTarget(
  appointments: readonly AppointmentWithProposals[],
): { appointmentId: string; proposal: OpenRescheduleProposal } | null {
  for (const appointment of appointments) {
    const proposal = appointment?.rescheduleRequests?.[0];
    if (proposal) return { appointmentId: appointment.id, proposal };
  }
  return null;
}

/** The times currently on offer — a COUNTERED request carries both rounds. */
export function currentRoundProposedSlots(
  proposal: Pick<OpenRescheduleProposal, "round" | "proposedSlots">,
): OpenRescheduleProposal["proposedSlots"] {
  return proposal.proposedSlots.filter((slot) => slot.round === proposal.round);
}
