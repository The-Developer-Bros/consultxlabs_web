import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await prisma.consulteeProfile.findMany();

    NextResponse.json({ data: user }, { status: 200 });
  } catch (error) {
    console.error("Error getting user:", error);
    NextResponse.error();
  }
}

export async function POST(req: Request) {
  try {
    const { id, userId } = await req.json();

    const createdUser = await prisma.consulteeProfile.create({
      data: {
        id,
        userId,
      },
    });

    NextResponse.json(createdUser);
  } catch (error) {
    console.error("Error creating user:", error);
    NextResponse.error();
  }
}

export async function PUT(req: Request) {
  try {
    const { id, userId } = await req.json();

    const updatedUser = await prisma.consulteeProfile.update({
      where: {
        id,
      },
      data: {
        userId,
      },
    });

    NextResponse.json(updatedUser);
  } catch (error) {
    console.error("Error updating user:", error);
    NextResponse.error();
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();

    const deletedUser = await prisma.consulteeProfile.delete({
      where: {
        id,
      },
    });

    NextResponse.json(deletedUser);
  } catch (error) {
    console.error("Error deleting user:", error);
    NextResponse.error();
  }
}
