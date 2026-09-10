/**
 * Webinar Plan Recordings API Route
 * GET /api/plans/webinars/[webinarPlanId]/recordings
 *
 * Gets all recordings for a specific webinar plan.
 * Access: Consultant owner or enrolled consultees.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import prisma from "@/lib/prisma";
import { isPrivileged } from "@/lib/auth-helpers";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    webinarPlanId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { webinarPlanId } = await params;

    // Get the webinar plan to check ownership and recording settings
    const webinarPlan = await prisma.webinarPlan.findUnique({
      where: { id: webinarPlanId },
      select: {
        id: true,
        title: true,
        consultantProfileId: true,
        recordingEnabled: true,
      },
    });

    if (!webinarPlan) {
      return NextResponse.json(
        { error: "Webinar plan not found" },
        { status: 404 },
      );
    }

    // Check access permissions
    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
    let hasAccess = false;

    if (isPrivileged(session.user.role)) {
      hasAccess = true;
    }

    // Provider path: owns the plan, or is an accepted collaborator.
    if (!hasAccess && session.user.consultantProfileId) {
      hasAccess =
        webinarPlan.consultantProfileId === session.user.consultantProfileId;
      if (!hasAccess) {
        const collab = await prisma.collaborator.findFirst({
          where: {
            webinarPlanId,
            consultantProfileId: session.user.consultantProfileId,
            status: "ACCEPTED",
          },
        });
        hasAccess = !!collab;
      }
    }

    // Attendee path: must have purchased a webinar from this plan.
    if (!hasAccess) {
      const enrollment = await prisma.payment.findFirst({
        where: {
          userId: session.user.id,
          paymentStatus: "SUCCEEDED",
          appointment: {
            webinar: {
              webinarPlanId,
            },
          },
        },
      });
      hasAccess = !!enrollment;
    }

    if (!hasAccess) {
      return NextResponse.json(
        { error: "Access denied to these recordings" },
        { status: 403 },
      );
    }

    // Get recordings for this webinar plan
    const recordings =
      await RecordingService.getWebinarPlanRecordings(webinarPlanId);

    // Map recordings to response format (async — presigned URLs)
    const formattedRecordings = await Promise.all(recordings.map(async (recording) => ({
      id: recording.id,
      title: recording.title,
      durationInMinutes: recording.durationInMinutes,
      recordedAt: recording.recordedAt,
      status: recording.status,
      storageType: recording.storageType,
      playbackUrl: await getBestRecordingUrl(recording),
      thumbnailUrl: recording.thumbnailUrl,
      resolution: recording.resolution,
      previewClipUrl: recording.previewClipUrl,
      previewClipDuration: recording.previewClipDuration,
      streamUrlExpiresAt: recording.streamUrlExpiresAt,
      createdAt: recording.createdAt,
    })));

    return NextResponse.json({
      planId: webinarPlanId,
      planTitle: webinarPlan.title,
      recordingEnabled: webinarPlan.recordingEnabled,
      recordings: formattedRecordings,
      total: formattedRecordings.length,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "plans" } });
    console.error("Error getting webinar plan recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
