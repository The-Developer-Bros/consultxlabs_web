import { v4 as uuidv4 } from "uuid";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

export async function GET(request: Request) {
  try {
    const { consultationId, consultantId, consulteeId } = await request.json();

    let where: any = {};

    if (consultationId) {
      where = { consultationId };
    } else if (consultantId && consulteeId) {
      where = { consultantId, consulteeId };
    } else {
      where = {};
    }

    const consultations = await prisma.consultation.findMany({
      where,
      include: {
        consultant: true,
        consultee: true,
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
  const {
    consultantId,
    consulteeId,
    startTime,
    endTime,
    price,
    consultant,
    consultee,
  } = await request.json();
  try {
    const consultation = await prisma.consultation.create({
      data: {
        consultationId: uuidv4(),
        consultantId,
        consulteeId,
        startTime,
        endTime,
        price,
        consultant: {
          connect: {
            id: consultant.id,
          },
        },
        consultee: {
          connect: { id: consultee.id },
        },
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
      consultantId,
      consulteeId,
      startTime,
      endTime,
      price,
    } = await request.json();

    const updatedConsultation = await prisma.consultation.update({
      where: { consultationId },
      data: {
        consultantId,
        consulteeId,
        startTime,
        endTime,
        price,
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
      where: { consultationId },
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
