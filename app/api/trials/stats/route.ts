import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";

/**
 * GET /api/trials/stats
 * Returns summary counts of trial sessions grouped by status
 */
export async function GET(request: NextRequest) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");

  if (!consultantProfileId) {
    return NextResponse.json(
      { error: "consultantProfileId is required" },
      { status: 400 },
    );
  }

  // Non-privileged users can only view their own trial stats
  if (
    !isPrivileged(session.user.role) &&
    session.user.consultantProfileId !== consultantProfileId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const counts = await prisma.trialSession.groupBy({
      by: ["status"],
      where: { consultantProfileId },
      _count: { status: true },
    });

    const data = Object.fromEntries(
      counts.map((c) => [c.status, c._count.status]),
    );

    return NextResponse.json({ data });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "trials" } });
    console.error("Error fetching trial stats:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial stats" },
      { status: 500 },
    );
  }
}
