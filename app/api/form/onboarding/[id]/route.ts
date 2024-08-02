import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { ScheduleType } from "@prisma/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const body = await req.json();

    if (!id) {
      return NextResponse.json(
        { error: "User ID is required" },
        { status: 400 }
      );
    }

    // Check if the user exists
    const existingUser = await prisma.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let userProfileData: any = {};
    if (body.role === "CONSULTANT") {
      const {
        specialization,
        experience,
        location,
        domain,
        subDomains,
        scheduleType,
        weeklySlots,
        customSlots,
      } = body;

      const subDomainsArray =
        typeof subDomains === "string"
          ? subDomains.split(",").map((item) => item.trim())
          : subDomains;

      const scheduleTypeEnum = scheduleType.toUpperCase() as ScheduleType;

      userProfileData = {
        consultantProfile: {
          upsert: {
            create: {
              specialization,
              experience,
              location,
              domain,
              subDomains: subDomainsArray,
              scheduleType: scheduleTypeEnum,
              onlineStatus: true,
              rating: 0,
            },
            update: {
              specialization,
              experience,
              location,
              domain,
              subDomains: subDomainsArray,
              scheduleType: scheduleTypeEnum,
            },
          },
        },
      };

      if (
        scheduleTypeEnum === ScheduleType.WEEKLY ||
        scheduleTypeEnum === ScheduleType.CUSTOM
      ) {
        userProfileData.consultantProfile.upsert.create.slots = {
          create: createSlotsArray({
            scheduleType: scheduleTypeEnum,
            weeklySlots,
            customSlots,
          }),
        };
        userProfileData.consultantProfile.upsert.update.slots = {
          deleteMany: {},
          create: createSlotsArray({
            scheduleType: scheduleTypeEnum,
            weeklySlots,
            customSlots,
          }),
        };
      }
    } else if (body.role === "CONSULTEE") {
      // Handle CONSULTEE profile (unchanged)
    } else if (body.role === "STAFF") {
      // Handle STAFF profile if needed (unchanged)
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        name: body.name,
        email: body.email,
        phone: body.phone,
        address: body.address,
        role: body.role,
        onboardingCompleted: true,
        ...userProfileData,
      },
    });

    return NextResponse.json({ user }, { status: 200 });
  } catch (error) {
    console.error("Error during onboarding update:", error);
    return NextResponse.json(
      { error: "Failed to update onboarding information" },
      { status: 500 }
    );
  }
}

function createSlotsArray({
  scheduleType,
  weeklySlots,
  customSlots,
}: {
  scheduleType: ScheduleType;
  weeklySlots: any;
  customSlots: any;
}) {
  const slots = [];

  if (scheduleType === ScheduleType.WEEKLY && weeklySlots) {
    for (const [day, daySlots] of Object.entries(weeklySlots)) {
      for (const slot of daySlots as any) {
        slots.push({
          dayOfWeek: day.toUpperCase(),
          slotStartTimeInUTC: new Date(
            Date.UTC(1970, 0, 1, ...slot.startTime.split(":").map(Number))
          ).toISOString(),
          slotEndTimeInUTC: new Date(
            Date.UTC(1970, 0, 1, ...slot.endTime.split(":").map(Number))
          ).toISOString(),
          slotType: "WEEKLY",
        });
      }
    }
  }

  if (scheduleType === ScheduleType.CUSTOM && customSlots) {
    for (const [date, dateSlots] of Object.entries(customSlots)) {
      for (const slot of dateSlots as any) {
        const dateObj = new Date(date);
        const slotStartTimeInUTC = new Date(
          Date.UTC(
            dateObj.getUTCFullYear(),
            dateObj.getUTCMonth(),
            dateObj.getUTCDate(),
            ...slot.startTime.split(":").map(Number)
          )
        ).toISOString();

        const slotEndTimeInUTC = new Date(
          Date.UTC(
            dateObj.getUTCFullYear(),
            dateObj.getUTCMonth(),
            dateObj.getUTCDate(),
            ...slot.endTime.split(":").map(Number)
          )
        ).toISOString();

        slots.push({
          date: dateObj.toISOString(),
          slotStartTimeInUTC,
          slotEndTimeInUTC,
          slotType: "CUSTOM",
        });
      }
    }
  }

  return slots;
}
