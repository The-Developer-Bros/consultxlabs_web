/**
 * DELETE /api/organizations/[orgId]/scim/tokens/[tokenId]
 *
 * Soft-revoke a SCIM token. The row stays in `ScimToken` (status
 * flipped to REVOKED + `revokedAt` stamped) so subsequent IdP poll
 * attempts get a clear `401 "Token has been revoked"` response AND
 * trip the `SCIM_TOKEN_USED_AFTER_REVOKE` audit row. A hard-delete
 * would just give the IdP a vanilla `401 Unknown token` and lose the
 * "you forgot to update Okta after rotating" signal.
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
    params: Promise<{ orgId: string; tokenId: string }>;
  },
) {
  const { orgId, tokenId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const token = await tx.scimToken.findFirst({
        where: { id: tokenId, organizationId: orgId },
      });
      if (!token) {
        throw Object.assign(new Error("SCIM token not found"), {
          httpStatus: 404,
        });
      }
      if (token.status === "REVOKED") {
        // Idempotent — calling DELETE twice on a revoked token is a no-op
        // (the IdP may retry the click). Return 204 either way so callers
        // can't distinguish "I just revoked this" from "already revoked".
        return;
      }
      await tx.scimToken.update({
        where: { id: tokenId },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_TOKEN_REVOKED,
          description: `Revoked SCIM token '${token.label}'`,
          details: { tokenId, label: token.label },
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
