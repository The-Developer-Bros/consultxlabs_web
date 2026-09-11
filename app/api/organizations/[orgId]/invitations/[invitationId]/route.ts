/**
 * GET    /api/organizations/[orgId]/invitations/[invitationId]
 * DELETE /api/organizations/[orgId]/invitations/[invitationId]
 *
 * DELETE soft-cancels a pending invitation so the accept endpoint will
 * reject the token. We keep the row with status=canceled instead of
 * hard-deleting so audit trails stay intact and the inviter can see
 * that it was revoked rather than it silently disappearing from the
 * list.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invitationId: string }>;
  },
) {
  const { orgId, invitationId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId: orgId },
  });
  if (!invitation) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  return NextResponse.json({ invitation });
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invitationId: string }>;
  },
) {
  const { orgId, invitationId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  // Conditional update: only pending invitations are revocable. An
  // already-accepted or already-canceled row is left untouched so the
  // audit log doesn't double-emit REVOKE on retry.
  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.invitation.updateMany({
      where: {
        id: invitationId,
        organizationId: orgId,
        status: "pending",
      },
      data: { status: "canceled" },
    });
    if (updated.count === 0) return { revoked: false };

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "MEMBER",
        action: AUDIT_ACTIONS.MEMBER.INVITE_REVOKED,
        description: `Revoked invitation ${invitationId}`,
        details: { invitationId },
      },
    });
    return { revoked: true };
  });

  if (!result.revoked) {
    return NextResponse.json(
      { error: "Invitation not pending (may already be accepted or canceled)" },
      { status: 409 },
    );
  }
  return new NextResponse(null, { status: 204 });
}
