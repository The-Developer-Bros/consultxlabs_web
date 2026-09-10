import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import prisma from "@/lib/prisma";
import {
  uploadConsultantDocument,
  deleteAppointmentDocument,
} from "@/lib/supabase";
import { Prisma } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import {
  MAX_DOCS_PER_APPOINTMENT,
  validateDocumentUpload,
  withVersionConflictRetry,
} from "@/lib/documents/document-review";
import { notifyDocumentUploaded } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";
// Development mode check
const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

/**
 * Load the appointment iff the caller delivers it (any of the four plan
 * arms). Kept out of the handler so POST reads linearly — Sonar S3776.
 */
async function loadConsultantAppointment(
  appointmentId: string,
  userId: string,
) {
  const whereClause: Prisma.AppointmentWhereInput = { id: appointmentId };

  if (!isDevelopment()) {
    whereClause.OR = [
      {
        consultation: {
          consultationPlan: {
            consultantProfile: { user: { id: userId } },
          },
        },
      },
      {
        subscription: {
          subscriptionPlan: {
            consultantProfile: { user: { id: userId } },
          },
        },
      },
      {
        webinar: {
          webinarPlan: { consultantProfile: { user: { id: userId } } },
        },
      },
      {
        class: {
          classPlan: { consultantProfile: { user: { id: userId } } },
        },
      },
    ];
  }

  return prisma.appointment.findFirst({
    where: whereClause,
    include: {
      consultation: {
        include: {
          consultationPlan: {
            include: { consultantProfile: { select: { id: true, userId: true } } },
          },
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: { consultantProfile: { select: { id: true, userId: true } } },
          },
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: { consultantProfile: { select: { id: true, userId: true } } },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: { consultantProfile: { select: { id: true, userId: true } } },
          },
        },
      },
    },
  });
}

