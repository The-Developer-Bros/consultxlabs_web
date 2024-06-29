import { v4 as uuidv4 } from "uuid";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

export async function GET(request: Request) {
  try {
    const { consultationId, consultantProfileId, consulteeProfileId } = await request.json();

    let where: any = {};

    if (consultationId) {
      where.id = consultationId;
    } else if (consultantProfileId && consulteeProfileId) {
      where = { consultantProfileId, consulteeProfileId };
    }

    const consultations = await prisma.consultation.findMany({
      where,
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json({ data: consultations }, { status: 200 });
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const {
      consultantProfileId,
      consulteeProfileId,
      price,
      slotTiming,
    } = await request.json();

    const consultation = await prisma.consultation.create({
      data: {
        id: uuidv4(),
        consultantProfileId,
        consulteeProfileId,
        price,
        slotOfAppointment: {
          create: {
            appointmentSlots: {
              create: slotTiming,
            },
          },
        },
      },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json({ data: consultation }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json(
        { error: "Consultation already exists" },
        { status: 409 }
      );
    }
    console.log(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const {
      consultationId,
      consultantProfileId,
      consulteeProfileId,
      price,
      slotTiming,
    } = await request.json();

    const updatedConsultation = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        consultantProfileId,
        consulteeProfileId,
        price,
        slotOfAppointment: {
          update: {
            appointmentSlots: {
              update: slotTiming,
            },
          },
        },
      },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    return NextResponse.json({ data: updatedConsultation }, { status: 200 });
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { consultationId } = await request.json();

    const deletedConsultation = await prisma.consultation.delete({
      where: { id: consultationId },
    });

    return NextResponse.json({ data: deletedConsultation }, { status: 200 });
  } catch (error) {
    console.log(error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
