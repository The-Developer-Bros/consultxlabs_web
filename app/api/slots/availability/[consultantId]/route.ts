import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client"; // Import the DayOfWeek enum

export async function GET(
  req: NextRequest,
  { params }: { params: { consultantId: string } }
) {
  try {
    const dateOnly = req.nextUrl.searchParams.get("date") ?? null;
    const userTimeZone = req.nextUrl.searchParams.get("timeZone") ?? "UTC";

    if (!params.consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 }
      );
    }

    if (!dateOnly) {
      return NextResponse.json({ error: "Date is required" }, { status: 400 });
    }

    const formattedDate = new Date(dateOnly);

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: params.consultantId },
      select: { scheduleType: true },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 }
      );
    }

    let slots;
    if (consultantProfile.scheduleType === "WEEKLY") {
      // Map the numeric day to the DayOfWeek enum
      const dayOfWeekMap: { [key: number]: DayOfWeek } = {
        0: DayOfWeek.MONDAY,
        1: DayOfWeek.TUESDAY,
        2: DayOfWeek.WEDNESDAY,
        3: DayOfWeek.THURSDAY,
        4: DayOfWeek.FRIDAY,
        5: DayOfWeek.SATURDAY,
        6: DayOfWeek.SUNDAY,
      };
      const dayOfWeekEnum = formattedDate
        ? dayOfWeekMap[formattedDate.getDay()]
        : undefined;
      // Fetch weekly slots for the consultant
      slots = await prisma.slot.findMany({
        where: {
          consultantProfileId: params.consultantId,
          dayOfWeek: dayOfWeekEnum,
        },
        orderBy: {
          slotStartTimeInUTC: "asc",
        },
      });
    } else if (consultantProfile.scheduleType === "CUSTOM") {
      // Fetch custom slots for the consultant
      slots = await prisma.slot.findMany({
        where: {
          consultantProfileId: params.consultantId,
          date: formattedDate,
        },
        orderBy: {
          slotStartTimeInUTC: "asc",
        },
      });
    } else {
      return NextResponse.json(
        { error: "Invalid schedule type" },
        { status: 400 }
      );
    }

    if (userTimeZone === "UTC") {
      return NextResponse.json(slots, { status: 200 });
    }

    const userSlots = convertSlotsToUserTimezone(slots, userTimeZone);
    return NextResponse.json(userSlots, { status: 200 });
  } catch (error) {
    console.error("Error fetching slots:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

// Emergency function to convert date and time to user's timezone
function convertToUserTimezone(dateString: string, timeZone: string) {
  return new Date(dateString).toLocaleString("en-US", { timeZone });
}

function convertSlotsToUserTimezone(slots: any[], userTimeZone: string) {
  return slots.map((slot) => {
    return {
      ...slot,
      date: convertToUserTimezone(slot.date, userTimeZone),
      timeTzStart: convertToUserTimezone(slot.timeTzStart, userTimeZone),
      timeTzEnd: convertToUserTimezone(slot.timeTzEnd, userTimeZone),
    };
  });
}
