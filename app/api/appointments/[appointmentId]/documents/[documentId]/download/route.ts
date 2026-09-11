import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { Prisma } from "@prisma/client";
import { isBookingTerminal } from "@/lib/appointments/terminal-status";

import { getSession } from "@/lib/auth-server";

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ appointmentId: string; documentId: string }> },
) {
  try {
    const { appointmentId, documentId } = await params;

    // Get user session
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to download documents",
        },
        { status: 401 },
      );
    }

    const userId = session.user.id;

    // Build access control for the appointment first
    // In development mode with explicit bypass flag, allow access to any document for testing
    // Requires both NODE_ENV=development AND DEV_BYPASS_AUTH=true for safety
    const isDevelopment =
      process.env.NODE_ENV === "development" &&
      process.env.DEV_BYPASS_AUTH === "true";

    // Build appointment access control - same as in the documents API
    const appointmentWhereClause: Prisma.AppointmentWhereInput = {
      id: appointmentId,
    };

    if (!isDevelopment) {
      appointmentWhereClause.OR = [
        // User is the consultee
        {
          consultation: {
            requestedBy: {
              user: {
                id: userId,
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
                  id: userId,
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
                    id: userId,
                  },
                },
              },
              {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      id: userId,
                    },
                  },
                },
              },
            ],
          },
        },
      ];
    }

    // First verify user has access to the appointment. Only consultation/
    // subscription bookings are reachable via the auth filter above, so those
    // are the statuses we need for the terminal check (DOC-1).
    const appointment = await prisma.appointment.findFirst({
      where: appointmentWhereClause,
      include: {
        consultation: { select: { status: true } },
        subscription: { select: { status: true } },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        {
          error: "Appointment not found",
          message: isDevelopment
            ? `[DEV MODE] This appointment doesn't exist or you don't have access to it.`
            : "This appointment doesn't exist or you don't have permission to access it.",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // DOC-1 (#694) — block byte streaming once the parent booking is terminal;
    // identity-only authorization previously kept files downloadable after a
    // cancel/refund.
    if (isBookingTerminal(appointment)) {
      return NextResponse.json(
        {
          error: "Document unavailable",
          message:
            "This appointment has been cancelled or closed, so its documents are no longer available for download.",
          code: "APPOINTMENT_TERMINAL",
        },
        { status: 403 },
      );
    }

    // Now find the document
    const document = await prisma.appointmentDocument.findFirst({
      where: {
        id: documentId,
        appointmentId,
      },
    });

    if (!document) {
      return NextResponse.json(
        {
          error: "Document not found",
          message: isDevelopment
            ? `[DEV MODE] Document ${documentId} not found in appointment ${appointmentId}`
            : "The requested document was not found or you don't have permission to access it",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Download file from Supabase — require admin client for private bucket access
    if (!supabaseAdmin) {
      console.error(
        "Supabase admin client not configured. Set SUPABASE_SERVICE_ROLE_KEY to enable document downloads.",
      );
      Sentry.captureException(new Error("Supabase admin client not configured"), { tags: { subsystem: "appointments" } });
      return NextResponse.json(
        {
          error: "Storage configuration error",
          message: "Document storage is not properly configured on the server.",
          code: "STORAGE_CONFIG_ERROR",
        },
        { status: 500 },
      );
    }

    const { data: fileData, error: downloadError } =
      await supabaseAdmin.storage
        .from("documents")
        .download(document.storagePath);

    if (downloadError || !fileData) {
      console.error("Supabase download error:", downloadError);
      Sentry.captureException(downloadError instanceof Error ? downloadError : new Error(String(downloadError)), { tags: { subsystem: "appointments" } });
      return NextResponse.json(
        {
          error: "Download failed",
          message:
            "Unable to retrieve the file from storage. Please try again later.",
          code: "STORAGE_ERROR",
        },
        { status: 500 },
      );
    }

    // Convert blob to buffer
    const buffer = Buffer.from(await fileData.arrayBuffer());

    // Create response with proper headers for download
    const response = new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": document.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(document.originalName)}"`,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });

    return response;
  } catch (error) {
    console.error("Document download error:", error);
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "appointments" } });
    return NextResponse.json(
      {
        error: "Server error",
        message:
          "An unexpected error occurred while downloading the document. Please try again.",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
