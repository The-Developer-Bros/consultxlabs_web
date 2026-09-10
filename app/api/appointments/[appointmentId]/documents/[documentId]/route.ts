import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse, after } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
import { applyRateLimit, documentReviewLimiter } from "@/lib/rate-limit";
import {
  isReviewTransitionAllowed,
  type ReviewStatus,
} from "@/lib/documents/document-review";
import { notifyDocumentReviewed } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { scopedHref } from "@/lib/novu/resolve-href";
// GET - Get specific document details
export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
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

    const { appointmentId, documentId } = await params;

    // In development mode with explicit bypass flag, allow access to any document for testing
    // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    // Build access control conditions - bypass in development
    const whereClause: Prisma.AppointmentDocumentWhereInput = {
      id: documentId,
      appointmentId,
    };

    if (!isDevelopment) {
      whereClause.appointment = {
        OR: [
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
          // User is part of subscription (consultee)
          {
            subscription: {
              requestedBy: {
                user: {
                  id: session.user.id,
                },
              },
            },
          },
          // User is part of subscription (consultant)
          {
            subscription: {
              subscriptionPlan: {
                consultantProfile: {
                  user: {
                    id: session.user.id,
                  },
                },
              },
            },
          },
        ],
      };
    }

    // Verify access and get document
    const document = await prisma.appointmentDocument.findFirst({
      where: whereClause,
    });

    if (!document) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: isDevelopment
            ? `[DEV MODE] Document ${documentId} not found for appointment ${appointmentId}.`
            : "Document not found or access denied",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // In development mode, log access bypass
    if (isDevelopment) {
      console.log(
        `[DEV MODE] Bypassing document access control for ${documentId}`,
      );
    }

    return NextResponse.json({ data: document });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    console.error("Error fetching document:", error);
    return NextResponse.json(
      { error: "Failed to fetch document" },
      { status: 500 },
    );
  }
}

