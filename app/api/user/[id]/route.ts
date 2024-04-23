import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;

    // Get user
    const user = await prisma.user.findUnique({ where: { id: id } });

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
