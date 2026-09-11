/**
 * GET /api/user/org-memberships
 *
 * #support-hub — the signed-in user's ACTIVE organization memberships, so the
 * Support hub's session picker can merge org-hosted sessions (personal scope
 * pins `organizationId: null` by design, ADR 19) and tag them with the org
 * name. Read-only, session-keyed, no content.
 */

import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";

const MEMBERSHIPS_ROUTE = "user.org-memberships";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }

    const memberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: {
        organizationId: true,
        role: true,
        organization: { select: { name: true } },
      },
    });

    return NextResponse.json({
      data: memberships.map((m) => ({
        organizationId: m.organizationId,
        orgName: m.organization.name,
        role: m.role,
      })),
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: MEMBERSHIPS_ROUTE, action: "list" },
    });
  }
}
