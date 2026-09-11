/**
 * Admin User Detail API
 * GET /api/admin/users/[userId] - Get detailed user information
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";

interface RouteParams {
  params: Promise<{ userId: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { userId } = await params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        bio: true,
        email: true,
        phone: true,
        image: true,
        role: true,
        onboardingCompleted: true,
        createdAt: true,
        city: true,
        country: true,
        consultantProfile: {
          select: {
            id: true,
            headline: true,
            description: true,
            isVerified: true,
            verificationStatus: true,
            domain: { select: { id: true, name: true } },
            experience: true,
          },
        },
        consulteeProfile: {
          select: {
            id: true,
            skillsToDevelop: true,
          },
        },
        staffProfile: {
          select: {
            id: true,
            department: true,
            position: true,
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ user });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching user details:", error);
    return NextResponse.json(
      { error: "Failed to fetch user details" },
      { status: 500 },
    );
  }
}
