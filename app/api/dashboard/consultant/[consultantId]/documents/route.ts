import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, DocumentReviewStatus } from "@prisma/client";
import { resolveOrgScope, scopeOrgId } from "@/lib/api/scope/parse";

import { getSession } from "@/lib/auth-server";
// GET - Get all documents for review by consultant
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view documents for review",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        {
          error: "Invalid consultant",
          message: "Consultant ID is required",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const appointmentType = searchParams.get("appointmentType");

    // Parse + validate pagination params (issue #346)
    const DEFAULT_LIMIT = 10;
    const MAX_LIMIT = 100;

    const rawLimit = searchParams.get("limit");
    const rawOffset = searchParams.get("offset");

    const parsedLimit = rawLimit
      ? Number.parseInt(rawLimit, 10)
      : DEFAULT_LIMIT;
    const parsedOffset = rawOffset ? Number.parseInt(rawOffset, 10) : 0;

    if (
      !Number.isFinite(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > MAX_LIMIT
    ) {
      return NextResponse.json(
        {
          error: "Invalid limit",
          message: `"limit" must be an integer between 1 and ${MAX_LIMIT}.`,
          code: "INVALID_PAGINATION",
        },
        { status: 400 },
      );
    }

    if (!Number.isFinite(parsedOffset) || parsedOffset < 0) {
      return NextResponse.json(
        {
          error: "Invalid offset",
          message: `"offset" must be a non-negative integer.`,
          code: "INVALID_PAGINATION",
        },
        { status: 400 },
      );
    }

    const take = parsedLimit;
    const skip = parsedOffset;

    // Verify user is the consultant with enhanced error handling
    let consultant;
    try {
      // In development mode with explicit bypass flag, allow access to any consultant's documents for testing
      // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
      const isDevelopment =
        process.env.NODE_ENV === "development" &&
        process.env.DEV_BYPASS_AUTH === "true";

      const consultantWhereClause: Prisma.ConsultantProfileWhereInput = {
        id: consultantId,
      };

      if (!isDevelopment) {
        consultantWhereClause.user = {
          id: session.user.id,
        };
      }

      consultant = await prisma.consultantProfile.findFirst({
        where: consultantWhereClause,
        include: {
          user: {
            select: { name: true, email: true },
          },
        },
      });

      // In development mode, log access bypass
      if (isDevelopment && consultant) {
        console.log(
          `[DEV MODE] Bypassing consultant access control for ${consultantId}`,
        );
      }
    } catch (dbError) {
      console.error("Database error fetching consultant:", dbError);
      Sentry.captureException(dbError instanceof Error ? dbError : new Error(String(dbError)), { tags: { subsystem: "dashboard" } });
      return NextResponse.json(
        {
          error: "Database temporarily unavailable",
          message:
            "Unable to verify consultant access. Please try again in a few moments.",
          code: "DATABASE_ERROR",
        },
        { status: 503 },
      );
    }

    if (!consultant) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            process.env.NODE_ENV === "development"
              ? `[DEV MODE] Consultant profile ${consultantId} not found in database.`
              : "You don't have permission to view documents for this consultant profile. Please check that you're accessing the correct consultant dashboard.",
          code: "ACCESS_DENIED",
        },
        { status: 403 },
      );
    }

    // B1-personal-retrofit: parse + authorize ?orgScope=. Filter applies
    // to the parent Appointment.organizationId.
    const callerMembershipsForScope = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true, role: true },
    });
    const docScopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships: callerMembershipsForScope,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped consultant endpoint.
      allowAllForOwner: true,
    });
    if (!docScopeResolution.ok) {
      return NextResponse.json(
        {
          error: docScopeResolution.message,
          code: docScopeResolution.code,
        },
        { status: docScopeResolution.status },
      );
    }
    // `orgMember` pins an org exactly as `org` does — see scopeOrgId.
    const docScopedOrgId = scopeOrgId(docScopeResolution.scope);
    const docOrgFilter: Partial<Prisma.AppointmentWhereInput> =
      docScopeResolution.scope.kind === "personal"
        ? { organizationId: null }
        : docScopedOrgId
          ? { organizationId: docScopedOrgId }
          : {};

    // Build where clause
    const where: Prisma.AppointmentDocumentWhereInput = {
      appointment: {
        OR: [
          // Consultation appointments
          {
            consultation: {
              consultationPlan: {
                consultantProfileId: consultantId,
              },
            },
          },
          // Subscription appointments
          {
            subscription: {
              subscriptionPlan: {
                consultantProfileId: consultantId,
              },
            },
          },
        ],
        ...docOrgFilter,
      },
    };

    // Add status filter with validation
    if (status) {
      const validStatuses = [
        "PENDING",
        "IN_REVIEW",
        "APPROVED",
        "REJECTED",
        "NEEDS_REVISION",
      ];
      if (validStatuses.includes(status)) {
        where.reviewStatus = status as DocumentReviewStatus;
      } else {
        return NextResponse.json(
          {
            error: "Invalid status filter",
            message: `Status "${status}" is not valid. Valid statuses are: ${validStatuses.join(", ")}`,
            code: "INVALID_FILTER",
          },
          { status: 400 },
        );
      }
    }

    // Add appointment type filter with validation
    if (appointmentType) {
      const validTypes = ["Consultation", "Subscription"];
      if (!validTypes.includes(appointmentType)) {
        return NextResponse.json(
          {
            error: "Invalid appointment type filter",
            message: `Appointment type "${appointmentType}" is not valid. Valid types are: ${validTypes.join(", ")}`,
            code: "INVALID_FILTER",
          },
          { status: 400 },
        );
      }

      const appointmentFilter =
        where.appointment as Prisma.AppointmentWhereInput;
      if (appointmentType === "Consultation" && appointmentFilter) {
        appointmentFilter.consultation = { isNot: null };
        appointmentFilter.subscription = null;
      } else if (appointmentType === "Subscription" && appointmentFilter) {
        appointmentFilter.subscription = { isNot: null };
        appointmentFilter.consultation = null;
      }
    }

    // Fetch documents, total count, and status breakdown in parallel.
    // - findMany: current page only (take/skip)
    // - count: total matching rows across all pages
    // - groupBy: per-status counts for the metadata block (filter-aware)
    let documents;
    let totalCount: number;
    let metadataGrouped: Array<{
      reviewStatus: DocumentReviewStatus;
      _count: { _all: number };
    }>;
    try {
      [documents, totalCount, metadataGrouped] = await Promise.all([
        prisma.appointmentDocument.findMany({
          where,
          include: {
            appointment: {
              include: {
                consultation: {
                  include: {
                    requestedBy: {
                      include: {
                        user: true,
                      },
                    },
                    consultationPlan: true,
                  },
                },
                subscription: {
                  include: {
                    requestedBy: {
                      include: {
                        user: true,
                      },
                    },
                    subscriptionPlan: true,
                  },
                },
              },
            },
          },
          orderBy: {
            uploadedAt: "desc",
          },
          take,
          skip,
        }),
        prisma.appointmentDocument.count({ where }),
        prisma.appointmentDocument.groupBy({
          by: ["reviewStatus"],
          where: { ...where, reviewStatus: undefined },
          _count: { _all: true },
        }),
      ]);
    } catch (dbError) {
      console.error("Database error fetching documents:", dbError);
      Sentry.captureException(dbError instanceof Error ? dbError : new Error(String(dbError)), { tags: { subsystem: "dashboard" } });

      // Return an empty page envelope with helpful message instead of failing.
      // Shape must match the success branch so the UI's pagination prop is
      // never undefined on DB errors.
      return NextResponse.json({
        data: [],
        count: 0,
        message:
          "Unable to load documents at the moment. This might be because no documents have been uploaded yet, or there's a temporary system issue. Please try again later.",
        consultant: consultant.user.name,
        filters: {
          status,
          appointmentType,
        },
        pagination: {
          limit: take,
          offset: skip,
          totalCount: 0,
          totalPages: 1,
          currentPage: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
        metadata: {
          pendingCount: 0,
          reviewingCount: 0,
          needsRevisionCount: 0,
          completedCount: 0,
        },
      });
    }

    // Transform data for frontend with error resilience
    const transformedDocuments = documents.map((doc) => {
      try {
        const appointment = doc.appointment;
        const consultation = appointment.consultation;
        const subscription = appointment.subscription;

        // Determine client info and appointment details with fallbacks
        let clientName = "Unknown Client";
        let clientId = "";
        let appointmentTitle = "Unknown Appointment";
        let appointmentType = "Unknown";

        if (consultation) {
          clientName = consultation.requestedBy?.user?.name || "Unknown Client";
          clientId = consultation.requestedBy?.user?.id || "";
          appointmentTitle =
            consultation.consultationPlan?.title || "Consultation";
          appointmentType = "Consultation";
        } else if (subscription) {
          clientName = subscription.requestedBy?.user?.name || "Unknown Client";
          clientId = subscription.requestedBy?.user?.id || "";
          appointmentTitle =
            subscription.subscriptionPlan?.title || "Subscription";
          appointmentType = "Subscription";
        }

        return {
          id: doc.id,
          appointmentId: doc.appointmentId,
          fileName: doc.fileName,
          originalName: doc.originalName,
          fileSize: doc.fileSize,
          mimeType: doc.mimeType,
          fileUrl: doc.fileUrl,
          description: doc.description,
          reviewStatus: doc.reviewStatus,
          reviewNotes: doc.reviewNotes,
          reviewedAt: doc.reviewedAt,
          uploadedAt: doc.uploadedAt,
          clientName,
          clientId,
          appointmentTitle,
          appointmentType,
          // Legacy fields for existing UI compatibility
          title: doc.originalName,
          invoiceNo: `DOC-${doc.id.slice(-8)}`,
          tag: doc.reviewStatus,
        };
      } catch (transformError) {
        console.error("Error transforming document:", transformError, doc);
        Sentry.captureException(transformError instanceof Error ? transformError : new Error(String(transformError)), { tags: { subsystem: "dashboard" } });

        // Return a safe fallback version of the document
        return {
          id: doc.id || "unknown",
          appointmentId: doc.appointmentId || "unknown",
          fileName: doc.fileName || "Unknown File",
          originalName: doc.originalName || "Unknown Document",
          fileSize: doc.fileSize || 0,
          mimeType: doc.mimeType || "application/octet-stream",
          fileUrl: doc.fileUrl || "",
          description: doc.description || null,
          reviewStatus: doc.reviewStatus || "PENDING",
          reviewNotes: doc.reviewNotes || null,
          reviewedAt: doc.reviewedAt || null,
          uploadedAt: doc.uploadedAt || new Date(),
          clientName: "Unknown Client",
          clientId: "",
          appointmentTitle: "Unknown Appointment",
          appointmentType: "Unknown",
          // Legacy fields
          title: doc.originalName || "Unknown Document",
          invoiceNo: `DOC-${(doc.id || "unknown").slice(-8)}`,
          tag: doc.reviewStatus || "PENDING",
        };
      }
    });

    // Derive metadata counts from the groupBy result so they reflect the
    // full filtered dataset, not just the current page (issue #346, Q1).
    const countByStatus = new Map<DocumentReviewStatus, number>(
      metadataGrouped.map((row) => [row.reviewStatus, row._count._all]),
    );
    const metadata = {
      pendingCount: countByStatus.get("PENDING") ?? 0,
      reviewingCount: countByStatus.get("IN_REVIEW") ?? 0,
      needsRevisionCount: countByStatus.get("NEEDS_REVISION") ?? 0,
      completedCount:
        (countByStatus.get("APPROVED") ?? 0) +
        (countByStatus.get("REJECTED") ?? 0),
    };

    // Provide helpful context messages. `totalCount` now comes from the
    // count() query so it reflects all rows matching `where`, not the page.
    let message = "";
    const isDevelopment = process.env.NODE_ENV === "development";
    const devModeMessage = isDevelopment
      ? " [DEV MODE - Access control bypassed]"
      : "";

    if (totalCount === 0) {
      if (status || appointmentType) {
        message = `No documents found with the applied filters. Try removing some filters to see more documents.${devModeMessage}`;
      } else {
        message = `No documents have been submitted for review yet. Documents will appear here when clients upload files for their appointments.${devModeMessage}`;
      }
    } else {
      const filterText = [];
      if (status) filterText.push(`status: ${status}`);
      if (appointmentType) filterText.push(`type: ${appointmentType}`);

      const filterSuffix =
        filterText.length > 0 ? ` (filtered by ${filterText.join(", ")})` : "";
      message = `Found ${totalCount} document${totalCount === 1 ? "" : "s"} for review${filterSuffix}.${devModeMessage}`;
    }

    return NextResponse.json({
      data: transformedDocuments,
      count: totalCount,
      message,
      consultant: isDevelopment
        ? `${consultant.user.name} [DEV MODE]`
        : consultant.user.name,
      filters: {
        status,
        appointmentType,
      },
      pagination: {
        limit: take,
        offset: skip,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / take)),
        currentPage: Math.floor(skip / take) + 1,
        hasNextPage: skip + take < totalCount,
        hasPrevPage: skip > 0,
      },
      metadata,
    });
  } catch (error) {
    console.error("Error fetching consultant documents:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "dashboard" } });

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
              "Unable to connect to the document system. Please check your internet connection and try again.",
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
              "The document review system is temporarily unavailable. Please try again in a few moments.",
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
          "Something went wrong while loading documents for review. Please refresh the page or try again later. If the problem persists, contact support.",
        code: "UNKNOWN_ERROR",
      },
      { status: 500 },
    );
  }
}
