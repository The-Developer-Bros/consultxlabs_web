/**
 * Stream Recording Event Handlers
 * Handles webhook events for recording lifecycle
 */

import { after } from "next/server";
import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import {
  notifyRecordingAvailable,
  notifyRecordingFailed,
} from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { getAppUrl } from "@/lib/url";
import {
  generateRecordingTitle,
  getEventAttendeeIds,
} from "@/lib/stream/recording-utils";
import { RecordingTransferService } from "@/lib/stream/recording-transfer-service";

// Types for Stream webhook payloads
export interface StreamRecordingStartedEvent {
  call_cid: string;
  type: "call.recording_started";
  user?: {
    id: string;
    name?: string;
  };
  created_at: string;
}

export interface StreamRecordingStoppedEvent {
  call_cid: string;
  type: "call.recording_stopped";
  created_at: string;
}

export interface StreamRecordingReadyEvent {
  call_cid: string;
  type: "call.recording_ready";
  call_recording: {
    filename: string;
    url: string;
    start_time: string;
    end_time: string;
  };
  created_at: string;
}

export interface StreamRecordingFailedEvent {
  call_cid: string;
  type: "call.recording_failed";
  error?: {
    message?: string;
    code?: string;
  };
  created_at: string;
}

/**
 * Handle call.recording_started event
 * Updates MeetingSession to mark recording as active
 */
export async function handleRecordingStarted(
  event: StreamRecordingStartedEvent,
): Promise<void> {
  const { call_cid, user, created_at } = event;

  // Extract call ID from call_cid (format: "default:callId")
  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.info("Recording started", {
    streamCallId,
    userId: user?.id,
    startedAt: created_at,
  });

  try {
    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
    });

    if (!meetingSession) {
      streamLogger.warn(
        "Meeting session not found for recording started event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to mark recording as active
    await prisma.meetingSession.update({
      where: { id: meetingSession.id },
      data: {
        isRecording: true,
        recordingStartedAt: new Date(created_at),
        recordingStartedBy: user?.id || null,
      },
    });

    streamLogger.info("Meeting session updated - recording started", {
      sessionId: meetingSession.id,
      streamCallId,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording started event", error, {
      streamCallId,
    });
    throw error;
  }
}

/**
 * Handle call.recording_stopped event
 * Updates MeetingSession to mark recording as stopped
 */
export async function handleRecordingStopped(
  event: StreamRecordingStoppedEvent,
): Promise<void> {
  const { call_cid } = event;

  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.info("Recording stopped", { streamCallId });

  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
    });

    if (!meetingSession) {
      streamLogger.warn(
        "Meeting session not found for recording stopped event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to mark recording as stopped
    await prisma.meetingSession.update({
      where: { id: meetingSession.id },
      data: {
        isRecording: false,
      },
    });

    streamLogger.info("Meeting session updated - recording stopped", {
      sessionId: meetingSession.id,
      streamCallId,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording stopped event", error, {
      streamCallId,
    });
    throw error;
  }
}

/**
 * Handle call.recording_ready event
 * Creates a Recording record in the database
 */
