import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import {
  uploadAppointmentDocument,
  getManualBucketInstructions,
  deleteAppointmentDocument,
} from "@/lib/supabase";
import { applyRateLimit, documentUploadLimiter } from "@/lib/rate-limit";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";
import {
  MAX_DOCS_PER_APPOINTMENT,
  validateDocumentUpload,
  withVersionConflictRetry,
} from "@/lib/documents/document-review";
import { notifyDocumentUploaded } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";

// GET - List documents for an appointment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId } = await params;

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Invalid appointment",
          message: "Appointment ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // In development mode with explicit bypass flag, allow access to any appointment's documents for testing
    // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    // Build access control conditions - bypass in development
    const whereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      whereClause.OR = [
        // User is the consultee
        {
          consultation: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
        // User is the consultant
        {
          consultation: {
            consultationPlan: {
              consultantProfile: {
                user: {
                  id: session.user.id,
                },
              },
            },
          },
        },
        // User is part of subscription
        {
          subscription: {
            OR: [
              {
                requestedBy: {
                  user: {
                    id: session.user.id,
                  },
                },
              },
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      id: session.user.id,
                    },
                  },
                },
              },
            ],
          },
        },
      ];
    }

    // Verify user has access to this appointment
    const appointment = await prisma.appointment.findFirst({
      where: whereClause,
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { name: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] This appointment ID (${appointmentId}) doesn't exist in the database. Please check the appointment details.`
            : "This appointment doesn't exist or you don't have permission to view it. Please check the appointment details or contact support if you believe this is an error.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // DOC-1 (#694) — block listing once the parent booking is terminal
    // (cancelled/refunded/rejected/expired); prior code only checked requester
    // identity, leaving documents visible after a refund.
    if (isBookingTerminal(appointment)) {
      return NextResponse.json(
        {
          error: "Documents unavailable",
          message:
            "This appointment has been cancelled or closed, so its documents are no longer available.",
          code: "APPOINTMENT_TERMINAL",
        },
        { status: 403 },
      );
    }

    // Get appointment details for better error context
    const appointmentTitle =
      appointment.consultation?.consultationPlan?.title ||
      appointment.subscription?.subscriptionPlan?.title ||
      "Unknown Appointment";
    const consultantName =
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "Unknown Consultant";

    // Fetch documents - this should never fail, even if folder doesn't exist
    let documents;
    try {
      documents = await prisma.appointmentDocument.findMany({
        where: {
          appointmentId,
          // Soft-deleted rows stay in the DB for audit until the nightly purge;
          // they never render in review threads.
          deletedAt: null,
        },
        include: {
          // Include response documents (consultant responses to this document)
          responseDocuments: {
            where: { deletedAt: null },
            orderBy: {
              uploadedAt: "desc",
            },
          },
          // Include the document this is a response to (if any)
          responseToDocument: {
            select: {
              id: true,
              originalName: true,
              uploadedByRole: true,
            },
          },
        },
        orderBy: {
          uploadedAt: "desc",
        },
      });
    } catch (dbError) {
      console.error("Database error fetching documents:", dbError);
      Sentry.captureException(dbError instanceof Error ? dbError : new Error(String(dbError)), { tags: { subsystem: "appointments" } });
      // Return empty array instead of failing - documents folder might not exist yet
      return NextResponse.json({
        data: [],
        message:
          "No documents found for this appointment yet. Upload your first document to get started!",
        appointmentTitle: isDevelopment
          ? `${appointmentTitle} [DEV MODE]`
          : appointmentTitle,
        consultantName,
      });
    }

    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    return NextResponse.json({
      data: documents,
      count: documents.length,
      message:
        documents.length === 0
          ? `No documents uploaded yet. You can upload documents like resumes, tax returns, or other files for review.${devModeMessage}`
          : `Found ${documents.length} document${documents.length === 1 ? "" : "s"} for this appointment.${devModeMessage}`,
      appointmentTitle: isDevelopment
        ? `${appointmentTitle} [DEV MODE]`
        : appointmentTitle,
      consultantName,
    });
  } catch (error) {
    console.error("Error fetching appointment documents:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });

    // Provide specific error messages based on error type
    if (error instanceof Error) {
      if (
        error.message.includes("connect") ||
        error.message.includes("timeout")
      ) {
        return NextResponse.json(
          {
            error: "Connection error",
            message:
              "Unable to connect to the server. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR",
          },
          { status: 503 },
        );
      }

      if (
        error.message.includes("Prisma") ||
        error.message.includes("database")
      ) {
        return NextResponse.json(
          {
            error: "Database temporarily unavailable",
            message:
              "The document system is temporarily unavailable. Please try again in a few moments.",
            code: "DATABASE_ERROR",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      {
        error: "Unable to load documents",
        message:
          "Something went wrong while loading your documents. Please refresh the page or try again later. If the problem persists, contact support.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}

// POST - Upload a new document
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

    if (!appointmentId) {
      return NextResponse.json(
        {
          error: "Invalid appointment",
          message: "Appointment ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    let formData;
    try {
      formData = await request.formData();
    } catch (_parseError) {
      return NextResponse.json(
        {
          error: "Invalid file upload",
          message:
            "The uploaded file appears to be corrupted or invalid. Please try uploading the file again.",
          code: "INVALID_FILE",
        },
        { status: 400 },
      );
    }

    const file = formData.get("file") as File;
    const description = formData.get("description") as string;
    // A revision re-upload threads onto the document it replaces, mirroring
    // the consultant side. Threading rather than mutating keeps the rejected
    // version and its reviewNotes intact — the reviewer needs to see what
    // changed, and an audit of "why was this approved" needs the history.
    // `formData.get` returns `FormDataEntryValue | null`, so a client can send
    // this part as a file and the old `as string` cast would have carried a
    // `File` straight into the Prisma `where`/`create`.
    const revisionOfRaw = formData.get("responseToDocumentId");
    const revisionOf =
      typeof revisionOfRaw === "string" && revisionOfRaw.trim()
        ? revisionOfRaw.trim()
        : null;

    if (!file || file.size === 0) {
      return NextResponse.json(
        {
          error: "No file selected",
          message:
            "Please select a file to upload. Supported formats include PDF, Word documents, images, and text files.",
          code: "NO_FILE",
        },
        { status: 400 },
      );
    }

    // Shared size/MIME gate (same helper the consultant route uses).
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

    // In development mode with explicit bypass flag, allow uploads to any appointment for testing
    // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    // Build access control conditions - bypass in development
    const uploadWhereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      uploadWhereClause.OR = [
        {
          consultation: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
        {
          subscription: {
            requestedBy: {
              user: {
                id: session.user.id,
              },
            },
          },
        },
      ];
    }

    // Verify user has access to this appointment and get consultee ID
    const appointment = await prisma.appointment.findFirst({
      where: uploadWhereClause,
      include: {
        consultation: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { id: true, name: true },
                    },
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            requestedBy: {
              include: {
                user: true,
              },
            },
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: { id: true, name: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] Appointment ${appointmentId} not found in database.`
            : "You can only upload documents to your own appointments. Please check the appointment details.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Get consultee ID from appointment or use session user ID as fallback for dev mode
    const consulteeId =
      appointment.consultation?.requestedBy?.id ||
      appointment.subscription?.requestedBy?.id ||
      (isDevelopment ? session.user.id : null);

    if (!consulteeId) {
      return NextResponse.json(
        {
          error: "Invalid appointment setup",
          message:
            "There's an issue with this appointment setup. Please contact support for assistance.",
          code: "INVALID_APPOINTMENT",
        },
        { status: 400 },
      );
    }

    // A revision must point at a document on THIS appointment. Without the
    // check, a caller could thread their upload onto any document id they
    // guessed and have it render inside someone else's review history.
    //
    // Checked BEFORE the upload: rejecting afterwards returned 400 without
    // deleting the object already written to storage, unlike the DB-failure
    // branch below which does clean up. Every rejected revision leaked a file.
    // The lookup needs only `appointmentId`, which is verified above.
    //
    // DOC quota — live (non-deleted) docs per appointment are capped; without
    // it 10MB × unlimited rows is an unbounded storage bill at scale.
    if (
      (await prisma.appointmentDocument.count({
        where: { appointmentId, deletedAt: null },
      })) >= MAX_DOCS_PER_APPOINTMENT
    ) {
      return NextResponse.json(
        {
          error: "Document limit reached",
          message: `This appointment already has ${MAX_DOCS_PER_APPOINTMENT} documents. Please delete an unreviewed upload or continue in a new appointment.`,
          code: "DOCUMENT_LIMIT_REACHED",
        },
        { status: 400 },
      );
    }

    // A revision must point at a document on THIS appointment — validated
    // BEFORE the upload so a rejection can't leak the stored object.
    if (revisionOf) {
      const parent = await prisma.appointmentDocument.findFirst({
        where: { id: revisionOf, appointmentId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        return NextResponse.json(
          {
            error: "Invalid revision target",
            message:
              "The document this revision replaces was not found on this appointment.",
            code: "INVALID_REVISION_TARGET",
          },
          { status: 400 },
        );
      }
    }

    // Upload file to Supabase with enhanced error handling
    let uploadResult;
    try {
      uploadResult = await uploadAppointmentDocument({
        appointmentId,
        consulteeId,
        description,
        file,
      });
    } catch (uploadError) {
      console.error("File upload error:", uploadError);
      Sentry.captureException(uploadError instanceof Error ? uploadError : new Error(String(uploadError)), { tags: { subsystem: "appointments" } });

      if (uploadError instanceof Error) {
        if (
          uploadError.message.includes("network") ||
          uploadError.message.includes("fetch")
        ) {
          return NextResponse.json(
            {
              error: "Network error",
              message:
                "Upload failed due to a network issue. Please check your connection and try again.",
              code: "NETWORK_ERROR",
            },
            { status: 503 },
          );
        }

        if (
          uploadError.message.includes("storage") ||
          uploadError.message.includes("bucket")
        ) {
          return NextResponse.json(
            {
              error: "Storage error",
              message:
                "There's a temporary issue with file storage. Please try again in a few moments.",
              code: "STORAGE_ERROR",
            },
            { status: 503 },
          );
        }
      }

      return NextResponse.json(
        {
          error: "Upload failed",
          message:
            "Failed to upload the file. Please try again or contact support if the issue persists.",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      );
    }

    if (!uploadResult.success) {
      const isBucketError =
        uploadResult.error?.includes("bucket") ||
        uploadResult.error?.includes("storage");

      return NextResponse.json(
        {
          error: "Upload failed",
          message:
            uploadResult.error ||
            "The file upload was unsuccessful. Please try again.",
          code: isBucketError ? "BUCKET_NOT_FOUND" : "UPLOAD_FAILED",
          ...(isBucketError && {
            instructions: getManualBucketInstructions("documents"),
            technical: uploadResult.error,
          }),
        },
        { status: 400 },
      );
    }

    // Save document record to database. Thread context (root + versionNo) is
    // resolved inside the same transaction as the insert so two racing
    // revisions cannot compute the same versionNo from a stale max().
    let document;
    try {
      document = await withVersionConflictRetry(() =>
        prisma.$transaction(async (tx) => {
        let rootDocumentId: string | null = null;
        let versionNo = 1;
        if (revisionOf) {
          const parent = await tx.appointmentDocument.findFirst({
            where: { id: revisionOf, appointmentId, deletedAt: null },
            select: { id: true, rootDocumentId: true },
          });
          if (!parent) throw new Error("INVALID_REVISION_TARGET");
          rootDocumentId = parent.rootDocumentId ?? parent.id;
          const aggregate = await tx.appointmentDocument.aggregate({
            where: { OR: [{ id: rootDocumentId }, { rootDocumentId }] },
            _max: { versionNo: true },
          });
          versionNo = (aggregate._max.versionNo ?? 1) + 1;
        }
        return tx.appointmentDocument.create({
          data: {
            appointmentId,
            fileName: uploadResult.fileName!,
            originalName: file.name,
            fileSize: uploadResult.fileSize!,
            mimeType: uploadResult.mimeType!,
            fileUrl: uploadResult.fileUrl!,
            storagePath: uploadResult.storagePath!,
            description: description?.trim() || null,
            reviewStatus: "PENDING",
            responseToDocumentId: revisionOf,
            rootDocumentId,
            versionNo,
          },
        });
        }),
      );
    } catch (dbError) {
      console.error("Database error saving document:", dbError);
      Sentry.captureException(dbError instanceof Error ? dbError : new Error(String(dbError)), { tags: { subsystem: "appointments" } });

      // Try to clean up uploaded file if database save failed
      try {
        await deleteAppointmentDocument(uploadResult.storagePath!);
      } catch (cleanupError) {
        console.error("Failed to cleanup uploaded file:", cleanupError);
        Sentry.captureException(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)), { tags: { subsystem: "appointments" } });
      }

      if (
        dbError instanceof Error &&
        dbError.message === "INVALID_REVISION_TARGET"
      ) {
        return NextResponse.json(
          {
            error: "Invalid revision target",
            message:
              "The document this revision replaces was not found on this appointment.",
            code: "INVALID_REVISION_TARGET",
          },
          { status: 400 },
        );
      }

      return NextResponse.json(
        {
          error: "Save failed",
          message:
            "The file was uploaded but couldn't be saved to your account. Please try again or contact support.",
          code: "SAVE_FAILED",
        },
        { status: 500 },
      );
    }

    // Ping the reviewer. `after()` keeps the response fast and the send
    // survives the handler; failures are logged, never surfaced as 500s.
    const consultantUserId =
      appointment.consultation?.consultationPlan?.consultantProfile?.user?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id;
    const consultantProfileId =
      appointment.consultation?.consultationPlan?.consultantProfile?.id ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.id;
    const consulteeName =
      appointment.consultation?.requestedBy?.user?.name ||
      appointment.subscription?.requestedBy?.user?.name ||
      "The consultee";
    const consultantName =
      appointment.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "your consultant";

    if (consultantUserId) {
      after(() =>
        notifyDocumentUploaded(consultantUserId, {
          ...notificationScope(appointment.organizationId),
          appointmentId,
          documentId: document.id,
          uploadedByRole: "CONSULTEE",
          fileName: file.name,
          isThreaded: Boolean(revisionOf),
          versionNo: document.versionNo,
          consultantName,
          consulteeName,
          dashboardUrl: scopedHref({
            organizationId: appointment.organizationId,
            surface: "documents",
            personal:
              consultantProfileId
                ? { kind: "consultant", profileId: consultantProfileId }
                : undefined,
          }),
        }).catch((notifyError) => {
          console.error("Failed to notify consultant of document", notifyError);
          Sentry.captureException(notifyError instanceof Error ? notifyError : new Error(String(notifyError)), { tags: { subsystem: "novu" } });
        }),
      );
    }

    const appointmentTitle =
      appointment.consultation?.consultationPlan?.title ||
      appointment.subscription?.subscriptionPlan?.title ||
      "your appointment";

    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    return NextResponse.json(
      {
        data: document,
        message: `Successfully uploaded "${file.name}" for ${appointmentTitle}. ${consultantName} will review it and provide feedback.${devModeMessage}`,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error uploading document:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });

    // Provide specific error messages based on error type
    if (error instanceof Error) {
      if (
        error.message.includes("connect") ||
        error.message.includes("timeout")
      ) {
        return NextResponse.json(
          {
            error: "Connection error",
            message:
              "Upload failed due to connection issues. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR",
          },
          { status: 503 },
        );
      }
    }

    return NextResponse.json(
      {
        error: "Upload error",
        message:
          "Something went wrong during the upload. Please try again or contact support if the problem continues.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
