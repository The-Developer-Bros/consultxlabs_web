import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import prisma from "@/lib/prisma";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import type { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { ANNOUNCEMENTS_TAG } from "@/lib/cache-tags";
interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/announcements/[id]
 * Update an announcement (admin/staff only)
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Announcements fan out to every user (`notifyGeneralAnnouncement`), so
    // BACKOFFICE_PERMISSIONS makes them ADMIN-only. The nav already hid the
    // surface from staff; the route accepted the call regardless.
    if (!hasBackofficePermission(
      session.user.role as UserRole,
      "announcements.manage",
    )) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const { id } = await params;
    const body = await request.json();

    const existingAnnouncement = await prisma.announcement.findUnique({
      where: { id },
    });

    if (!existingAnnouncement) {
      return NextResponse.json(
        { success: false, error: "Announcement not found" },
        { status: 404 },
      );
    }

    const {
      title,
      content,
      isActive,
      startDate,
      endDate,
      backgroundColor,
      textColor,
      linkUrl,
      linkText,
    } = body;

    const announcement = await prisma.announcement.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(isActive !== undefined && { isActive }),
        ...(startDate !== undefined && {
          startDate:
            startDate && !isNaN(new Date(startDate).getTime())
              ? new Date(startDate)
              : null,
        }),
        ...(endDate !== undefined && {
          endDate:
            endDate && !isNaN(new Date(endDate).getTime())
              ? new Date(endDate)
              : null,
        }),
        ...(backgroundColor !== undefined && { backgroundColor }),
        ...(textColor !== undefined && { textColor }),
        ...(linkUrl !== undefined && { linkUrl }),
        ...(linkText !== undefined && { linkText }),
      },
    });

    // Invalidate the cached banner read so the edit shows immediately.
    revalidateTag(ANNOUNCEMENTS_TAG);

    return NextResponse.json({
      success: true,
      data: announcement,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Update announcement error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update announcement" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/announcements/[id]
 * Delete an announcement (admin/staff only)
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Announcements fan out to every user (`notifyGeneralAnnouncement`), so
    // BACKOFFICE_PERMISSIONS makes them ADMIN-only. The nav already hid the
    // surface from staff; the route accepted the call regardless.
    if (!hasBackofficePermission(
      session.user.role as UserRole,
      "announcements.manage",
    )) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    const { id } = await params;

    const existingAnnouncement = await prisma.announcement.findUnique({
      where: { id },
    });

    if (!existingAnnouncement) {
      return NextResponse.json(
        { success: false, error: "Announcement not found" },
        { status: 404 },
      );
    }

    await prisma.announcement.delete({
      where: { id },
    });

    // Invalidate the cached banner read so the removal shows immediately.
    revalidateTag(ANNOUNCEMENTS_TAG);

    return NextResponse.json({
      success: true,
      message: "Announcement deleted successfully",
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "notifications" } },
    );
    console.error("Delete announcement error:", error);
    return NextResponse.json(
      { success: false, error: "Failed to delete announcement" },
      { status: 500 },
    );
  }
}
