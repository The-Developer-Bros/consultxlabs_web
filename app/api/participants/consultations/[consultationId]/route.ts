import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

// Roster payload — never the full User row. The class/ and webinar/
// siblings were hardened this way in the #946 sweep; these two were
// missed and kept shipping phone, address, dateOfBirth, city and country
// on every roster poll.
const PARTICIPANT_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consultationId } = await params;
    // Non-privileged users can only view participants for consultations they own as consultant
    const consultation = await prisma.consultation.findUnique({
      where: {
        id: consultationId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              consultationPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        consultationPlan: true,
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: { select: PARTICIPANT_USER_SELECT },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: { select: PARTICIPANT_USER_SELECT },
          },
        },
      },
    });

    if (!consultation) {
      return new NextResponse("Consultation not found", { status: 404 });
    }

    // For consultations, participants include the consultant and consultee
    const participants = [];

    // Add the consultee who requested the consultation
    if (consultation.requestedBy.user) {
      participants.push(consultation.requestedBy.user);
    }

    // Add any users from appointment slots (typically the consultant)
    if (consultation.appointment) {
      const slotUsers =
        consultation.appointment.slotsOfAppointment?.flatMap(
          (slot) => slot.user || [],
        ) || [];

      // Get unique participants by user ID (avoid duplicates)
      const uniqueUsers = Array.from(
        new Map(
          [...participants, ...slotUsers].map((user) => [user.id, user]),
        ).values(),
      );

      return NextResponse.json({
        consultation,
        participants: uniqueUsers,
      });
    }

    return NextResponse.json({
      consultation,
      participants,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("[CONSULTATION_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  if (!isPrivileged(session.user.role) && !session.user.consultantProfileId) {
    return forbiddenResponse("Only consultants can remove participants");
  }

  try {
    const { consultationId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Find the consultation
    // Non-privileged users can only modify consultations they own as consultant
    const consultation = await prisma.consultation.findUnique({
      where: {
        id: consultationId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              consultationPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: { select: PARTICIPANT_USER_SELECT },
              },
            },
          },
        },
      },
    });

    if (!consultation) {
      return new NextResponse("Consultation not found", { status: 404 });
    }

    // Remove user from all slots in the appointment
    if (consultation.appointment) {
      for (const slot of consultation.appointment.slotsOfAppointment) {
        if (slot.user.some((user) => user.id === userId)) {
          await prisma.slotOfAppointment.update({
            where: { id: slot.id },
            data: {
              user: {
                disconnect: { id: userId },
              },
            },
          });
        }
      }
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("[CONSULTATION_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
