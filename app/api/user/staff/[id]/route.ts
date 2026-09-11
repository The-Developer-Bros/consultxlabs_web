import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { requireApiAuth, requireAdminAuth } from "@/lib/auth-helpers";

/**
 * Self-or-admin gate for this staff profile.
 *
 * Every handler in this file previously ran with NO auth of any kind:
 * `PUT` rewrote the linked User's email (an account-takeover primitive,
 * since `emailVerified` is not reset) and `DELETE` removed the profile.
 * The middleware only checks cookie presence, so nothing upstream was
 * covering it either.
 */
async function requireSelfOrAdmin(staffProfileId: string) {
  const auth = await requireApiAuth();
  if (auth.error) return { error: auth.error };

  const { role, staffProfileId: ownProfileId } = auth.session.user;
  if (role === "ADMIN" || ownProfileId === staffProfileId) {
    return { session: auth.session };
  }
  // Same 403 whether the profile is someone else's or absent — don't
  // confirm that an id exists to a caller who may not read it.
  return {
    error: NextResponse.json(
      { error: "Forbidden" },
      { status: 403 },
    ),
  };
}

// GET /api/user/staff/{id} - Fetch a single staff member by profile ID
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireSelfOrAdmin(id);
    if (auth.error) return auth.error;

    const staffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
      include: {
        user: {
          include: {
            notificationPreferences: true,
            cookiePreferences: true,
          },
        },
      },
    });

    if (!staffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: staffProfile }, { status: 200 });
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get staff profile",
      },
      { status: 500 },
    );
  }
}

// POST /api/user/staff/{id} - Create a staff profile for a user
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const body = await req.json();
    const user = await prisma.user.findUnique({
      where: { id: id },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found. Cannot create staff profile." },
        { status: 404 },
      );
    }

    const createdStaffProfile = await prisma.staffProfile.create({
      data: {
        department: body.department,
        position: body.position,
        user: { connect: { id: id } },
      },
      include: {
        user: true,
      },
    });

    return NextResponse.json(createdStaffProfile, { status: 201 });
  } catch (error) {
    console.error("Error creating staff profile:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    return NextResponse.json(
      {
        error: "An unexpected error occurred while creating the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// PATCH /api/user/staff/{id} - Update a staff profile by ID
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireSelfOrAdmin(id);
    if (auth.error) return auth.error;

    const body = await req.json();

    const existingStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
    });

    if (!existingStaffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found for updating" },
        { status: 404 },
      );
    }

    const updatedStaffProfile = await prisma.staffProfile.update({
      where: { id: id },
      data: {
        department: body.department,
        position: body.position,
      },
      include: {
        user: true,
      },
    });

    return NextResponse.json(updatedStaffProfile, { status: 200 });
  } catch (error) {
    console.error("Error updating staff profile:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    return NextResponse.json(
      {
        error: "An unexpected error occurred while updating the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// PUT /api/user/staff/{id} - Full update of staff profile by ID
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireSelfOrAdmin(id);
    if (auth.error) return auth.error;

    const body = await req.json();

    const existingStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
      include: { user: true },
    });

    if (!existingStaffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found for updating" },
        { status: 404 },
      );
    }

    // Update staff profile
    await prisma.staffProfile.update({
      where: { id: id },
      data: {
        department: body.department,
        position: body.position,
      },
      include: {
        user: {
          include: {
            notificationPreferences: true,
            cookiePreferences: true,
          },
        },
      },
    });

    // Also update user fields if provided
    if (
      body.name ||
      body.email ||
      body.phone ||
      body.address ||
      body.image ||
      body.timezone
    ) {
      await prisma.user.update({
        where: { id: existingStaffProfile.userId },
        data: {
          name: body.name,
          email: body.email,
          phone: body.phone,
          address: body.address,
          image: body.image,
          timezone: body.timezone,
        },
      });
    }

    // Update notification preferences if provided
    if (
      body.allNotifications !== undefined ||
      body.mentions !== undefined ||
      body.directMessages !== undefined ||
      body.updates !== undefined
    ) {
      await prisma.notificationPreference.upsert({
        where: { userId: existingStaffProfile.userId },
        update: {
          allNotifications: body.allNotifications,
          mentions: body.mentions,
          directMessages: body.directMessages,
          updates: body.updates,
        },
        create: {
          userId: existingStaffProfile.userId,
          allNotifications: body.allNotifications ?? false,
          mentions: body.mentions ?? false,
          directMessages: body.directMessages ?? false,
          updates: body.updates ?? false,
        },
      });
    }

    // Update cookie preferences if provided
    if (body.analytics !== undefined || body.marketing !== undefined) {
      await prisma.cookiePreference.upsert({
        where: { userId: existingStaffProfile.userId },
        update: {
          analytics: body.analytics,
          marketing: body.marketing,
        },
        create: {
          userId: existingStaffProfile.userId,
          essential: true,
          analytics: body.analytics ?? false,
          marketing: body.marketing ?? false,
        },
      });
    }

    // Fetch fresh data with all relations
    const freshStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
      include: {
        user: {
          include: {
            notificationPreferences: true,
            cookiePreferences: true,
          },
        },
      },
    });

    return NextResponse.json(freshStaffProfile, { status: 200 });
  } catch (error) {
    console.error("Error updating staff profile:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    return NextResponse.json(
      {
        error: "An unexpected error occurred while updating the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// DELETE /api/user/staff/{id} - Delete a staff profile by ID
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;

    const auth = await requireAdminAuth();
    if (auth.error) return auth.error;

    const existingStaffProfile = await prisma.staffProfile.findUnique({
      where: { id: id },
    });

    if (!existingStaffProfile) {
      return NextResponse.json(
        { error: "Staff profile not found for deletion" },
        { status: 404 },
      );
    }

    const deletedStaffProfile = await prisma.staffProfile.delete({
      where: { id: id },
      include: {
        user: true,
      },
    });

    return NextResponse.json(deletedStaffProfile, { status: 200 });
  } catch (error) {
    console.error("Error deleting staff profile:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    return NextResponse.json(
      {
        error: "An unexpected error occurred while deleting the staff profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
