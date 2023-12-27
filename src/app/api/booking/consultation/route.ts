import { v4 as uuidv4 } from "uuid";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

export async function POST(request: Request) {
  const {
    consultantId,
    consulteeId,
    start_time,
    end_time,
    price,
    consultant,
    consultee,
  } = await request.json();
  try {
    const consultation = await prisma.consultation.create({
      data: {
        consultation_id: uuidv4(),
        consultantId,
        consulteeId,
        start_time,
        end_time,
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

export async function GET(request: Request) {
  try {
    const consultations = await prisma.consultation.findMany({
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
