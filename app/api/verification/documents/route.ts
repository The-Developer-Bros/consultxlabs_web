import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  uploadToSupabase,
  deleteFromSupabase,
  generateStorageFileName,
} from "@/lib/supabase";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
const ALLOWED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DOCS_PER_VERIFICATION = 10;

/**
 * POST /api/verification/documents
 * Upload a verification document
 *
 * Supports two modes:
 * 1. Normal mode: Requires existing consultant profile
 * 2. Onboarding mode (onboarding=true): Allows upload before profile exists
 *    Documents are stored with userId reference and linked during onboarding completion
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
    const file = formData.get("file") as File;
    const description = formData.get("description") as string | null;
    const verificationId = formData.get("verificationId") as string | null;
    const isOnboarding = formData.get("onboarding") === "true";

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid file type. Allowed: PNG, JPG, WEBP, PDF",
        },
        { status: 400 },
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { success: false, error: "File size exceeds 10MB limit" },
        { status: 400 },
      );
    }

    // Get the consultant profile (may not exist during onboarding)
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      include: {
        verificationRequests: {
          where: { status: "PENDING" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    // In onboarding mode, allow uploads without a profile
    // Documents will be linked during onboarding completion
    if (!consultantProfile && !isOnboarding) {
      return NextResponse.json(
        { success: false, error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    let verification = null;

    // Only try to get/create verification if we have a consultant profile
    if (consultantProfile) {
      verification = consultantProfile.verificationRequests[0] ?? null;

      if (!verification && verificationId) {
        const found = await prisma.consultantProfileVerification.findUnique({
          where: { id: verificationId },
        });
        if (found) {
          verification = found;
        }
      }

      if (!verification) {
        // Create a new verification request if none exists
        verification = await prisma.consultantProfileVerification.create({
          data: {
            consultantProfileId: consultantProfile.id,
            status: "PENDING",
          },
        });
      }
    }

    // Enforce server-side document count limit (max 10 per verification).
    // For onboarding mode (no verification yet), count all docs owned by
    // this user's consultant profile to prevent storage abuse via onboarding=true.
    if (verification) {
      const existingDocCount =
        await prisma.profileVerificationDocument.count({
          where: { verificationId: verification.id },
        });
      if (existingDocCount >= MAX_DOCS_PER_VERIFICATION) {
        return NextResponse.json(
          {
            success: false,
            error: `Maximum ${MAX_DOCS_PER_VERIFICATION} documents per verification request. Delete an existing document before uploading a new one.`,
          },
          { status: 400 },
        );
      }
    } else if (consultantProfile) {
      // Onboarding with existing profile but no verification yet
      const totalDocs = await prisma.profileVerificationDocument.count({
        where: {
          verification: { consultantProfileId: consultantProfile.id },
        },
      });
      if (totalDocs >= MAX_DOCS_PER_VERIFICATION) {
        return NextResponse.json(
          {
            success: false,
            error: `Maximum ${MAX_DOCS_PER_VERIFICATION} documents allowed. Delete an existing document before uploading a new one.`,
          },
          { status: 400 },
        );
      }
    }
    // For pure onboarding (no profile at all), uploads are transient
    // Supabase storage and file size limits (10MB) provide baseline protection

    // Upload file to Supabase
    const fileBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(fileBuffer);
    const fileName = generateStorageFileName(file.type);
    const storagePath = `verification/${session.user.id}/${fileName}`;

    const { url: fileUrl, error: uploadError } = await uploadToSupabase(
      storagePath,
      buffer,
      file.type,
    );

    if (uploadError || !fileUrl) {
      return NextResponse.json(
        { success: false, error: uploadError || "Failed to upload file" },
        { status: 500 },
      );
    }

    // In onboarding mode, skip DB record creation - just return file info
    // The onboarding completion will create the records
    if (isOnboarding && !verification) {
      return NextResponse.json({
        success: true,
        data: {
          // No database ID yet - will be created during onboarding completion
          fileName,
          originalName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          fileUrl,
          storagePath,
          description: description || undefined,
          status: "uploaded",
          isOnboardingUpload: true,
        },
      });
    }

    // Normal mode: Create document record in database
    const document = await prisma.profileVerificationDocument.create({
      data: {
        verificationId: verification!.id,
        fileName,
        originalName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        fileUrl,
        storagePath,
        description: description || undefined,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: document.id,
        fileName: document.fileName,
        originalName: document.originalName,
        fileSize: document.fileSize,
        mimeType: document.mimeType,
        fileUrl: document.fileUrl,
        description: document.description,
        status: "uploaded",
      },
    });
  } catch (error) {
    console.error("Document upload error:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to upload document",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/verification/documents
 * Delete a verification document
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
    const documentId = searchParams.get("id");

    if (!documentId) {
      return NextResponse.json(
        { success: false, error: "Document ID required" },
        { status: 400 },
      );
    }

    // Get the document and verify ownership
    const document = await prisma.profileVerificationDocument.findUnique({
      where: { id: documentId },
      include: {
        verification: {
          include: {
            consultantProfile: true,
          },
        },
      },
    });

    if (!document) {
      return NextResponse.json(
        { success: false, error: "Document not found" },
        { status: 404 },
      );
    }

    // Check ownership
    if (document.verification.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }

    // Only allow deletion if verification is still pending
    if (document.verification.status !== "PENDING") {
      return NextResponse.json(
        {
          success: false,
          error: "Cannot delete documents from processed verification",
        },
        { status: 400 },
      );
    }

    // Delete from Supabase storage
    await deleteFromSupabase(document.storagePath);

    // Delete the document record
    await prisma.profileVerificationDocument.delete({
      where: { id: documentId },
    });

    return NextResponse.json({
      success: true,
      message: "Document deleted successfully",
    });
  } catch (error) {
    console.error("Document delete error:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to delete document",
      },
      { status: 500 },
    );
  }
}
