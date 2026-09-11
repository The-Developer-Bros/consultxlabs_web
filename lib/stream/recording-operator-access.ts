/**
 * Operator (ADMIN / STAFF) access to session recordings — #1270.
 *
 * A recording is the audio and video of a private session between two people
 * who agreed to record it for each other, not for us. Until this module
 * existed, every route that touched a recording asked `isPrivileged(role)` and
 * treated the answer as a blanket yes: any staff member could pull a playback
 * URL for any 1:1 they had no relationship to, and nothing anywhere recorded
 * that they had. The operator path was less accountable than the tenant path,
 * where deleting or exporting a recording already wrote an audit row.
 *
 * Two rules, enforced here so no route can restate them differently:
 *
 *   1. The grant is resolved through `BACKOFFICE_PERMISSIONS`, which is the
 *      declared single source of truth for who reaches which internal surface.
 *      `recordings.read` (metadata) is ADMIN + STAFF; `recordings.play` (a URL
 *      that renders the session) is ADMIN only.
 *   2. Every privileged read writes an audit trail before the response is
 *      built, whether or not it ends in playback.
 */

import prisma from "@/lib/prisma";
import type { UserRole } from "@prisma/client";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { recordSystemEvent } from "@/lib/enterprise/system-events";

/** `SystemEvent.category` for the operator recording trail. */
export const RECORDING_ACCESS_EVENT_CATEGORY = "STREAM_RECORDING_ACCESS";

export type OperatorRecordingAccess = {
  /** Holds `recordings.read` — may see status, timing and storage metadata. */
  canRead: boolean;
  /** Holds `recordings.play` — may be handed a URL that plays the session. */
  canPlay: boolean;
};

const NO_ACCESS: OperatorRecordingAccess = { canRead: false, canPlay: false };

/**
 * Resolve what a platform role may do with a recording it has no participation
 * in. Callers must still run their ownership / entitlement paths — this only
 * answers the operator question.
 */
export function resolveOperatorRecordingAccess(
  role: string | null | undefined,
): OperatorRecordingAccess {
  // The matrix is keyed by UserRole; anything else (a null role on a
  // half-provisioned session, a value from an older cookie) is not an operator.
  if (role !== "ADMIN" && role !== "STAFF") return NO_ACCESS;
  const userRole = role as UserRole;
  return {
    canRead: hasBackofficePermission(userRole, "recordings.read"),
    canPlay: hasBackofficePermission(userRole, "recordings.play"),
  };
}

export type OperatorRecordingAuditParams = {
  actorUserId: string;
  actorRole: string;
  /** Which endpoint served the read — distinguishes the trail's origins. */
  surface: string;
  /** Whether the response carried a URL that plays the session. */
  played: boolean;
  recordingId?: string | null;
  meetingSessionId?: string | null;
  streamCallId?: string | null;
  /** Set when the session belongs to a tenant, so the tenant sees the read. */
  organizationId?: string | null;
};

/**
 * Record one privileged recording read.
 *
 * Two sinks, deliberately:
 *
 *   - `OrgAuditLog`, when the session belongs to an organization, so the
 *     tenant can see that a platform operator reached into their sessions.
 *     `actorMembershipId` is null because the operator is acting as the
 *     platform, not as a member — the actor identity lives in `details`.
 *     This write is NOT swallowed: it mirrors the sibling compliance export at
 *     `app/api/organizations/[orgId]/stream/calls/route.ts`, where a read that
 *     cannot be audited is not served.
 *   - `SystemEvent`, always, so B2C recordings (which have no tenant to write
 *     to) still leave a trail. `recordSystemEvent` is best-effort by its own
 *     contract; there is no platform-wide audit table to write to instead and
 *     adding one is a schema change, so this is the honest ceiling today.
 */
export async function auditOperatorRecordingAccess(
  params: OperatorRecordingAuditParams,
): Promise<void> {
  const details = {
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    surface: params.surface,
    played: params.played,
    recordingId: params.recordingId ?? null,
    meetingSessionId: params.meetingSessionId ?? null,
    streamCallId: params.streamCallId ?? null,
  };

  const summary = params.played
    ? "Platform operator opened a recording for playback"
    : "Platform operator read recording metadata";

  if (params.organizationId) {
    await prisma.orgAuditLog.create({
      data: {
        organizationId: params.organizationId,
        actorMembershipId: null,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_ACCESSED,
        description: summary,
        details,
      },
    });
  }

  await recordSystemEvent({
    organizationId: params.organizationId ?? null,
    category: RECORDING_ACCESS_EVENT_CATEGORY,
    // WARN rather than INFO: reaching into someone else's session is rare and
    // should stand out when an on-call human scans the platform trail.
    severity: "WARN",
    message: summary,
    context: details,
    correlationId: params.recordingId ?? params.meetingSessionId ?? null,
    // For a B2C recording this row is the ONLY audit trail — there is no
    // organization to carry an OrgAuditLog entry. Serving the read anyway when
    // the insert failed would mean an unaudited operator access, which is the
    // one thing this function exists to prevent.
    strict: true,
  });
}
