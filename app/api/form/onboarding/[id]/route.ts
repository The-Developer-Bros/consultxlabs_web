import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const id = params.id;
    const body = await req.json();

    console.log("Received id:", id);
    console.log("Received body:", body);

    if (!id) {
      return NextResponse.json(
        { error: "User ID is required" },
        { status: 400 }
      );
    }

    let userProfileData: any = {};
    if (body.role === "CONSULTANT") {
      userProfileData = {
        consultantProfile: {
          upsert: {
            create: body.consultantProfile,
            update: body.consultantProfile,
          },
        },
      };
    } else if (body.role === "CONSULTEE") {
      userProfileData = {
        consulteeProfile: {
          upsert: {
            create: body.consulteeProfile,
            update: body.consulteeProfile,
          },
        },
      };
    } else if (body.role === "STAFF") {
      userProfileData = {
        staffProfile: {
          upsert: {
            create: body.staffProfile,
            update: body.staffProfile,
          },
        },
      };
    }

    // Handle slots for CONSULTANT
    if (body.role === "CONSULTANT" && body.consultantProfile) {
      userProfileData.consultantProfile.upsert.create.slots = {
        create: createSlotsArray(body.consultantProfile),
      };
      userProfileData.consultantProfile.upsert.update.slots = {
        deleteMany: {},
        create: createSlotsArray(body.consultantProfile),
      };
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

function createSlotsArray(consultantProfile: any) {
  const slots = [];

  if (consultantProfile.scheduleType === "weekly") {
    for (const [day, daySlots] of Object.entries(
      consultantProfile.weeklySlots
    )) {
      for (const slot of daySlots as any) {
        slots.push({
          dayOfWeek: day.toUpperCase(),
          timeTzStart: slot.startTime,
          timeTzEnd: slot.endTime,
          slotType: "WEEKLY",
        });
      }
    }
  }

  if (consultantProfile.customSlots) {
    for (const [date, dateSlots] of Object.entries(
      consultantProfile.customSlots
    )) {
      for (const slot of dateSlots as any) {
        slots.push({
          date: new Date(date),
          timeTzStart: slot.startTime,
          timeTzEnd: slot.endTime,
          slotType: "CUSTOM",
        });
      }
    }
  }

  return slots;
}