/**
 * POST - Upload a consultant response document
 * Consultant can upload documents as responses to consultee submissions
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to upload documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // DOC-2 (#694) — throttle uploads per user before any storage/DB work.
    const rateLimited = await applyRateLimit(
      documentUploadLimiter,
      session.user.id,
    );
    if (rateLimited) return rateLimited;

    const { appointmentId } = await params;
    const userId = session.user.id;

    // Verify appointment exists and caller delivers it (any arm).
    const appointment = await loadConsultantAppointment(appointmentId, userId);

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            "Appointment not found or you don't have consultant access to it",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Get consultant ID
    const consultantId =
      appointment.consultation?.consultationPlan?.consultantProfile?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.id ||
      appointment.webinar?.webinarPlan?.consultantProfile?.id ||
      appointment.class?.classPlan?.consultantProfile?.id;

    if (!consultantId) {
      return NextResponse.json(
        {
          error: "Configuration error",
          message: "Could not determine consultant for this appointment",
          code: "SERVER_ERROR",
        },
        { status: 500 },
      );
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const description = formData.get("description") as string | null;
    const responseToDocumentId = formData.get("responseToDocumentId") as
      | string
      | null;

    if (!file) {
      return NextResponse.json(
        {
          error: "No file provided",
          message: "Please select a file to upload",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // Size/type parity with the consultee route — one shared gate so the two
    // roles' limits can never drift apart again.
    const validation = validateDocumentUpload(file);
    if (!validation.ok) {
      return NextResponse.json(
        {
          error:
            validation.code === "FILE_TOO_LARGE" ? "File too large" : "Unsupported file type",
          message: validation.message,
          code: validation.code,
        },
        { status: 400 },
      );
    }

    // Quota + response-target validation BEFORE uploading (a post-upload
    // rejection leaks the stored object).
    if (
      (await prisma.appointmentDocument.count({
        where: { appointmentId, deletedAt: null },
      })) >= MAX_DOCS_PER_APPOINTMENT
    ) {
      return NextResponse.json(
        {
          error: "Document limit reached",
          message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} documents.`,
          code: "DOCUMENT_LIMIT_REACHED",
        },
        { status: 400 },
      );
    }

    if (responseToDocumentId) {
      const parent = await prisma.appointmentDocument.findFirst({
        where: { id: responseToDocumentId, appointmentId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        return NextResponse.json(
          {
            error: "Original document not found",
            message: "The document you're responding to does not exist",
            code: "NOT_FOUND",
          },
          { status: 404 },
        );
      }
    }

    // Upload to Supabase
    const uploadResult = await uploadConsultantDocument({
      appointmentId,
      consultantId,
      file,
      responseToDocumentId: responseToDocumentId || undefined,
      description: description || undefined,
    });

    if (!uploadResult.success) {
      return NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error || "Failed to upload file",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      );
    }

    // Create database record — thread anchor + versionNo resolved in the same
    // transaction as the insert (race-safe versioning).
    let document;
    try {
      document = await withVersionConflictRetry(() =>
        prisma.$transaction(async (tx) => {
        let rootDocumentId: string | null = null;
        let versionNo = 1;
        if (responseToDocumentId) {
          const parent = await tx.appointmentDocument.findFirst({
            where: { id: responseToDocumentId, appointmentId, deletedAt: null },
            select: { id: true, rootDocumentId: true },
          });
          if (!parent) throw new Error("INVALID_RESPONSE_TARGET");
          rootDocumentId = parent.rootDocumentId ?? parent.id;
          const aggregate = await tx.appointmentDocument.aggregate({
            where: { OR: [{ id: rootDocumentId }, { rootDocumentId }] },
            _max: { versionNo: true },
          });
          versionNo = (aggregate._max.versionNo ?? 1) + 1;
        }
        return tx.appointmentDocument.create({
          data: {
            fileName: uploadResult.fileName!,
            originalName: file.name,
            fileSize: uploadResult.fileSize!,
            mimeType: uploadResult.mimeType!,
            fileUrl: uploadResult.fileUrl!,
            storagePath: uploadResult.storagePath!,
            description: description || null,
            uploadedByRole: "CONSULTANT",
            responseToDocumentId: responseToDocumentId || null,
            rootDocumentId,
            versionNo,
            appointmentId,
            // Consultant uploads don't need review
            reviewStatus: "APPROVED",
            reviewedById: userId, // A8 — FK scalar (#676)
            reviewedAt: new Date(),
          },
        });
        }),
      );
    } catch (dbError) {
      console.error("Database error saving consultant document:", dbError);
      Sentry.captureException(dbError instanceof Error ? dbError : new Error(String(dbError)), { tags: { subsystem: "appointments" } });
      // Same cleanup contract as the consultee route: a failed save must not
      // strand the stored object.
      try {
        await deleteAppointmentDocument(uploadResult.storagePath!);
      } catch (cleanupError) {
        console.error("Failed to cleanup uploaded file:", cleanupError);
      }

      if (
        dbError instanceof Error &&
        dbError.message === "INVALID_RESPONSE_TARGET"
      ) {
        return NextResponse.json(
          {
            error: "Original document not found",
            message: "The document you're responding to does not exist",
            code: "NOT_FOUND",
          },
          { status: 404 },
        );
      }
      return NextResponse.json(
        {
          error: "Server error",
          message: "Failed to upload document",
          code: "SERVER_ERROR",
        },
        { status: 500 },
      );
    }

    // Notify the consultee a response landed on their review thread.
    const apt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        organizationId: true,
        consultation: {
          select: {
            requestedBy: {
              select: { id: true, user: { select: { id: true, name: true } } },
            },
          },
        },
        subscription: {
          select: {
            requestedBy: {
              select: { id: true, user: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });
    const consulteeName =
      apt?.consultation?.requestedBy?.user?.name ||
      apt?.subscription?.requestedBy?.user?.name ||
      "The consultee";
    const recipientId =
      apt?.consultation?.requestedBy?.user?.id ||
      apt?.subscription?.requestedBy?.user?.id;
    const consulteeProfileId =
      apt?.consultation?.requestedBy?.id ||
      apt?.subscription?.requestedBy?.id;

    if (recipientId) {
      after(() =>
        notifyDocumentUploaded(recipientId, {
          ...notificationScope(apt?.organizationId),
          appointmentId,
          documentId: document.id,
          uploadedByRole: "CONSULTANT",
          fileName: file.name,
          isThreaded: Boolean(responseToDocumentId),
          versionNo: document.versionNo,
          consultantName: session.user.name ?? "Your consultant",
          consulteeName,
          // Consultees have no /documents surface — their review threads live
          // on the appointment detail page (matches the review notification).
          dashboardUrl: scopedHref({
            organizationId: apt?.organizationId,
            surface: "appointments",
            personal:
              consulteeProfileId
                ? { kind: "consultee", profileId: consulteeProfileId }
                : undefined,
          }),
        }).catch((notifyError) => {
          console.error("Failed to notify consultee of response", notifyError);
          Sentry.captureException(notifyError instanceof Error ? notifyError : new Error(String(notifyError)), { tags: { subsystem: "novu" } });
        }),
      );
    }

    return NextResponse.json({ data: document }, { status: 201 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    console.error("Error uploading consultant document:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to upload document",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
