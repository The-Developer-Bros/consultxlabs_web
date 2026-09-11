import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

/**
 * GET /api/collaborators/[consultantProfileId]/availability?date=YYYY-MM-DD
 * Returns a co-host's availability and booking status for a given date.
 * Used by the scheduling calendar to show availability overlay.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ consultantProfileId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultantProfileId } = await params;

    // Only the owner, accepted collaborators on a shared plan, or admin/staff may view
    if (!isPrivileged(session.user.role)) {
      const isOwner = session.user.consultantProfileId === consultantProfileId;
      if (!isOwner) {
        // #784 — merged Collaborator model covers both plan types in one lookup
        const collab = await prisma.collaborator.findFirst({
          where: {
            consultantProfileId: session.user.consultantProfileId ?? "__none__",
            status: "ACCEPTED",
            OR: [
              { webinarPlan: { consultantProfileId } },
              { classPlan: { consultantProfileId } },
            ],
          },
        });
        if (!collab) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
    }

    const date = req.nextUrl.searchParams.get("date");

    if (!date) {
      return NextResponse.json(
        { error: "date query parameter is required" },
        { status: 400 },
      );
    }

    const profile = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfileId },
      select: { id: true, scheduleType: true },
    });

    if (!profile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const targetDate = new Date(date);
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    // Fetch weekly availability slots
    const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
      where: { consultantProfileId },
      select: {
        startDay: true,
        startTimeUtc: true,
        endDay: true,
        endTimeUtc: true,
      },
    });

    // Fetch custom availability slots for the date range (overlap semantics)
    const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
      where: {
        consultantProfileId,
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
      select: {
        startsAt: true,
        endsAt: true,
      },
    });

    // Fetch booked slots for the date — overlap semantics, includes collaborated events
    const bookedSlots = await prisma.slotOfAppointment.findMany({
      where: {
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
        isTentative: false,
        appointment: {
          OR: [
            {
              consultation: {
                consultationPlan: { consultantProfileId },
              },
            },
            {
              subscription: {
                subscriptionPlan: { consultantProfileId },
              },
            },
            {
              webinar: {
                webinarPlan: { consultantProfileId },
              },
            },
            {
              class: {
                classPlan: { consultantProfileId },
              },
            },
            // Collaborated commitments: events owned by others but accepted by this consultant
            {
              webinar: {
                webinarPlan: {
                  collaborators: {
                    some: { consultantProfileId, status: "ACCEPTED" },
                  },
                },
              },
            },
            {
              class: {
                classPlan: {
                  collaborators: {
                    some: { consultantProfileId, status: "ACCEPTED" },
                  },
                },
              },
            },
          ],
        },
      },
      select: {
        startsAt: true,
        endsAt: true,
      },
    });

    return NextResponse.json({
      data: {
        consultantProfileId,
        scheduleType: profile.scheduleType,
        date,
        weeklySlots,
        customSlots,
        bookedSlots,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "collaborators" } });
    console.error("Error fetching collaborator availability:", error);
    return NextResponse.json(
      { error: "Failed to fetch availability" },
      { status: 500 },
    );
  }
}
