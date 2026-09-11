import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
/**
 * GET /api/verification/status
 * Get the current verification status for the authenticated consultant
 */
export async function GET() {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // Get the consultant profile with verification info
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: {
        id: true,
        isVerified: true,
        verificationStatus: true,
        verificationRequests: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            submittedAt: true,
            reviewedAt: true,
            reviewNotes: true,
            rejectionReason: true,
            feedbackDetails: true,
            notes: true,
            documents: {
              select: {
                id: true,
                fileName: true,
                originalName: true,
                fileSize: true,
                mimeType: true,
                fileUrl: true,
                description: true,
                uploadedAt: true,
                isValid: true,
                staffFeedback: true,
              },
            },
          },
        },
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { success: false, error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Get user's LinkedIn URL
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { linkedinUrl: true },
    });

    const latestRequest = consultantProfile.verificationRequests[0];

    return NextResponse.json({
      success: true,
      data: {
        profileId: consultantProfile.id,
        isVerified: consultantProfile.isVerified,
        verificationStatus: consultantProfile.verificationStatus,
        linkedinUrl: user?.linkedinUrl,
        latestRequest: latestRequest
          ? {
              id: latestRequest.id,
              status: latestRequest.status,
              submittedAt: latestRequest.submittedAt,
              reviewedAt: latestRequest.reviewedAt,
              reviewNotes: latestRequest.reviewNotes,
              rejectionReason: latestRequest.rejectionReason,
              feedbackDetails: latestRequest.feedbackDetails,
              notes: latestRequest.notes,
              documents: latestRequest.documents,
            }
          : null,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Verification status error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get verification status",
      },
      { status: 500 },
    );
  }
}
