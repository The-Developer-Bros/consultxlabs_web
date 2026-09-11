/**
 * Verification Resubmission API
 * POST /api/verification/resubmit
 * Allows consultants to resubmit their profile for verification after rejection
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { UserRole, ConsultantVerificationStatus } from "@prisma/client";
import { z } from "zod";

const resubmitSchema = z.object({
  notes: z.string().optional(),
});

import * as Sentry from "@sentry/nextjs";
import { getSession } from "@/lib/auth-server";
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is a consultant
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        role: true,
        consultantProfile: {
          select: {
            id: true,
            verificationStatus: true,
          },
        },
      },
    });

    if (user?.role !== UserRole.CONSULTANT) {
      return NextResponse.json(
        { error: "Only consultants can resubmit verification" },
        { status: 403 },
      );
    }

    if (!user.consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    // Only allow resubmission if status is REJECTED
    if (
      user.consultantProfile.verificationStatus !==
      ConsultantVerificationStatus.REJECTED
    ) {
      return NextResponse.json(
        { error: "Verification can only be resubmitted after rejection" },
        { status: 400 },
      );
    }

    const body = await req.json();
    const parseResult = resubmitSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parseResult.error.format() },
        { status: 400 },
      );
    }
    const { notes } = parseResult.data;

    // Get the most recent verification to link existing documents
    const previousVerification =
      await prisma.consultantProfileVerification.findFirst({
        where: {
          consultantProfileId: user.consultantProfile.id,
        },
        orderBy: {
          createdAt: "desc",
        },
        include: {
          documents: true,
        },
      });

    // Create new verification request
    const newVerification = await prisma.consultantProfileVerification.create({
      data: {
        consultantProfileId: user.consultantProfile.id,
        status: "PENDING",
        notes: notes || "Resubmission after addressing feedback",
        // Copy existing documents to the new verification request if any
        documents: previousVerification?.documents
          ? {
              create: previousVerification.documents.map((doc) => ({
                fileName: doc.fileName,
                originalName: doc.originalName,
                fileSize: doc.fileSize,
                mimeType: doc.mimeType,
                fileUrl: doc.fileUrl,
                storagePath: doc.storagePath,
                description: doc.description,
                // Reset review status for documents
                isValid: null,
                staffFeedback: null,
              })),
            }
          : undefined,
      },
    });

    // Update consultant profile verification status to UNDER_REVIEW
    await prisma.consultantProfile.update({
      where: { id: user.consultantProfile.id },
      data: {
        verificationStatus: ConsultantVerificationStatus.UNDER_REVIEW,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Verification resubmitted successfully",
      verificationId: newVerification.id,
    });
  } catch (error) {
    console.error("Error resubmitting verification:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return NextResponse.json(
      { error: "Failed to resubmit verification" },
      { status: 500 },
    );
  }
}
