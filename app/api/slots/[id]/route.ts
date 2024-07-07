
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function PATCH(
    request: NextRequest,
    { params }: { params: { id: string } }
) {
    try {
        const { id } = params;
        const { status } = await request.json();

        const updatedRequest = await prisma.slotRequest.update({
            where: { id },
            data: { status },
        });
        return NextResponse.json(updatedRequest, { status: 200 });
    }
    catch (error) {
        console.error("Error updating slot request:", error);
        return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
    }
}