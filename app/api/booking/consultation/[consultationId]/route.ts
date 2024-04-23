import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: { consultationId: string } }
) {
  try {
    const { consultationId } = params;
    const consultation = await prisma.consultation.findFirstOrThrow({
      where: { consultationId: consultationId },
      include: {
        consultant: true,
        consultee: true,
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
    const { startTime, endTime, price, consultant, consultee } =
      await request.json();

    const consultation = await prisma.consultation.update({
      where: { consultationId: consultationId },
      data: {
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
      include: {
        consultant: true,
        consultee: true,
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
      where: { consultationId: consultationId },
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
