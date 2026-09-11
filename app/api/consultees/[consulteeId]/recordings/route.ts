/**
 * Consultee Recordings API Route
 * GET /api/consultees/[consulteeId]/recordings
 *
 * Gets all recordings the consultee has access to through their enrollments.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    consulteeId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consulteeId } = await params;

    // Verify the user is accessing their own recordings (or admin/staff)
    if (
      session.user.role !== "ADMIN" &&
      session.user.role !== "STAFF" &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Parse query params for filtering
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") as "webinar" | "class" | null;

    // Get recordings from service
    const recordings = await RecordingService.getConsulteeRecordings(
      session.user.id,
      { type: type || undefined },
    );

    // Format recordings for response (async — generates presigned URLs)
    const formattedRecordings = await Promise.all(recordings.map(async (recording) => {
      const appointment =
        recording.meetingSession?.slotOfAppointment?.appointment;

      let planType: "webinar" | "class" | null = null;
      let planId: string | null = null;
      let planTitle: string | null = null;

      if (appointment?.webinar?.webinarPlan) {
        planType = "webinar";
        planId = appointment.webinar.webinarPlan.id ?? null;
        planTitle = appointment.webinar.webinarPlan.title ?? null;
      } else if (appointment?.class?.classPlan) {
        planType = "class";
        planId = appointment.class.classPlan.id ?? null;
        planTitle = appointment.class.classPlan.title ?? null;
      }

      return {
        id: recording.id,
        title: recording.title,
        durationInMinutes: recording.durationInMinutes,
        recordedAt: recording.recordedAt,
        status: recording.status,
        storageType: recording.storageType,
        playbackUrl: await getBestRecordingUrl(recording),
        thumbnailUrl: recording.thumbnailUrl,
        resolution: recording.resolution,
        planType,
        planId,
        planTitle,
        createdAt: recording.createdAt,
      };
    }));

    return NextResponse.json({
      recordings: formattedRecordings,
      total: formattedRecordings.length,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultees" } });
    console.error("Error getting consultee recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
