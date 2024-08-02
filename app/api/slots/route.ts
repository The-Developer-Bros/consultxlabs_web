import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest, res: NextResponse) {
  try {
    const slots = await prisma.slot.findMany({
      include: {
        slotRequests: true,
        consultantProfile: true,
      },
    });
    return NextResponse.json(slots, { status: 200 });
  } catch (error) {
    console.error("Error fetching slots:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

