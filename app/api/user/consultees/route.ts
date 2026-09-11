import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN/STAFF can list all consultees
    if (!isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "Only administrators and staff can list all consultees",
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    // Calculate offset
    const skip = (page - 1) * limit;

    const consultees = await prisma.consulteeProfile.findMany({
      include: {
        consultantReviews: { where: { deletedAt: null } },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      skip,
      take: limit,
    });

    return NextResponse.json(consultees, { status: 200 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    console.error("Error getting consultees:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
