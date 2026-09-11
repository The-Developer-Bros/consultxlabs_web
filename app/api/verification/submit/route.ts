import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { notifyNewConsultantApplication } from "@/lib/novu/service";
import { getAppUrl } from "@/lib/url";
/**
 * POST /api/verification/submit
 * Submit verification request during onboarding or from settings
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

    const body = await request.json();
    const { linkedinUrl, notes, documentIds } = body;

    // Get the consultant profile
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        verificationRequests: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { success: false, error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Update user's LinkedIn URL if provided
    if (linkedinUrl) {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { linkedinUrl },
      });
    }

    // Check for the latest verification request
    const latestVerification = consultantProfile.verificationRequests[0];

    // Determine if we should update existing or create new
    const shouldUpdate =
      latestVerification &&
      (latestVerification.status === "PENDING" ||
        latestVerification.status === "NEEDS_INFO");

    // Validate document ownership before connecting — prevents reassigning
    // another consultant's documents to this verification request.
    // Deduplicate IDs first to avoid false 403 when duplicates are passed.
    const uniqueDocumentIds: string[] = documentIds?.length
      ? Array.from(new Set(documentIds as string[]))
      : [];
    if (uniqueDocumentIds.length) {
      const ownedDocs = await prisma.profileVerificationDocument.findMany({
        where: {
          id: { in: uniqueDocumentIds },
          verification: { consultantProfileId: consultantProfile.id },
        },
        select: { id: true },
      });
      if (ownedDocs.length !== uniqueDocumentIds.length) {
        return NextResponse.json(
          {
            success: false,
            error:
              "One or more document IDs do not belong to your verification request",
          },
          { status: 403 },
        );
      }
    }

    let verification;

    if (shouldUpdate) {
      // Update the existing request
      verification = await prisma.consultantProfileVerification.update({
        where: { id: latestVerification.id },
        data: {
          status: "PENDING", // Reset to PENDING for review
          notes,
          reviewedAt: null, // Reset review details
          reviewedById: null,
          reviewNotes: null,
          rejectionReason: null,
          feedbackDetails: null,
          // Connect new documents if provided (using deduplicated + validated IDs)
          ...(uniqueDocumentIds.length && {
            documents: {
              connect: uniqueDocumentIds.map((id) => ({ id })),
            },
          }),
        },
        include: {
          documents: true,
        },
      });
    } else {
      // Create a new verification request (for initial or after REJECTED/APPROVED)
      verification = await prisma.consultantProfileVerification.create({
        data: {
          consultantProfileId: consultantProfile.id,
          notes,
          status: "PENDING",
          // Connect existing documents if provided (using deduplicated + validated IDs)
          ...(uniqueDocumentIds.length && {
            documents: {
              connect: uniqueDocumentIds.map((id) => ({ id })),
            },
          }),
        },
        include: {
          documents: true,
        },
      });
    }

    // Update consultant profile verification status
    await prisma.consultantProfile.update({
      where: { id: consultantProfile.id },
      data: {
        verificationStatus: "UNDER_REVIEW",
        isVerified: false,
      },
    });

    // Notify admin/staff about new verification request
    try {
      const admins = await prisma.user.findMany({
        where: { role: { in: [UserRole.ADMIN, UserRole.STAFF] } },
        select: { id: true },
      });
      const adminIds = admins.map((a) => a.id);
      if (adminIds.length > 0) {
        const user = await prisma.user.findUnique({
          where: { id: session.user.id },
          select: { name: true, email: true },
        });
        await notifyNewConsultantApplication(adminIds, {
          applicantName: user?.name ?? "Unknown",
          applicantEmail: user?.email ?? "",
          dashboardUrl: `${getAppUrl()}/dashboard/admin/verification`,
        });
      }
    } catch (error) {
      console.error(
        "[verification/submit] Failed to send notification:",
        error,
      );
    }

    return NextResponse.json({
      success: true,
      data: verification,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Verification submit error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to submit verification",
      },
      { status: 500 },
    );
  }
}
