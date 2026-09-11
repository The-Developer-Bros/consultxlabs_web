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
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { subscriptionId } = await params;
    // Non-privileged users can only view participants for subscriptions they own as consultant
    const subscription = await prisma.subscription.findUnique({
      where: {
        id: subscriptionId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              subscriptionPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        subscriptionPlan: true,
        appointments: {
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

    if (!subscription) {
      return new NextResponse("Subscription not found", { status: 404 });
    }

    // For subscriptions, participants include the consultant and consultee
    const participants = [];

    // Add the consultee who requested the subscription
    if (subscription.requestedBy.user) {
      participants.push(subscription.requestedBy.user);
    }

    // Add any users from appointment slots (typically the consultant)
    const slotUsers =
      subscription.appointments?.flatMap(
        (appointment) =>
          appointment.slotsOfAppointment?.flatMap((slot) => slot.user || []) ||
          [],
      ) || [];

    // Get unique participants by user ID (avoid duplicates)
    const uniqueUsers = Array.from(
      new Map(
        [...participants, ...slotUsers].map((user) => [user.id, user]),
      ).values(),
    );

    return NextResponse.json({
      subscription,
      participants: uniqueUsers,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("[SUBSCRIPTION_PARTICIPANTS_GET]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  if (!isPrivileged(session.user.role) && !session.user.consultantProfileId) {
    return forbiddenResponse("Only consultants can remove participants");
  }

  try {
    const { subscriptionId } = await params;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new NextResponse("User ID is required", { status: 400 });
    }

    // Find the subscription
    // Non-privileged users can only modify subscriptions they own as consultant
    const subscription = await prisma.subscription.findUnique({
      where: {
        id: subscriptionId,
        ...(isPrivileged(session.user.role)
          ? {}
          : {
              subscriptionPlan: {
                consultantProfileId:
                  session.user.consultantProfileId ?? "__none__",
              },
            }),
      },
      include: {
        appointments: {
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

    if (!subscription) {
      return new NextResponse("Subscription not found", { status: 404 });
    }

    // Remove user from all slots in all appointments for this subscription
    for (const appointment of subscription.appointments) {
      for (const slot of appointment.slotsOfAppointment) {
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
    console.error("[SUBSCRIPTION_PARTICIPANT_DELETE]", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
