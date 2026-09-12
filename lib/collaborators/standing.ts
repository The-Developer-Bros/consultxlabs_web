import type { Tx } from "@/lib/prisma";

/** One plan whose collaborator row left PENDING/ACCEPTED; phase 2 revokes it. */
export interface CollaborationRef {
  planType: "webinar" | "class";
  planId: string;
}

/**
 * Move every PENDING/ACCEPTED collaborator row of a user to REMOVED and
 * return the plans touched, so the caller can run `revokeCollaboratorAccess`
 * per plan once its transaction commits. Shared by the moderation ban
 * (#1580 C-P0-4) and DPDP erasure (#1580 C-P1). REMOVED is final: neither
 * reinstatement nor anything else restores a row; the host re-invites.
 *
 * Kept apart from `service.ts` because that module pulls Stream, Novu and
 * the URL helpers, which the moderation transaction must not load.
 */
export async function removeCollaboratorStanding(
  tx: Tx,
  targetUserId: string,
): Promise<CollaborationRef[]> {
  const target = await tx.user.findUnique({
    where: { id: targetUserId },
    select: { consultantProfileId: true },
  });
  if (!target?.consultantProfileId) return [];

  // One statement, so the plans handed to the revocation are exactly the rows
  // flipped — a re-invite landing between a read and a write cannot slip past.
  const rows = await tx.collaborator.updateManyAndReturn({
    where: {
      consultantProfileId: target.consultantProfileId,
      status: { in: ["PENDING", "ACCEPTED"] },
    },
    data: { status: "REMOVED", respondedAt: new Date() },
    select: { collaboratorType: true, webinarPlanId: true, classPlanId: true },
  });

  return rows.flatMap((row) => {
    const planId =
      row.collaboratorType === "WEBINAR" ? row.webinarPlanId : row.classPlanId;
    if (!planId) return [];
    const planType = row.collaboratorType === "WEBINAR" ? "webinar" : "class";
    return [{ planType, planId } as CollaborationRef];
  });
}
