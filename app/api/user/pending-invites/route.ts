/**
 * GET /api/user/pending-invites
 *
 * #840 — checks whether the authenticated user's email has any pending
 * organization invitation. The onboarding role-picker fetches this before
 * rendering: if there's a pending invite, the invitee sees "You've been
 * invited" instead of being forced through Consultant/Consultee/OrgOwner
 * tiles that create unwanted profiles.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";

export async function GET() {
  const session = await getSession();
  if (!session?.user?.email) {
    return NextResponse.json({ invites: [] });
  }

  // E2E-audit P1 fix — expired invitations are no longer returned. The
  // onboarding role-picker replaces itself with a non-dismissible "you've
  // been invited" panel whenever this returns a row, so an expired-but-
  // still-pending invite used to lock that user out of onboarding forever:
  // the emailed link 410s, acceptance returns 410, but this endpoint kept
  // saying "invited" with no skip affordance and no role tiles.
  const now = new Date();

  const invites = await prisma.invitation.findMany({
    where: {
      email: session.user.email.toLowerCase(),
      status: "pending",
      // expiresAt is required on Invitation, so "unexpired" is a single gt.
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      organizationId: true,
      role: true,
      createdAt: true,
      organization: {
        select: { id: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  // Expired rows are cleaned up lazily so they cannot resurface elsewhere.
  await prisma.invitation.updateMany({
    where: {
      email: session.user.email.toLowerCase(),
      status: "pending",
      expiresAt: { lte: now },
    },
    data: { status: "expired" },
  });

  return NextResponse.json({
    invites: invites.map((inv) => ({
      invitationId: inv.id,
      organizationId: inv.organizationId,
      organizationName: inv.organization?.name ?? "Unknown",
      role: inv.role,
    })),
  });
}
