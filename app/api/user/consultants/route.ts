import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest, res: NextResponse) {
    try {
        const consultants = await prisma.consultantProfile.findMany();
        return NextResponse.json({ data: consultants }, { status: 200 });
    }
    catch (error) {
        console.error("Error getting consultants:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
