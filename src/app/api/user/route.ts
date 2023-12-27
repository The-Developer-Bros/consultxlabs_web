import { NextResponse } from "next/server";
import prisma from "../../../lib/prisma";
import { v4 as uuidv4 } from "uuid";
import { Prisma } from "@prisma/client";
export async function POST(req: Request) {
  try {
    const {
      username,
      emailEncrypted,
      emailIv,
      password,
      oauthToken,
      phone_number,
      isMod,
      isAdmin,
      emailConfirmed,
    } = await req.json();

    // Create user
    const createdUser = await prisma.user.create({
      data: {
        id: uuidv4(),
        username,
        emailEncrypted,
        emailIv,
        password,
        oauthToken,
        phone_number,
        isMod,
        isAdmin,
        emailConfirmed,
        profile: {
          create: {
            consultant: {
              create: {
                id: uuidv4(),
              },
            },
            consultee: {
              create: {
                id: uuidv4(),
              },
            },
          },
        },
      },
    });

    // Return the created user
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
export async function GET(req: Request) {
  try {
    const { id } = await req.json();

    // Get user
    const user = await prisma.user.findUnique({
      where: {
        id: id as string,
      },
    });

    // Check if user exists
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Return the user
    return NextResponse.json({ data: user }, { status: 200 });
  } catch (error) {
    console.error("Error getting user:", error);
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
      emailEncrypted,
      emailIv,
      password,
      oauthToken,
      phone_number,
      isMod,
      isAdmin,
      emailConfirmed,
    } = await req.json();

    // Update user
    const updatedUser = await prisma.user.update({
      where: {
        id: id as string,
      },
      data: {
        username,
        emailEncrypted,
        emailIv,
        password,
        oauthToken,
        phone_number,
        isMod,
        isAdmin,
        emailConfirmed,
      },
    });

    // Return the updated user
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

    // Delete user
    const deletedUser = await prisma.user.delete({
      where: {
        id: id as string,
      },
    });

    if (!deletedUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Return the deleted user
    return NextResponse.json({ data: deletedUser }, { status: 200 });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
