import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, UserRole } from "@prisma/client";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    // Parse query parameters
    const searchParams = req.nextUrl.searchParams;
    const role = searchParams.get("role");
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = 20;
    const skip = (page - 1) * limit;
    // #674 comment 7 — optional org-scope filter. Filters to users with
    // an ACTIVE Membership at the given org. Useful for support staff
    // looking up "all members of Acme."
    const orgId = searchParams.get("orgId");

    // Build where clause with proper typing
    const where: Prisma.UserWhereInput = {};

    // Validate role against UserRole enum before using
    if (
      role &&
      role !== "all" &&
      Object.values(UserRole).includes(role as UserRole)
    ) {
      where.role = role as UserRole;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    if (orgId) {
      where.memberships = {
        some: { organizationId: orgId, status: "ACTIVE" },
      };
    }

    // Fetch users with pagination
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          onboardingCompleted: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return NextResponse.json({
      users,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching users:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
