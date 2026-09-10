import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import bcrypt from "bcrypt";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

// POST /api/user/staff - Create a new staff member (ADMIN only)
export async function POST(request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN can create staff members
    if (session.user.role !== "ADMIN") {
      return forbiddenResponse("Only administrators can create staff members");
    }

    const body = await request.json();
    const {
      email,
      password,
      name,
      phone,
      address,
      department,
      position,
    } = body;

    // Basic validation
    if (!email || !password || !name) {
      return NextResponse.json(
        { message: "Missing required fields: email, password, name" },
        { status: 400 },
      );
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json(
        { message: "User with this email already exists" },
        { status: 409 }, // Conflict
      );
    }

    // #695 ADM-1 — hash the password and store a credential Account row so
    // the staff member can actually sign in. The previous code accepted the
    // password but never persisted it (the comment claimed BetterAuth handled
    // hashing — it didn't; this route bypasses BetterAuth entirely).
    const passwordHash = await bcrypt.hash(password, 12);

    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          phone,
          emailVerified: true,
          role: UserRole.STAFF,
          address,
          staffProfile: {
            create: { department, position },
          },
        },
      });
      await tx.account.create({
        data: {
          userId: user.id,
          accountId: email,
          providerId: "credential",
          password: passwordHash,
        },
      });
      return user;
    });

    return NextResponse.json(
      { ...newUser, staffProfile: { department, position } },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating staff:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    // Provide a generic error message
    return NextResponse.json(
      { message: "Internal Server Error" },
      { status: 500 },
    );
  }
}

// GET /api/user/staff - Get all staff members (ADMIN/STAFF only)
export async function GET(_request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN/STAFF can list staff members
    if (!isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "Only administrators and staff can view staff members",
      );
    }

    const staffUsers = await prisma.user.findMany({
      where: {
        role: "STAFF",
      },
      include: {
        staffProfile: true, // Include related staff profile data
      },
    });

    return NextResponse.json(staffUsers);
  } catch (error) {
    console.error("Failed to fetch staff users:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    return NextResponse.json(
      { message: "Internal Server Error fetching staff" },
      { status: 500 },
    );
  }
}
