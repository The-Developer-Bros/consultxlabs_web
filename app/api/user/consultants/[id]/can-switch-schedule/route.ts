import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { checkActiveAppointments } from "../../utils/consultant-appointments";

import { getSession } from "@/lib/auth-server";
/**
 * Check if a consultant can switch their schedule type.
 * Returns canSwitch: false if there are active/pending appointments.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: consultantId } = await params;

    // Verify the consultant exists
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: consultantId },
      select: { id: true, userId: true, scheduleType: true },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // Check for active appointments using shared utility
    const activeAppointments = await checkActiveAppointments(consultantId);

    if (activeAppointments.hasActive) {
      return NextResponse.json({
        canSwitch: false,
        reason: `Cannot switch schedule type while you have active appointments`,
        details: activeAppointments.details,
        breakdown: {
          ...activeAppointments.breakdown,
          total: activeAppointments.total,
        },
      });
    }

    return NextResponse.json({
      canSwitch: true,
      currentScheduleType: consultant.scheduleType,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "user" } });
    console.error("Error checking schedule switch eligibility:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
