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
