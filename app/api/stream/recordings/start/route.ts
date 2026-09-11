/**
 * Start Recording API Route
 * POST /api/stream/recordings/start
 *
 * Starts recording for a video call. Only consultants can start recordings.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  consentRegimeFor,
  getRecordingBlock,
} from "@/lib/stream/recording-consent";
import { RecordingConsentDecision } from "@prisma/client";
import { getMeetingSessionOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";

import { getSession } from "@/lib/auth-server";
const startRecordingSchema = z.object({
  meetingSessionId: z.string().min(1, "Meeting session ID is required"),
});

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Capability, not UserRole (#org-appts): owning a consultantProfile is what
    // matters (an org EXPERT counts); the per-appointment ownership check below
    // is the real authz.
    if (!session.user.consultantProfileId) {
      return NextResponse.json(
        { error: "Only consultants can start recordings" },
        { status: 403 },
      );
    }

    // Parse and validate request body
    const body = await req.json();
    const { meetingSessionId } = startRecordingSchema.parse(body);

    // Verify the meeting session exists and belongs to consultant's appointment
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
                        recordingEnabled: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                      },
                    },
                  },
                },
                // #1134 P1-6 — without these two the resolver sees no plan for a
                // 1:1, so the actual owner fails isAppointmentOwner and start
                // returns 403. Recording a consultation was not disabled, it was
                // impossible.
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
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
    const { isOwner, recordingEnabled } = getMeetingSessionOwnershipInfo(
      meetingSession,
      consultantProfile?.id,
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Not authorized to record this session" },
        { status: 403 },
      );
    }

    // Check if recording is enabled for this plan
    if (!recordingEnabled) {
      return NextResponse.json(
        { error: "Recording is not enabled for this plan" },
        { status: 400 },
      );
    }

    // #1134 P1-7 — consent gate, BEFORE the claim. A 1:1 participant who
    // declined in the lobby blocks recording outright; declining has to have an
    // effect or it is not consent. Group sessions are never blocked here — their
    // recording is the product, disclosed at purchase, and acknowledged rather
    // than consented to.
    const appointment = meetingSession.slotOfAppointment?.appointment;

    /** One shape for a refusal, used by the pre-claim gate and the race re-read. */
    const refuse = (reason: string | undefined) => {
      streamLogger.info("Recording refused — participant declined", {
        meetingSessionId,
      });
      return NextResponse.json({ error: reason }, { status: 409 });
    };

    const consentBlock = await getRecordingBlock(meetingSessionId, appointment);
    if (consentBlock.blocked) return refuse(consentBlock.reason);

    // Claim atomically, and re-assert the consent condition IN the claim.
    //
    // The `getRecordingBlock` call above is a separate read, so a participant
    // could commit a DECLINED decision in the window between that count and this
    // write, and recording would start despite a refusal that was already in the
    // database. Check-then-act, with a compliance record as the loser.
    //
    // The relation filter closes it without a transaction: Postgres evaluates the
    // whole predicate at write time, so a decline that commits first makes this
    // match zero rows. The earlier read stays because it produces the specific
    // user-facing reason; this is the part that has to be true.
    const blockOnDecline = consentRegimeFor(appointment) === "OPT_OUT";
    const updated = await prisma.meetingSession.updateMany({
      where: {
        id: meetingSessionId,
        isRecording: false,
        ...(blockOnDecline
          ? {
              recordingConsents: {
                none: { decision: RecordingConsentDecision.DECLINED },
              },
            }
          : {}),
      },
      data: {
        isRecording: true,
        recordingStartedAt: new Date(),
        recordingStartedBy: session.user.id,
      },
    });

    if (updated.count === 0) {
      // Either a concurrent start won, or a decline landed between the read and
      // this write. Re-read to say which, so a refused host is not told the
      // wrong thing.
      const raced = await getRecordingBlock(meetingSessionId, appointment);
      if (raced.blocked) return refuse(raced.reason);
      return NextResponse.json(
        { error: "Recording is already in progress" },
        { status: 409 },
      );
    }

    // Start recording via Stream API (use DB-stored call ID, never trust client)
    const result = await RecordingService.startRecording(
      meetingSession.streamCallId,
      session.user.id,
    );

    if (!result.success) {
      // Revert the DB state since Stream API failed
      await prisma.meetingSession.update({
        where: { id: meetingSessionId },
        data: { isRecording: false, recordingStartedAt: null, recordingStartedBy: null },
      });
      return NextResponse.json(
        { error: result.error || "Failed to start recording" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: "Recording started",
    });
  } catch (error) {
    streamLogger.error("Error starting recording", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request", details: error.errors },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Failed to start recording" },
      { status: 500 },
    );
  }
}
