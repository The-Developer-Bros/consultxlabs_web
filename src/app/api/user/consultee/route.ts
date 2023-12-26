import { NextResponse } from "next/server";
import prisma from "../../../../lib/prisma";
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

    // Return the created user
    NextResponse.json(createdUser);
  } catch (error) {
    console.error("Error creating user:", error);
    NextResponse.error();
  }
}
