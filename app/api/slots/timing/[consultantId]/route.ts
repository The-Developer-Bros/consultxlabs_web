import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest, params: { consultantId: string }) {
    try {

        // Date: 2024-07-29T18:30:00.000Z
        const dateTime = req.nextUrl.searchParams.get("date") ?? null;

        // Filter slots only by the date and not time
        const date = dateTime ? dateTime.split("T")[0] : null;
        const formattedDate = date ? new Date(date) : null;
        
        if (date) {
            const slots = await prisma.slotTiming.findMany({
                where: {
                    slotsOfAvailability: {
                        consultantProfileId: params.consultantId
                    },
                    dateInISO: formattedDate!
                }
            });
            return NextResponse.json(slots, { status: 200 });
        }else {
            const slots = await prisma.slotTiming.findMany({
                where: {
                    slotsOfAvailability: {
                        consultantProfileId: params.consultantId
                    }
                }
            });
            return NextResponse.json(slots, { status: 200 });
        }
    
    } catch (error) {
        console.error("Error fetching slots:", error);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}