export async function handleRecordingReady(
  event: StreamRecordingReadyEvent,
): Promise<void> {
  const { call_cid, call_recording, created_at: _created_at } = event;

  const streamCallId = call_cid.split(":")[1] || call_cid;
  const { filename, url, start_time, end_time } = call_recording;

  streamLogger.info("Recording ready", {
    streamCallId,
    filename,
    url: url.substring(0, 50) + "...",
  });

  try {
    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            user: { select: { id: true } },
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
                webinar: {
                  include: {
                    webinarPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      include: {
                        consultantProfile: {
                          select: { user: { select: { name: true } } },
                        },
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
      streamLogger.warn("Meeting session not found for recording ready event", {
        streamCallId,
      });
      return;
    }

    // Calculate duration in minutes
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    const durationInMinutes = Math.round(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60),
    );

    const appointment = meetingSession.slotOfAppointment.appointment;
    const title = generateRecordingTitle(appointment, startDate);

    // Calculate Stream URL expiration (2 weeks from now)
    const streamUrlExpiresAt = new Date();
    streamUrlExpiresAt.setDate(streamUrlExpiresAt.getDate() + 14);

    // Check if recording already exists (idempotency)
    const existingRecording = await prisma.recording.findFirst({
      where: {
        meetingSessionId: meetingSession.id,
        streamRecordingId: filename,
      },
    });

    if (existingRecording) {
      streamLogger.info("Recording already exists, skipping creation", {
        recordingId: existingRecording.id,
        streamRecordingId: filename,
      });
      return;
    }

    // Create recording record. `organizationId` mirrors the parent
    // appointment's org tag so the org dashboard's recording library
    // can scope to "events I host" without joining through Appointment.
    const recording = await prisma.recording.create({
      data: {
        title,
        recordingUrl: url,
        durationInMinutes,
        recordedAt: startDate,
        streamRecordingId: filename,
        streamCallId,
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt,
        meetingSessionId: meetingSession.id,
        organizationId: appointment?.organizationId ?? null,
      },
    });

    // Also update the meeting session to stop recording state if still active
    if (meetingSession.isRecording) {
      await prisma.meetingSession.update({
        where: { id: meetingSession.id },
        data: { isRecording: false },
      });
    }

    streamLogger.info("Recording created successfully", {
      recordingId: recording.id,
      sessionId: meetingSession.id,
      title,
      durationInMinutes,
    });

    // #899 — permanent-policy recordings start transferring at ready-time
    // instead of waiting for the near-expiry window. The transfer is the heavy
    // Stream-S3-download + Supabase-upload, so it runs via `after()` (not a bare
    // `void`) — on serverless an unawaited promise is killed once the webhook
    // response returns, which would drop the kick; `after()` keeps it alive past
    // the response. The 6-hourly cron sweep still backstops any kick that dies
    // with the function.
    const storagePolicy =
      appointment?.webinar?.webinarPlan?.recordingStoragePolicy ??
      appointment?.class?.classPlan?.recordingStoragePolicy;
    if (storagePolicy === "PERMANENT") {
      after(() =>
        RecordingTransferService.queueRecordingTransfer(recording.id).catch(
          (err) =>
            streamLogger.error("Ready-time transfer kick threw", err, {
              recordingId: recording.id,
            }),
        ),
      );
    }

    // Build recipient list — for webinar/class, include all enrolled attendees
    // (the meeting session slot only has the consultant's allocation slot users)
    const slotUserIds = meetingSession.slotOfAppointment.user?.map(
      (u: { id: string }) => u.id,
    ) ?? [];
    const userIds = await getEventAttendeeIds(appointment, slotUserIds);

    if (userIds.length > 0) {
      let appointmentType = "consultation";
      let consultantName = "Unknown Consultant";

      if (appointment?.consultation) {
        appointmentType = "consultation";
        consultantName =
          appointment.consultation.consultationPlan?.consultantProfile?.user
            ?.name ?? "Unknown Consultant";
      } else if (appointment?.subscription) {
        appointmentType = "subscription";
        consultantName =
          appointment.subscription.subscriptionPlan?.consultantProfile?.user
            ?.name ?? "Unknown Consultant";
      } else if (appointment?.webinar) {
        appointmentType = "webinar";
        consultantName =
          appointment.webinar.webinarPlan?.consultantProfile?.user?.name ??
          "Unknown Consultant";
      } else if (appointment?.class) {
        appointmentType = "class";
        consultantName =
          appointment.class.classPlan?.consultantProfile?.user?.name ??
          "Unknown Consultant";
      }

      // Same serverless rationale as the transfer kick above: run the
      // notification via `after()` so it survives the webhook response.
      after(() =>
        notifyRecordingAvailable(userIds, {
          // ADR 20 still holds: `userIds` here is the participant list from
          // getEventAttendeeIds, never an org roster, so the recordingUrl below
          // does not reach an operator. The scope tag is attribution only — it
          // does not widen who receives this.
          ...notificationScope(appointment?.organizationId),
          appointmentType,
          consultantName,
          recordingUrl: url,
          dashboardUrl: notificationHref(
            appointment?.organizationId,
            "recordings",
          ),
        }).catch((err) =>
          streamLogger.error("Failed to send recording notification", err, {
            streamCallId,
          }),
        ),
      );
    }
  } catch (error) {
    streamLogger.error("Failed to handle recording ready event", error, {
      streamCallId,
      filename,
    });
    throw error;
  }
}

/**
 * Handle call.recording_failed event
 * Logs the error and optionally notifies the consultant
 */
export async function handleRecordingFailed(
  event: StreamRecordingFailedEvent,
): Promise<void> {
  const { call_cid, error: eventError } = event;

  const streamCallId = call_cid.split(":")[1] || call_cid;

  streamLogger.error(
    "Recording failed",
    new Error(eventError?.message || "Unknown error"),
    {
      streamCallId,
      errorCode: eventError?.code,
      errorMessage: eventError?.message,
    },
  );

  try {
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            user: { select: { id: true } },
            appointment: {
              include: {
                webinar: { select: { id: true } },
                class: { select: { id: true } },
              },
            },
          },
        },
      },
    });

    if (!meetingSession) {
      streamLogger.warn(
        "Meeting session not found for recording failed event",
        {
          streamCallId,
        },
      );
      return;
    }

    // Update meeting session to stop recording state
    await prisma.meetingSession.update({
      where: { id: meetingSession.id },
      data: {
        isRecording: false,
      },
    });

    // Create a failed recording record for tracking. Stamp the parent
    // appointment's `organizationId` so the failure shows up under the
    // host org's dashboard rather than orphaning under "personal".
    await prisma.recording.create({
      data: {
        title: "Recording Failed",
        recordingUrl: "",
        durationInMinutes: 0,
        recordedAt: new Date(),
        streamCallId,
        status: RecordingStatus.FAILED,
        meetingSessionId: meetingSession.id,
        organizationId:
          meetingSession.slotOfAppointment.appointment?.organizationId ?? null,
      },
    });

    // Build recipient list — for webinar/class, include all enrolled attendees
    const appointment = meetingSession.slotOfAppointment.appointment;
    const slotUserIds = meetingSession.slotOfAppointment.user.map((u) => u.id);
    const userIds = await getEventAttendeeIds(appointment, slotUserIds);

    const notificationResults = await Promise.allSettled(
      userIds.map((userId) =>
        notifyRecordingFailed(userId, {
          streamCallId,
          errorMessage: eventError?.message,
          dashboardUrl: `${getAppUrl()}/dashboard`,
        }),
      ),
    );

    const failures = notificationResults.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      streamLogger.warn(
        `${failures.length}/${userIds.length} recording-failed notifications failed`,
        { streamCallId },
      );
    }

    streamLogger.info("Meeting session updated - recording failed", {
      sessionId: meetingSession.id,
      streamCallId,
      notifiedUsers: userIds.length,
    });
  } catch (error) {
    streamLogger.error("Failed to handle recording failed event", error, {
      streamCallId,
    });
    throw error;
  }
}
