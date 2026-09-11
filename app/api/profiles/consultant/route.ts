import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  consultantPublicScalars,
  consultantPublicApiSchema,
} from "@/lib/data/consultant-public";

/**
 * GET /api/profiles/consultant
 * Get consultant profile by user ID
 * Query params:
 * - userId: The user ID to get the consultant profile for
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    const consultantProfile = await prisma.consultantProfile.findFirst({
      // Public endpoint — gate to verified, non-deleted profiles (#946)
      where: { userId, verificationStatus: "VERIFIED", deletedAt: null },
      select: {
        ...consultantPublicScalars,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        domain: true,
        subDomains: true,
        tags: true,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      // Zod output contract: passes the row through, but FAILS CLOSED (throws) if
      // any statutory-PII key is ever present — defense-in-depth over the select. (#946)
      data: consultantPublicApiSchema.parse(consultantProfile),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error fetching consultant profile:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch consultant profile",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
