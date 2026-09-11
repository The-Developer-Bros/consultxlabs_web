/**
 * Staff Moderation Stats API
 * Moderation dashboard statistics
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
/**
 * GET /api/staff/moderation/stats
 * Get moderation statistics
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const days = parseInt(searchParams.get("days") || "7");
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // The card reads "Resolved Today", so it counts from midnight — not from
    // `startDate`, which is the ?days= window (7 by default) that drives the
    // breakdowns below. Server-local midnight matches how every other
    // operator "today" metric is computed (staff/metrics, operators/stats),
    // and agreeing with those matters more than picking a different zone here.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // The four counters behind the stat cards. Names match the card labels and
    // the shared `ModerationStats` type exactly — they used to differ from
    // both, which is half of why every card rendered 0.
    const [pendingReports, resolvedToday, pendingProfiles, pendingReviews] =
      await Promise.all([
        prisma.moderationReport.count({
          where: { status: "PENDING" },
        }),
        prisma.moderationReport.count({
          where: {
            status: { in: ["DISMISSED", "ACTION_TAKEN"] },
            resolvedAt: { gte: startOfToday },
          },
        }),
        prisma.consultantProfileVerification.count({
          where: { status: "PENDING" },
        }),
        // "Reviews to Check" is a moderation queue, and a review only enters
        // one by being reported — `ConsultantReview` carries no status, flag
        // or moderatedAt column of its own. This used to be an unfiltered
        // count of every review row ever written, which is not a queue and
        // would never reach zero.
        prisma.moderationReport.count({
          where: { status: "PENDING", type: "REVIEW" },
        }),
      ]);

    // Get report type breakdown
    const reportsByType = await prisma.moderationReport.groupBy({
      by: ["type"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    // Get action type breakdown
    const actionsByType = await prisma.moderationAction.groupBy({
      by: ["actionType"],
      where: {
        createdAt: { gte: startDate },
      },
      _count: { id: true },
    });

    return NextResponse.json({
      stats: {
        pendingReports,
        pendingProfiles,
        pendingReviews,
        resolvedToday,
      },
      reportsByType: reportsByType.map((r) => ({
        type: r.type,
        count: r._count.id,
      })),
      actionsByType: actionsByType.map((a) => ({
        actionType: a.actionType,
        count: a._count.id,
      })),
      period: { days, startDate, endDate: new Date() },
    });
  } catch (error) {
    console.error("Error fetching moderation stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch stats" },
      { status: 500 },
    );
  }
}
