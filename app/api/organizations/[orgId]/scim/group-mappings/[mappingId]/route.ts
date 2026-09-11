/**
 * DELETE /api/organizations/[orgId]/scim/group-mappings/[mappingId]
 *
 * Remove a SCIM group → MemberRole mapping. Existing memberships are
 * NOT mutated by this — they keep whichever role they had at last
 * provisioning. Re-provisioning a user without the mapping in place
 * downgrades them to LEARNER per the least-privilege default in
 * `resolveRoleFromGroupNames`.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; mappingId: string }>;
  },
) {
  const { orgId, mappingId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.scimGroupMapping.findFirst({
        where: { id: mappingId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Group mapping not found"), {
          httpStatus: 404,
        });
      }
      await tx.scimGroupMapping.delete({ where: { id: mappingId } });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_GROUP_UNMAPPED,
          description: `Removed SCIM group mapping '${current.scimGroupName}'`,
          details: {
            scimGroupName: current.scimGroupName,
            role: current.role,
          },
        },
      });
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      return NextResponse.json(
        { error: err.message },
        { status: (err as { httpStatus?: number }).httpStatus ?? 500 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }
}
