import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  uploadProfileDisplayImage,
  deleteProfileDisplayImage,
  ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES,
  PROFILE_DISPLAY_IMAGE_MAX_SIZE,
} from "@/lib/supabase";

/**
 * POST /api/user/profile-display-image
 * Upload a profile display image for the authenticated user
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
    const userId = formData.get("userId") as string | null;

    // Verify the user is uploading their own profile display image
    if (userId && userId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    // Validate file type
    if (!ALLOWED_PROFILE_DISPLAY_IMAGE_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid file type. Please upload a JPEG, PNG, or WebP image.",
        },
        { status: 400 },
      );
    }

    // Validate file size
    if (file.size > PROFILE_DISPLAY_IMAGE_MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: "File size exceeds 2MB limit" },
        { status: 400 },
      );
    }

    // Upload to Supabase
    const uploadResult = await uploadProfileDisplayImage({
      userId: session.user.id,
      file,
    });

    if (!uploadResult.success || !uploadResult.fileUrl) {
      return NextResponse.json(
        { success: false, error: uploadResult.error || "Upload failed" },
        { status: 500 },
      );
    }

    // Update user record with profile display image URL
    await prisma.user.update({
      where: { id: session.user.id },
      data: { profileDisplayImage: uploadResult.fileUrl },
    });

    return NextResponse.json({
      success: true,
      data: {
        profileDisplayImage: uploadResult.fileUrl,
        storagePath: uploadResult.storagePath,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Profile display image upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to upload profile display image",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/user/profile-display-image
 * Delete the profile display image for the authenticated user
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    // Verify the user is deleting their own profile display image
    if (userId && userId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    // Check if user has a profile display image
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { profileDisplayImage: true },
    });

    if (!user?.profileDisplayImage) {
      return NextResponse.json({
        success: true,
        message: "No profile display image to delete",
      });
    }

    // Delete from Supabase
    const deleteResult = await deleteProfileDisplayImage(session.user.id);

    if (!deleteResult) {
      console.warn("Failed to delete profile display image from storage");
      // Continue anyway to clear the database reference
    }

    // Update user record to remove profile display image URL
    await prisma.user.update({
      where: { id: session.user.id },
      data: { profileDisplayImage: null },
    });

    return NextResponse.json({
      success: true,
      message: "Profile display image deleted successfully",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Profile display image delete error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete profile display image",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/user/profile-display-image
 * Get the profile display image URL for a user
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "User ID is required" },
        { status: 400 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { profileDisplayImage: true },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: { profileDisplayImage: user.profileDisplayImage },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Get profile display image error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get profile display image",
      },
      { status: 500 },
    );
  }
}
