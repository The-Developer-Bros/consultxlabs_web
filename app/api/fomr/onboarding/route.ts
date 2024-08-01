import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest, res: NextResponse) {
  try {
    const body = await req.json();

    let userProfileData: any = {};
    if (body.role === "CONSULTANT") {
      const consultantData = body.consultantProfile;
      userProfileData = {
        consultantProfile: {
          create: consultantData,
        },
      };
    } else if (body.role === "CONSULTEE") {
      const consulteeData = body.consulteeProfile;
      userProfileData = {
        consulteeProfile: {
          create: consulteeData,
        },
      };
    } else if (body.role === "STAFF") {
      const staffData = body.staffProfile;
      userProfileData = {
        staffProfile: {
          create: staffData,
        },
      };
    }

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        phone: body.phone,
        address: body.address,
        role: body.role,
        ...userProfileData,
      },
    });

    return NextResponse.json({ user }, { status: 200 });
  } catch (error) {
    console.error("Error during onboarding:", error);
    return NextResponse.json(
      { error: "Failed to complete onboarding" },
      { status: 500 }
    );
  }
}
