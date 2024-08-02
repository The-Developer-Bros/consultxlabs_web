import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  res: NextResponse,
  { params }: { params: { id: string } }
) {
  try {
    const slot = await prisma.slot.findUnique({
      where: { id: params.id },
      include: {
        slotRequests: true,
        consultantProfile: true,
      },
    });
    return NextResponse.json(slot, { status: 200 });
  } catch (error) {
    console.error("Error fetching slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, res: NextResponse) {
  try {
    const body = await req.json();

    const newSlot = await prisma.slot.create({
      data: {
        date: body.date,
        dayOfWeek: body.dayOfWeek,
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
        slotType: body.slotType,
        consultantProfileId: body.consultantProfileId,
        // Additional fields can be added here if needed
      },
    });

    return NextResponse.json(newSlot, { status: 201 });
  } catch (error) {
    console.error("Error creating slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  res: NextResponse,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const updatedSlot = await prisma.slot.update({
      where: { id: params.id },
      data: {
        date: body.date,
        dayOfWeek: body.dayOfWeek,
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
        slotType: body.slotType,
        consultantProfileId: body.consultantProfileId,
        // Replace all fields, even if some remain unchanged
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error updating slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  res: NextResponse,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const updatedSlot = await prisma.slot.update({
      where: { id: params.id },
      data: {
        date: body.date, // Update only if provided
        dayOfWeek: body.dayOfWeek, // Update only if provided
        slotStartTimeInUTC: body.slotStartTimeInUTC, // Update only if provided
        slotEndTimeInUTC: body.slotEndTimeInUTC, // Update only if provided
        slotType: body.slotType, // Update only if provided
        consultantProfileId: body.consultantProfileId, // Update only if provided
        // Add other fields as necessary
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error partially updating slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  res: NextResponse,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.slot.delete({
      where: { id: params.id },
    });

    return NextResponse.json(
      { message: "Slot deleted successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
