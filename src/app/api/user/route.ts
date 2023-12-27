import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { v4 as uuidv4 } from "uuid";
import { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  try {
    const users = await prisma.user.findMany();
    return NextResponse.json({ data: users }, { status: 200 });
  } catch (error) {
    console.error("Error getting user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const {
      username,
      email,
      password,
      oauthToken,
      phoneNumber,
      emailConfirmed,
    } = await req.json();

    const createdUser = await prisma.user.create({
      data: {
        id: uuidv4(),
        username,
        email,
        password,
        oauthToken,
        phoneNumber,
        emailConfirmed,
        consultantProfile: {
          create: {
            id: uuidv4(),
          },
        },
        consulteeProfile: {
          create: {
            id: uuidv4(),
          },
        },
      },
    });

    return NextResponse.json({ data: createdUser }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "User already exists" },
        { status: 409 }
      );
    }
    console.error("Error Creating User:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const {
      id,
      username,

      email,
      password,
      oauthToken,
      phoneNumber,
      emailConfirmed,
    } = await req.json();

    const updatedUser = await prisma.user.update({
      where: {
        id: id as string,
      },
      data: {
        username,
        email,
        password,
        oauthToken,
        phoneNumber,
        emailConfirmed,
      },
    });

    return NextResponse.json({ data: updatedUser }, { status: 200 });
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json(
      { error: "Error Interbal Server Error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();

    const deletedUser = await prisma.user.delete({
      where: {
        id: id as string,
      },
    });

    if (!deletedUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ data: deletedUser }, { status: 200 });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
