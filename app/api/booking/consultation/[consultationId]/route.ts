import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }
    console.log(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const { startTime, endTime, price, consultantProfileId, consulteeProfileId } =
      await request.json();

    const consultation = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        price,
        consultantProfile: {
          connect: {
            id: consultantProfileId,
          },
        },
        consulteeProfile: {
          connect: {
            id: consulteeProfileId,
          },
        },
        slotOfAppointment: {
          update: {
            appointmentSlots: {
              updateMany: {
                where: {
                  slotId: consultationId, // Assuming you have a way to identify the slot
                },
                data: {
                  timeTzStart: startTime,
                  timeTzEnd: endTime,
                },
              },
            },
          },
        },
      },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;

    const consultation = await prisma.consultation.delete({
      where: { id: consultationId },
    });

    return NextResponse.json({ data: consultation }, { status: 200 });
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
