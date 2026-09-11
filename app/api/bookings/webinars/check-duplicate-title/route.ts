import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const title = searchParams.get("title");
    const consultantProfileId = searchParams.get("consultantProfileId");
    const excludeId = searchParams.get("excludeId") || "";

    if (!title || !consultantProfileId) {
      return NextResponse.json(
        { error: "Missing required parameters: title and consultantProfileId" },
        { status: 400 },
      );
    }

    const normalizedTitle = title.trim().toLowerCase();

    // Check webinar plans
    const existingWebinar = await prisma.webinarPlan.findFirst({
      where: {
        title: {
          mode: "insensitive",
          equals: normalizedTitle,
        },
        consultantProfileId: consultantProfileId,
        id: {
          not: excludeId || undefined,
        },
      },
    });

    return NextResponse.json(
      { isDuplicate: !!existingWebinar },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error checking duplicate webinar title:", error);
    return NextResponse.json(
      {
        error: "An error occurred while checking for duplicate webinar titles",
      },
      { status: 500 },
    );
  }
}
