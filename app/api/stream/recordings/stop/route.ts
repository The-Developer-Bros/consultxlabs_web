/**
 * Stop Recording API Route
 * POST /api/stream/recordings/stop
 *
 * Stops recording for a video call. Only consultants can stop recordings.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import { getMeetingSessionOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";

import { getSession } from "@/lib/auth-server";
const stopRecordingSchema = z.object({
  meetingSessionId: z.string().min(1, "Meeting session ID is required"),
});

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Capability, not UserRole (#org-appts): anyone who OWNS a consultantProfile
    // (incl. an org EXPERT whose marketplace identity is CONSULTEE) may control
    // their own recordings — the per-appointment ownership check below is the
    // real authz. ADMIN/STAFF are handled by that check too.
    if (!session.user.consultantProfileId) {
      return NextResponse.json(
        { error: "Only consultants can stop recordings" },
        { status: 403 },
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const { meetingSessionId } = stopRecordingSchema.parse(body);

    // Verify the meeting session exists
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { id: meetingSessionId },
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                // #1134 P1-6 — mirror the start route: without these the owner
                // of a 1:1 cannot stop a recording they were able to start.
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!meetingSession) {
      return NextResponse.json(
        { error: "Meeting session not found" },
        { status: 404 },
      );
    }

    // Look up consultant profile for the logged-in user
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    // Verify the consultant owns this appointment using helper function
    const { isOwner } = getMeetingSessionOwnershipInfo(
      meetingSession,
      consultantProfile?.id,
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to stop this recording" },
        { status: 403 },
      );
    }

    // Verify recording is actually in progress before calling Stream API
    if (!meetingSession.isRecording) {
      return NextResponse.json(
        { error: "No recording in progress" },
        { status: 409 },
      );
    }

    // Atomically claim the stop operation (prevents concurrent stop requests)
    const claimed = await prisma.meetingSession.updateMany({
      where: { id: meetingSessionId, isRecording: true },
      data: { isRecording: false },
    });

    if (claimed.count === 0) {
      // Another concurrent request already claimed the stop
      return NextResponse.json(
        { error: "No recording in progress" },
        { status: 409 },
      );
    }

    // Stop recording via Stream API (use DB-stored call ID, never trust client)
    const result = await RecordingService.stopRecording(meetingSession.streamCallId);

    if (!result.success) {
      // Rollback: restore isRecording=true since Stream stop failed
      await prisma.meetingSession.update({
        where: { id: meetingSessionId },
        data: { isRecording: true },
      });
      streamLogger.error("Stream stop failed, rolled back DB state", null, {
        meetingSessionId,
        streamCallId: meetingSession.streamCallId,
      });
      return NextResponse.json(
        { error: result.error || "Failed to stop recording" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Recording stopped",
    });
  } catch (error) {
    streamLogger.error("Error stopping recording", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: error.errors },
        { status: 400 },
      );
    }

    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    return NextResponse.json(
      { error: "Failed to stop recording" },
      { status: 500 },
    );
  }
}
