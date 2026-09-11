/**
 * POST /api/organizations/[orgId]/verification/resubmit
 *
 * #779 §A — self-serve verification resubmit. After a platform admin
 * rejects an org (status stays PENDING_VERIFICATION, `verificationReason`
 * + `verificationRejectedAt` set), an OWNER/MAINTAINER fixes the issue and
 * re-submits: bumps `verificationSubmittedAt`, clears the reason +
 * rejection stamp so the admin queue picks it up fresh.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.organization.findUnique({
        where: { id: orgId },
        select: {
          status: true,
          verificationRejectedAt: true,
        },
      });
      // requireOrgAccess already 404s a missing org; this is defensive.
      if (!current) {
        throw Object.assign(new Error("Organization not found"), {
          httpStatus: 404,
        });
      }

      // #779 §A — only a previously-rejected, still-pending org can resubmit.
      if (
        current.status !== "PENDING_VERIFICATION" ||
        current.verificationRejectedAt === null
      ) {
        throw Object.assign(new Error("NOTHING_TO_RESUBMIT"), {
          httpStatus: 409,
        });
      }

      const next = await tx.organization.update({
        where: { id: orgId },
        data: {
          verificationSubmittedAt: new Date(),
          verificationReason: null,
          verificationRejectedAt: null,
        },
        select: {
          status: true,
          verificationReason: true,
          verificationSubmittedAt: true,
          verificationRejectedAt: true,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.VERIFICATION_RESUBMITTED,
          description: "Verification resubmitted",
          details: { resubmittedAt: next.verificationSubmittedAt?.toISOString() },
        },
      });

      return next;
    });

    return NextResponse.json({ verification: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
