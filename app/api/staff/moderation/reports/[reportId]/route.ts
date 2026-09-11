/**
 * Staff Moderation Report Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ModerationReportStatus } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
interface RouteParams {
  params: Promise<{ reportId: string }>;
}

/**
 * GET /api/staff/moderation/reports/[reportId]
 * Get report details
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { reportId } = await params;

    const report = await prisma.moderationReport.findUnique({
      where: { id: reportId },
      include: {
        reportedBy: {
          select: { id: true, name: true, email: true, image: true },
        },
        targetUser: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
          },
        },
        actions: {
          include: {
            takenBy: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!report) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }

    return NextResponse.json({ report });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching moderation report:", error);
    return NextResponse.json(
      { error: "Failed to fetch report" },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/staff/moderation/reports/[reportId]
 * Update report status or assignment
 */
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    const { reportId } = await params;
    const body = await req.json();
    const { status, assignedToId } = body;

    const updateData: {
      status?: ModerationReportStatus;
      assignedToId?: string | null;
      resolvedAt?: Date;
      resolvedBy?: string;
    } = {};

    if (status !== undefined) {
      const validStatuses: ModerationReportStatus[] = [
        "PENDING",
        "UNDER_REVIEW",
        "DISMISSED",
        "ACTION_TAKEN",
        "ESCALATED",
      ];
      if (!validStatuses.includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      updateData.status = status;

      // Set resolved info if resolving
      if (status === "DISMISSED" || status === "ACTION_TAKEN") {
        updateData.resolvedAt = new Date();
        updateData.resolvedBy = session.user.id;
      }
    }

    if (assignedToId !== undefined) {
      updateData.assignedToId = assignedToId || null;
    }

    const report = await prisma.moderationReport.update({
      where: { id: reportId },
      data: updateData,
      include: {
        reportedBy: {
          select: { id: true, name: true, email: true },
        },
        targetUser: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });

    return NextResponse.json({ report });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error updating moderation report:", error);
    return NextResponse.json(
      { error: "Failed to update report" },
      { status: 500 },
    );
  }
}
