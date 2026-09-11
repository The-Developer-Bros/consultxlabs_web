/**
 * Admin Verification Detail API
 * GET /api/admin/verification/[verificationId] - Get verification details
 * PATCH /api/admin/verification/[verificationId] - Review verification (approve/reject)
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ConsultantVerificationStatus } from "@prisma/client";
import { notifyVerificationStatusChanged } from "@/lib/novu";
import { ReviewVerificationSchema } from "@/schemas/verifications";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";

interface RouteParams {
  params: Promise<{ verificationId: string }>;
}

/**
 * GET /api/admin/verification/[verificationId]
 * Get verification request details (Admin only)
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { verificationId } = await params;

    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: verificationId },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                linkedinUrl: true,
                bio: true,
                workExperiences: true,
                certifications: true,
                education: true,
              },
            },
            domain: { select: { id: true, name: true } },
            subDomains: { select: { id: true, name: true } },
          },
        },
        documents: true,
      },
    });

    if (!verification) {
      return NextResponse.json(
        { error: "Verification not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ verification });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error fetching verification:", error);
    return NextResponse.json(
      { error: "Failed to fetch verification" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/admin/verification/[verificationId]
 * Review profile verification (approve/reject) with structured feedback (Admin only)
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { verificationId } = await params;
    const body = await req.json();
    const result = ReviewVerificationSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const {
      status,
      reviewNotes,
      rejectionReason,
      feedbackDetails,
      documentFeedback,
    } = result.data;

    // Get verification with profile and user info (for notification)
    const verification = await prisma.consultantProfileVerification.findUnique({
      where: { id: verificationId },
      select: {
        consultantProfileId: true,
        consultantProfile: {
          select: {
            id: true,
            user: { select: { id: true } },
          },
        },
      },
    });

    if (!verification) {
      return NextResponse.json(
        { error: "Verification not found" },
        { status: 404 },
      );
    }

    // Map verification status to consultant profile verification status
    const profileStatusMap: Record<string, ConsultantVerificationStatus> = {
      APPROVED: "VERIFIED",
      REJECTED: "REJECTED",
      NEEDS_INFO: "PENDING_VERIFICATION",
    };

    // FIX #582: Scope document updates to this verification to prevent
    // staff from accidentally/maliciously updating documents belonging
    // to a different verification request.
    const documentUpdates =
      documentFeedback?.map((df) =>
        prisma.profileVerificationDocument.updateMany({
          where: { id: df.documentId, verificationId },
          data: {
            isValid: df.isValid,
            staffFeedback: df.staffFeedback || null,
          },
        }),
      ) || [];

    // Update verification, documents, and optionally update consultant profile
    const [updatedVerification] = await prisma.$transaction([
      prisma.consultantProfileVerification.update({
        where: { id: verificationId },
        data: {
          status,
          reviewedAt: new Date(),
          reviewedById: session.user.id,
          reviewNotes,
          // Store rejection feedback (shown to consultant)
          rejectionReason:
            status === "REJECTED" || status === "NEEDS_INFO"
              ? rejectionReason
              : null,
          feedbackDetails:
            status === "REJECTED" || status === "NEEDS_INFO"
              ? feedbackDetails
              : null,
        },
      }),
      // Update document feedback
      ...documentUpdates,
      // Update consultant profile isVerified and verificationStatus
      ...(status === "APPROVED"
        ? [
            prisma.consultantProfile.update({
              where: { id: verification.consultantProfileId },
              data: {
                isVerified: true,
                verificationStatus: profileStatusMap[status],
              },
            }),
          ]
        : status === "REJECTED"
          ? [
              prisma.consultantProfile.update({
                where: { id: verification.consultantProfileId },
                data: {
                  isVerified: false,
                  verificationStatus: profileStatusMap[status],
                },
              }),
            ]
          : status === "NEEDS_INFO"
            ? [
                prisma.consultantProfile.update({
                  where: { id: verification.consultantProfileId },
                  data: {
                    isVerified: false,
                    verificationStatus: profileStatusMap[status],
                  },
                }),
              ]
            : []),
    ]);

    // Verification is the de-facto publish switch for a consultant: VERIFIED is
    // what puts them on the landing page and the experts directory, and any other
    // status takes them off. Purge now rather than leave the ISR window to expire.
    purgeExpertSurfaces(verification.consultantProfileId);

    // Fire-and-forget: notify consultant of verification status change
    const consultantUserId = verification.consultantProfile?.user?.id;
    if (consultantUserId) {
      void notifyVerificationStatusChanged(consultantUserId, {
        status: profileStatusMap[status] || status,
        reason: rejectionReason || feedbackDetails || undefined,
        dashboardUrl: `/dashboard/consultant/${verification.consultantProfile?.id}/settings`,
      });
    }

    return NextResponse.json({
      verification: updatedVerification,
      message:
        status === "APPROVED"
          ? "Profile approved and verified"
          : status === "REJECTED"
            ? "Profile verification rejected"
            : "More information requested",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "admin" } });
    console.error("Error reviewing verification:", error);
    return NextResponse.json(
      { error: "Failed to review verification" },
      { status: 500 },
    );
  }
}
