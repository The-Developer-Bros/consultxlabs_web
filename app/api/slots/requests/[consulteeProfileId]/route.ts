import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  params: { consulteeProfileId: string }
) {
  try {
    const slots = await prisma.slotRequest.findMany({
      where: {
        consulteeProfileId: params.consulteeProfileId,
      },
      include: {
        slot: true,
        appointment: true,
        consulteeProfile: true,
      },
    });
    return NextResponse.json(slots, { status: 200 });
  } catch (error) {
    console.error("Error fetching slot requests:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, res: NextResponse) {
  try {
    const body = await req.json();

    const newSlotRequest = await prisma.slotRequest.create({
      data: {
        status: body.status ?? "PENDING", // Default to PENDING if not provided
        consulteeProfileId: body.consulteeProfileId,
        slot: {
          connect: { id: body.slotId },
        },
        appointment: {
          connect: { id: body.appointmentId },
        },
        consulteeProfile: {
          connect: { id: body.consulteeProfileId },
        },
        // Additional fields can be added here if needed
      },
      include: {
        slot: true,
        appointment: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json(newSlotRequest, { status: 201 });
  } catch (error) {
    console.error("Error creating slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  res: NextResponse,
  params: { id: string }
) {
  try {
    const body = await req.json();

    const updatedSlotRequest = await prisma.slotRequest.update({
      where: { id: params.id },
      data: {
        status: body.status,
        consulteeProfileId: body.consulteeProfileId,
        slot: {
          connect: { id: body.slotId },
        },
        appointment: {
          connect: { id: body.appointmentId },
        },
        // Replace all fields
      },
      include: {
        slot: true,
        appointment: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json(updatedSlotRequest, { status: 200 });
  } catch (error) {
    console.error("Error updating slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  res: NextResponse,
  params: { id: string }
) {
  try {
    const body = await req.json();

    const updatedSlotRequest = await prisma.slotRequest.update({
      where: { id: params.id },
      data: {
        status: body.status,
        consulteeProfileId: body.consulteeProfileId,
        slot: body.slotId ? { connect: { id: body.slotId } } : undefined,
        appointment: body.appointmentId
          ? { connect: { id: body.appointmentId } }
          : undefined,
        // Update only provided fields
      },
      include: {
        slot: true,
        appointment: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json(updatedSlotRequest, { status: 200 });
  } catch (error) {
    console.error("Error partially updating slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  res: NextResponse,
  params: { id: string }
) {
  try {
    await prisma.slotRequest.delete({
      where: { id: params.id },
    });

    return NextResponse.json(
      { message: "Slot request deleted successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