// PATCH - Update document review status (consultant only)
export async function PATCH(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to review documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId, documentId } = await params;
    const body = await request.json();
    const { reviewStatus, reviewNotes } = body;

    // Review decisions mutate consultee-visible state; throttle like uploads.
    if (session?.user?.id) {
      const rateLimited = await applyRateLimit(
        documentReviewLimiter,
        session.user.id,
      );
      if (rateLimited) return rateLimited;
    }

    // In development mode with explicit bypass flag, allow any user to review documents for testing
    // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    // Build access control conditions - bypass in development
    const whereClause: Prisma.AppointmentDocumentWhereInput = {
      id: documentId,
      appointmentId,
      // Tombstoned rows are awaiting nightly purge — reviewing a deleted
      // document would resurrect it into the consultee's history.
      deletedAt: null,
    };

    if (!isDevelopment) {
      whereClause.appointment = {
        OR: [
          // User is the consultant for consultation
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
          // User is the consultant for subscription
          {
            subscription: {
              subscriptionPlan: {
                consultantProfile: {
                  user: {
                    id: session.user.id,
                  },
                },
              },
            },
          },
        ],
      };
    }

    // Verify user is the consultant for this appointment
    const document = await prisma.appointmentDocument.findFirst({
      where: whereClause,
    });

    if (!document) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: isDevelopment
            ? `[DEV MODE] Document ${documentId} not found for appointment ${appointmentId}.`
            : "Document not found or access denied",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Valid review statuses
    const validStatuses = [
      "PENDING",
      "IN_REVIEW",
      "APPROVED",
      "REJECTED",
      "NEEDS_REVISION",
    ];
    if (reviewStatus && !validStatuses.includes(reviewStatus)) {
      return NextResponse.json(
        { error: "Invalid review status" },
        { status: 400 },
      );
    }

    // Transition guard — APPROVED/REJECTED are terminal. Reopening a decided
    // review would rewrite history the consultee was already notified about;
    // corrections go through a threaded upload instead.
    if (
      reviewStatus &&
      !isReviewTransitionAllowed(
        document.reviewStatus as ReviewStatus,
        reviewStatus as ReviewStatus,
      )
    ) {
      return NextResponse.json(
        {
          error: "Invalid transition",
          message: `A ${document.reviewStatus.toLowerCase()} document can no longer move to ${reviewStatus}. Upload or request a threaded revision instead.`,
          code: "INVALID_REVIEW_TRANSITION",
        },
        { status: 409 },
      );
    }

    // Update document review status
    const updatedDocument = await prisma.appointmentDocument.update({
      where: {
        id: documentId,
      },
      data: {
        ...(reviewStatus && { reviewStatus }),
        ...(reviewNotes && { reviewNotes }),
        ...(reviewStatus && { reviewedAt: new Date() }),
        ...(reviewStatus && { reviewedById: session.user.id }), // A8 — FK scalar (#676)
      },
    });

    // Tell the consultee their submission moved. One recipient, known side →
    // scopedHref links straight at the right dashboard.
    const appointmentInfo = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        organizationId: true,
        consultation: {
          select: {
            requestedBy: {
              select: { id: true, user: { select: { id: true } } },
            },
            consultationPlan: {
              select: {
                consultantProfile: { select: { user: { select: { name: true } } } },
              },
            },
          },
        },
        subscription: {
          select: {
            requestedBy: {
              select: { id: true, user: { select: { id: true } } },
            },
            subscriptionPlan: {
              select: {
                consultantProfile: { select: { user: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });
    const recipientId =
      appointmentInfo?.consultation?.requestedBy?.user?.id ||
      appointmentInfo?.subscription?.requestedBy?.user?.id;
    const consulteeProfileId =
      appointmentInfo?.consultation?.requestedBy?.id ||
      appointmentInfo?.subscription?.requestedBy?.id;
    const reviewerName =
      appointmentInfo?.consultation?.consultationPlan?.consultantProfile?.user
        ?.name ||
      appointmentInfo?.subscription?.subscriptionPlan?.consultantProfile?.user
        ?.name ||
      "The consultant";

    if (recipientId && reviewStatus) {
      after(() =>
        notifyDocumentReviewed(recipientId, {
          ...notificationScope(appointmentInfo?.organizationId),
          appointmentId,
          documentId,
          reviewStatus: reviewStatus as ReviewStatus,
          reviewNotes: reviewNotes || undefined,
          originalName: document.originalName,
          consultantName: reviewerName,
          dashboardUrl: scopedHref({
            organizationId: appointmentInfo?.organizationId,
            surface: "appointments",
            personal:
              consulteeProfileId
                ? { kind: "consultee", profileId: consulteeProfileId }
                : undefined,
          }),
        }).catch((notifyError) => {
          console.error("Failed to notify consultee of review", notifyError);
          Sentry.captureException(notifyError instanceof Error ? notifyError : new Error(String(notifyError)), { tags: { subsystem: "novu" } });
        }),
      );
    }

    // In development mode, log review action
    if (isDevelopment) {
      console.log(
        `[DEV MODE] Document review updated for ${documentId} - Status: ${reviewStatus || "no change"}`,
      );
    }

    return NextResponse.json({ data: updatedDocument });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    console.error("Error updating document review:", error);
    return NextResponse.json(
      { error: "Failed to update document review" },
      { status: 500 },
    );
  }
}

// DELETE - Delete document (consultee only, and only if not reviewed yet)
export async function DELETE(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to delete documents",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { appointmentId, documentId } = await params;

    // In development mode with explicit bypass flag, allow any user to delete documents for testing
    // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    // Build access control conditions - bypass in development
    const whereClause: Prisma.AppointmentDocumentWhereInput = {
      id: documentId,
      appointmentId,
      reviewStatus: "PENDING", // Only allow deletion of pending documents
      deletedAt: null, // Already-tombstoned rows are invisible to deletion
    };

    if (!isDevelopment) {
      whereClause.appointment = {
        OR: [
          // User is the consultee for consultation
          {
            consultation: {
              requestedBy: {
                user: {
                  id: session.user.id,
                },
              },
            },
          },
          // User is the consultee for subscription
          {
            subscription: {
              requestedBy: {
                user: {
                  id: session.user.id,
                },
              },
            },
          },
        ],
      };
    }

    // Verify user is the consultee and document is not yet reviewed
    const document = await prisma.appointmentDocument.findFirst({
      where: whereClause,
    });

    if (!document) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: isDevelopment
            ? `[DEV MODE] Document ${documentId} not found, not pending, or already reviewed.`
            : "Document not found, access denied, or already reviewed",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Soft delete — tombstone the row; the nightly cleanup job removes the
    // storage object after a grace window, then hard-deletes. Immediate
    // storage deletion here used to make an accidental click unrecoverable
    // and raced the reconcile job's storage-missing detection.
    await prisma.appointmentDocument.update({
      where: {
        id: documentId,
      },
      data: {
        deletedAt: new Date(),
        ...(session.user?.id ? { deletedById: session.user.id } : {}),
      },
    });

    // In development mode, log deletion
    if (isDevelopment) {
      console.log(
        `[DEV MODE] Document soft-deleted: ${documentId} from appointment ${appointmentId}`,
      );
    }

    return NextResponse.json({
      message: isDevelopment
        ? "[DEV MODE] Document deleted successfully"
        : "Document deleted successfully",
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    console.error("Error deleting document:", error);
    return NextResponse.json(
      { error: "Failed to delete document" },
      { status: 500 },
    );
  }
}
