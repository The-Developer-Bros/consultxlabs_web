import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest, params: { consulteeProfileId: string }) {
    try {
        const slots = await prisma.slotRequest.findMany({
            where: {
                consulteeProfileId: params.consulteeProfileId,
            },
            include: {
                slotTiming: true,
            },
        });
        return NextResponse.json(slots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slot requests:", error);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}

export async function POST(req: NextRequest, params: { consulteeProfileId: string }) {
    try {
        const { slotTimingId } = await req.json();

        const slotRequest = await prisma.slotRequest.create({
            data: {
                consulteeProfileId: params.consulteeProfileId,
                slotTimingId,
            },
            include: {
                slotTiming: true,
            },
        });

        return NextResponse.json(slotRequest, { status: 200 });
    } catch (error) {
        console.error("Error creating slot request:", error);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}