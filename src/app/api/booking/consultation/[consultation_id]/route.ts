import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  params: { consultation_id: string }
) {
  try {
    const { consultation_id } = params;
    const consultation = await prisma.consultation.findFirstOrThrow({
      where: { consultation_id },
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
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
