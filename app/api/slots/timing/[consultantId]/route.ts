import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest, { params }: { params: { consultantId: string } }) {
    try {
        const dateTime = req.nextUrl.searchParams.get("date") ?? null;

        // Filter slots only by the date and not time
        const date = dateTime ? dateTime.split("T")[0] : null;
        const formattedDate = date ? new Date(date) : null;

        let whereClause: any = {
            OR: [
                {
                    slotsOfAvailabilityWeekly: {
                        consultantProfileId: params.consultantId
                    }
                },
                {
                    slotsOfAvailabilityCustom: {
                        consultantProfileId: params.consultantId
                    },
                }
            ]
        };

        if (formattedDate) {
            whereClause.dateInISO = formattedDate;
        }

        const slots = await prisma.slotTiming.findMany({
            where: whereClause
        });

        return NextResponse.json(slots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slots:", error);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}
