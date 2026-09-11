import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  uploadProfileImage,
  deleteProfileImage,
  ALLOWED_PROFILE_IMAGE_TYPES,
  PROFILE_IMAGE_MAX_SIZE,
} from "@/lib/supabase";

/**
 * POST /api/user/profile-image
 * Upload a profile avatar image for the authenticated user.
 * Updates User.image (general avatar shown in Navbar/session).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    if (!ALLOWED_PROFILE_IMAGE_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid file type. Please upload a JPEG, PNG, or WebP image.",
        },
        { status: 400 },
      );
    }

    if (file.size > PROFILE_IMAGE_MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: "File size exceeds 2MB limit" },
        { status: 400 },
      );
    }

    const uploadResult = await uploadProfileImage({
      userId: session.user.id,
      file,
    });

    if (!uploadResult.success || !uploadResult.fileUrl) {
      return NextResponse.json(
        { success: false, error: uploadResult.error || "Upload failed" },
        { status: 500 },
      );
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { image: uploadResult.fileUrl },
    });

    return NextResponse.json({
      success: true,
      data: {
        image: uploadResult.fileUrl,
        storagePath: uploadResult.storagePath,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Profile image upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to upload profile image",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/user/profile-image
 * Delete the profile avatar image for the authenticated user.
 */
export async function DELETE() {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { image: true },
    });

    if (!user?.image) {
      return NextResponse.json({
        success: true,
        message: "No profile image to delete",
      });
    }

    const deleteResult = await deleteProfileImage(session.user.id);

    if (!deleteResult) {
      console.warn("Failed to delete profile image from storage");
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { image: null },
    });

    return NextResponse.json({
      success: true,
      message: "Profile image deleted successfully",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Profile image delete error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete profile image",
      },
      { status: 500 },
    );
  }
}
