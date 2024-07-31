import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client"; // Import the DayOfWeek enum

export async function GET(req: NextRequest, { params }: { params: { consultantId: string } }) {
    try {
        const dateTime = req.nextUrl.searchParams.get("date") ?? null;

        // Filter slots only by the date and not time
        const date = dateTime ? dateTime.split("T")[0] : null;
        const formattedDate = date ? new Date(date) : null;

        // Fetch the consultant profile to determine the schedule type
        const consultantProfile = await prisma.consultantProfile.findUnique({
            where: { id: params.consultantId },
            select: { scheduleType: true },
        });

        if (!consultantProfile) {
            return NextResponse.json({ error: "Consultant not found" }, { status: 404 });
        }

        let slots;
        if (consultantProfile.scheduleType === 'WEEKLY') {
            // Map the numeric day to the DayOfWeek enum
            const dayOfWeekMap: { [key: number]: DayOfWeek } = {
                0: DayOfWeek.MONDAY,
                1: DayOfWeek.TUESDAY,
                2: DayOfWeek.WEDNESDAY,
                3: DayOfWeek.THURSDAY,
                4: DayOfWeek.FRIDAY,
                5: DayOfWeek.SATURDAY,
                6: DayOfWeek.SUNDAY,
            };
            const dayOfWeekEnum = formattedDate ? dayOfWeekMap[formattedDate.getDay()] : undefined;
            // Fetch weekly slots for the consultant
            slots = await prisma.slot.findMany({
                where: {
                    consultantProfileId: params.consultantId,
                    dayOfWeek: dayOfWeekEnum,
                },
                orderBy: {
                    timeTzStart: 'asc',
                },
            });
        } else if (consultantProfile.scheduleType === 'CUSTOM') {
            // Fetch custom slots for the consultant
            slots = await prisma.slot.findMany({
                where: {
                    consultantProfileId: params.consultantId,
                    date: formattedDate,
                },
                orderBy: {
                    timeTzStart: 'asc',
                },
            });
        } else {
            return NextResponse.json({ error: "Invalid schedule type" }, { status: 400 });
        }

        return NextResponse.json(slots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slots:", error);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}
