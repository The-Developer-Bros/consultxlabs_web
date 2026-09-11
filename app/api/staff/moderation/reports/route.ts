/**
 * Staff Moderation Reports API
 * List and create moderation reports
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import {
  ModerationReportType,
  ModerationReportStatus,
  Prisma,
  type UserRole,
} from "@prisma/client";

/**
 * GET /api/staff/moderation/reports
 * List moderation reports with filters
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") as ModerationReportType | null;
    const status = searchParams.get("status") as ModerationReportStatus | null;
    const assignedToId = searchParams.get("assignedToId");
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    const where: Prisma.ModerationReportWhereInput = {};

    if (type) where.type = type;
    if (status) where.status = status;
    if (assignedToId) {
      where.assignedToId = assignedToId === "unassigned" ? null : assignedToId;
    }
    // #997 secondary findings — the client used to fetch every PENDING
    // report and substring-search on every keystroke. Search server-side
    // over the same fields the old client filter checked.
    if (search) {
      where.OR = [
        { id: { contains: search, mode: "insensitive" } },
        { reason: { contains: search, mode: "insensitive" } },
        { reportedBy: { name: { contains: search, mode: "insensitive" } } },
        { targetUser: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [reports, total] = await Promise.all([
      prisma.moderationReport.findMany({
        where,
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
              // #1270 — the unban path needs to know the target is still
              // banned, and a moderator looking at a second report about an
              // already-banned account should see that before acting again.
              banned: true,
              banExpires: true,
            },
          },
          // #1270 — the enforcement outcome of the last action taken. It has
          // been written to ModerationAction.sideEffects since #693 and read by
          // nothing, so a ban whose Stream revocation failed looked identical
          // to one that landed.
          actions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              actionType: true,
              createdAt: true,
              sideEffects: true,
            },
          },
          _count: {
            select: { actions: true },
          },
        },
        orderBy: [
          { status: "asc" }, // Pending first
          { reportCount: "desc" }, // More reports = higher priority
          { createdAt: "desc" },
        ],
        take: limit,
        skip: offset,
      }),
      prisma.moderationReport.count({ where }),
    ]);

    const formattedReports = reports.map((report) => ({
      id: report.id,
      type: report.type,
      status: report.status,
      reason: report.reason,
      description: report.description,
      contentText: report.contentText,
      contentUrl: report.contentUrl,
      streamMessageId: report.streamMessageId,
      streamChannelCid: report.streamChannelCid,
      reportCount: report.reportCount,
      reportedBy: report.reportedBy,
      targetUser: report.targetUser,
      reviewId: report.reviewId,
      assignedToId: report.assignedToId,
      actionCount: report._count.actions,
      latestAction: report.actions[0] ?? null,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
    }));

    // Get counts by status
    const statusCounts = await prisma.moderationReport.groupBy({
      by: ["status"],
      _count: { id: true },
    });

    const counts = {
      total,
      pending: statusCounts.find((s) => s.status === "PENDING")?._count.id || 0,
      underReview:
        statusCounts.find((s) => s.status === "UNDER_REVIEW")?._count.id || 0,
      dismissed:
        statusCounts.find((s) => s.status === "DISMISSED")?._count.id || 0,
      actionTaken:
        statusCounts.find((s) => s.status === "ACTION_TAKEN")?._count.id || 0,
      escalated:
        statusCounts.find((s) => s.status === "ESCALATED")?._count.id || 0,
    };

    return NextResponse.json({
      reports: formattedReports,
      counts,
      // #1270 — banning is ADMIN-only (`users.moderate`), but the queue showed
      // every moderator a Ban button that answered 403. Ship the capability so
      // the UI can offer what the caller may actually do.
      capabilities: {
        canModerateUsers: hasBackofficePermission(
          auth.session.user.role as UserRole,
          "users.moderate",
        ),
      },
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "staff" } });
    console.error("Error fetching moderation reports:", error);
    return NextResponse.json(
      { error: "Failed to fetch moderation reports" },
      { status: 500 },
    );
  }
}
