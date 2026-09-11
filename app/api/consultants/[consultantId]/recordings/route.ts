/**
 * Consultant Recordings API Route
 * GET /api/consultants/[consultantId]/recordings
 *
 * Gets all recordings for a consultant's webinars and classes.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { RecordingService } from "@/lib/stream/recording-service";
import { getBestRecordingUrl } from "@/lib/stream/recording-storage";
import { RecordingStatus } from "@prisma/client";
import prisma from "@/lib/prisma";

import { getSession } from "@/lib/auth-server";
type RouteParams = {
  params: Promise<{
    consultantId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultantId } = await params;

    // Verify the user is accessing their own recordings
    if (session.user.role !== "ADMIN" && session.user.role !== "STAFF") {
      const consultantProfile = await prisma.consultantProfile.findUnique({
        where: { userId: session.user.id },
        select: { id: true },
      });
      if (consultantProfile?.id !== consultantId) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }

    // Parse query params for filtering
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") as "webinar" | "class" | null;
    const status = searchParams.get("status") as RecordingStatus | null;
    const search = searchParams.get("search") || undefined;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "12");

    // Get recordings with database-level filtering
    const { recordings, total } = await RecordingService.getConsultantRecordings(
      consultantId,
      {
        type: type || undefined,
        status: status || undefined,
        search,
        page,
        limit,
        // #1166 ORG-6 — personal dashboard endpoint, so pin personal
        // (ADR 19). An org recordings surface would pass its own orgId.
        organizationId: null,
      },
    );

    // Map recordings to response format with best URLs (async — presigned URLs)
    const formattedRecordings = await Promise.all(recordings.map(async (recording) => {
      const slot = recording.meetingSession.slotOfAppointment;
      const appointment = slot.appointment;

      let planType: "webinar" | "class" | null = null;
      let planId: string | null = null;
      let planTitle: string | null = null;

      if (appointment?.webinar?.webinarPlan) {
        planType = "webinar";
        planId = appointment.webinar.webinarPlan.id;
        planTitle = appointment.webinar.webinarPlan.title;
      } else if (appointment?.class?.classPlan) {
        planType = "class";
        planId = appointment.class.classPlan.id;
        planTitle = appointment.class.classPlan.title;
      }

      // Extract participant info from slot users
      const allNames = slot.user
        .map((u) => u.name)
        .filter((n): n is string => n !== null);
      const participantNames = allNames.slice(0, 3);
      const participantCount = allNames.length;

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
        fileSize: recording.fileSize ? Number(recording.fileSize) : null,
        streamUrlExpiresAt: recording.streamUrlExpiresAt,
        transferredAt: recording.transferredAt,
        planType,
        planId,
        planTitle,
        participantNames,
        participantCount,
        appointmentDate: slot.startsAt,
        createdAt: recording.createdAt,
      };
    }));

    return NextResponse.json({
      recordings: formattedRecordings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "consultants" } });
    console.error("Error getting consultant recordings:", error);
    return NextResponse.json(
      { error: "Failed to get recordings" },
      { status: 500 },
    );
  }
}
