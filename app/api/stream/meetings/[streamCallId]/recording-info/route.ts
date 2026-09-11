/**
 * Meeting Recording Info API Route
 * GET /api/stream/meetings/[streamCallId]/recording-info
 *
 * Gets recording information for a meeting session.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isPaymentEntitled } from "@/lib/payments/utils/refund-balance";
import { isRecordingEnabledForAppointment } from "@/lib/stream/recording-utils";
import {
  auditOperatorRecordingAccess,
  resolveOperatorRecordingAccess,
} from "@/lib/stream/recording-operator-access";

import { getSession } from "@/lib/auth-server";
import * as Sentry from "@sentry/nextjs";
type RouteParams = {
  params: Promise<{
    streamCallId: string;
  }>;
};

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    // Check authentication
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { streamCallId } = await params;

    // Find meeting session by streamCallId
    const meetingSession = await prisma.meetingSession.findUnique({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            user: { select: { id: true } },
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        recordingEnabled: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        recordingEnabled: true,
                        consultantProfileId: true,
                      },
                    },
                  },
                },
                consultation: {
                  include: {
                    consultationPlan: {
                      // #1134 P1-6 — recordingEnabled is new on the 1:1 plans;
                      // without selecting it the resolver reports recording as
                      // unavailable for every consultation.
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                      },
                    },
                    requestedBy: {
                      select: { userId: true },
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
                    requestedBy: {
                      select: { userId: true },
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

    const appointment = meetingSession.slotOfAppointment?.appointment;

    // Authorization check - verify user has access to this meeting
    const consultantProfileId =
      appointment?.webinar?.webinarPlan?.consultantProfileId ||
      appointment?.class?.classPlan?.consultantProfileId ||
      appointment?.consultation?.consultationPlan?.consultantProfileId ||
      appointment?.subscription?.subscriptionPlan?.consultantProfileId;

    // Capability, not UserRole (#org-appts): an org EXPERT whose top-level role is CONSULTEE still owns recordings they delivered.
    // Access is granted if ANY independent path passes; each path is an
    // ownership/participation check, never a role gate.
    let hasAccess = false;
    // True when only the platform role let this caller through — drives the
    // audit write below.
    let viaOperatorGrant = false;

    // Participant on the meeting slot (either side).
    if (!hasAccess) {
      const slotUserIds =
        meetingSession.slotOfAppointment?.user?.map(
          (u: { id: string }) => u.id,
        ) ?? [];
      hasAccess = slotUserIds.includes(session.user.id);
    }

    // Provider path: owns the consultant profile that delivered the session.
    if (
      !hasAccess &&
      session.user.consultantProfileId &&
      session.user.consultantProfileId === consultantProfileId
    ) {
      hasAccess = true;
    }

    // Attendee path: the requestedBy user for consultation/subscription.
    if (!hasAccess) {
      const consulteeUserId =
        appointment?.consultation?.requestedBy?.userId ||
        appointment?.subscription?.requestedBy?.userId;
      hasAccess = consulteeUserId === session.user.id;
    }

    // Attendee path: paid enrollment for webinars/classes.
    if (!hasAccess) {
      const webinarId = appointment?.webinar?.id;
      const classId = appointment?.class?.id;

      if (webinarId || classId) {
        const enrollmentConditions = [];
        if (webinarId) {
          enrollmentConditions.push({ webinarId });
        }
        if (classId) {
          enrollmentConditions.push({ classId });
        }

        const enrollments = await prisma.payment.findMany({
          where: {
            userId: session.user.id,
            paymentStatus: "SUCCEEDED",
            appointment: {
              OR: enrollmentConditions,
            },
          },
          select: {
            amount: true,
            refunds: { select: { amountPaise: true, status: true } },
          },
        });

        // #689 — a fully-refunded enrollment is no longer access.
        hasAccess = enrollments.some(isPaymentEntitled);
      }
    }

    // #1270 — the operator grant, resolved through BACKOFFICE_PERMISSIONS
    // rather than a bare `isPrivileged` so it is visible in the file that is
    // supposed to enumerate every back-office grant. Last, so an ADMIN or
    // STAFF member who is genuinely on this appointment is audited as a
    // participant (i.e. not at all) rather than as an operator reaching in.
    //
    // `recordings.read` is the whole grant needed here: this endpoint returns
    // recording STATE — enabled, running, who started it — and never a URL, so
    // there is nothing for `recordings.play` to gate.
    const operator = resolveOperatorRecordingAccess(session.user.role);
    if (!hasAccess && operator.canRead) {
      hasAccess = true;
      viaOperatorGrant = true;
    }

    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (viaOperatorGrant) {
      await auditOperatorRecordingAccess({
        actorUserId: session.user.id,
        actorRole: String(session.user.role),
        surface: "GET /api/stream/meetings/[streamCallId]/recording-info",
        // No URL is ever returned by this endpoint.
        played: false,
        meetingSessionId: meetingSession.id,
        streamCallId: meetingSession.streamCallId,
        organizationId: meetingSession.organizationId ?? null,
      });
    }

    // #1134 P1-6 — one resolver for all four plan kinds. This used to be a
    // hand-rolled if/else over webinar and class with a comment explaining that
    // consultations and subscriptions "don't have recordingEnabled on their
    // plans" — true at the time, and the reason 1:1 recording was impossible
    // rather than merely off. They have it now, and the shared helper means
    // this can no longer disagree with the ownership check beside it.
    const recordingEnabled = isRecordingEnabledForAppointment(appointment);

    return NextResponse.json({
      meetingSessionId: meetingSession.id,
      recordingEnabled,
      isRecording: meetingSession.isRecording,
      recordingStartedAt: meetingSession.recordingStartedAt,
      recordingStartedBy: meetingSession.recordingStartedBy,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "stream" } });
    console.error("Error getting meeting recording info:", error);
    return NextResponse.json(
      { error: "Failed to get recording info" },
      { status: 500 },
    );
  }
}
