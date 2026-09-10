/**
 * #support-hub — ONE authz gate for the appointment-scoped support routes
 * (detail, feedback, support thread). The support and feedback routes used to
 * carry twin `authorize` copies — Sonar flagged them as PR-wide duplication;
 * this is the single definition.
 *
 * The org-party branch (#support-hub, ADR 20) grants an org OPERATOR their OWN
 * conversation on their org's appointment — org-party intents only, never
 * anyone else's transcript. The grant is OPT-IN via the `orgParty` flag and
 * the return type narrows accordingly, so a route with no org-party surface
 * (detail, feedback) cannot silently accept the operator grant.
 */

import type { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import prisma from "@/lib/prisma";
import {
  readAppointmentDetail,
  canAccessAppointment,
  type TAppointmentDetail,
} from "@/lib/data/appointment-detail";
import { supportError } from "@/lib/api/support-http";

/** Coded authz failure — map through `appointmentAuthzError`. */
export type CodedAuthz = {
  code: "UNAUTHORIZED" | "NOT_FOUND" | "FORBIDDEN";
  status: number;
};

/** Org-party success — METADATA ONLY. `detail` is deliberately absent: the
 *  full appointment graph (recordings, payment, participants, sibling slots)
 *  must never be reachable through an org operator's grant (ADR 20), not even
 *  by a future consumer's convenience. */
export type PartyAuthz = {
  userId: string;
  isOrgParty: true;
  /** The appointment's owning org (org-party intent scoping). */
  organizationId: string | null;
};

/** Participant/staff success — carries the already-loaded detail so callers
 *  needing the payload reuse it instead of paying a second read. */
export type ParticipantAuthz = {
  userId: string;
  isOrgParty: false;
  /** The appointment's owning org (CSAT attribution). */
  organizationId: string | null;
  detail: TAppointmentDetail;
};

export async function authorizeAppointment(
  appointmentId: string,
  orgParty: true,
): Promise<CodedAuthz | PartyAuthz>;
export async function authorizeAppointment(
  appointmentId: string,
  orgParty?: false,
): Promise<CodedAuthz | ParticipantAuthz>;
export async function authorizeAppointment(
  appointmentId: string,
  orgParty = false,
): Promise<CodedAuthz | PartyAuthz | ParticipantAuthz> {
  const session = await getSession();
  if (!session?.user?.id) return { code: "UNAUTHORIZED", status: 401 };
  const detail = await readAppointmentDetail(appointmentId);
  if (!detail) return { code: "NOT_FOUND", status: 404 };
  const organizationId = detail.appointment.organizationId ?? null;
  if (canAccessAppointment(session.user.id, detail)) {
    return { userId: session.user.id, isOrgParty: false, organizationId, detail };
  }
  if (isPrivileged(session.user.role)) {
    return { userId: session.user.id, isOrgParty: false, organizationId, detail };
  }
  // #support-hub — org-party branch. Grants the operator their OWN thread on
  // this appointment (org-party intents only); never widens read access to
  // another user's conversation. Only routes that declare an org-party
  // surface may take this branch — and the grant returns no session content.
  if (orgParty) {
    if (organizationId) {
      const membership = await prisma.membership.findFirst({
        where: {
          userId: session.user.id,
          organizationId,
          status: "ACTIVE",
        },
        select: { role: true },
      });
      if (membership && hasOrgPermission(membership.role, "operations.read")) {
        return { userId: session.user.id, isOrgParty: true, organizationId };
      }
    }
  }
  return { code: "FORBIDDEN", status: 403 };
}

/** Map a coded authz failure onto the support error envelope. */
export function appointmentAuthzError(
  auth: CodedAuthz,
  context: Record<string, unknown>,
): NextResponse {
  return supportError({ status: auth.status, code: auth.code, context });
}
