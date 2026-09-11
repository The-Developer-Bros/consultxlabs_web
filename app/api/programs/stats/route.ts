import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const [classCount, webinarCount] = await Promise.all([
      prisma.classPlan.count(),
      prisma.webinarPlan.count(),
    ]);

    return NextResponse.json({
      data: {
        classCount,
        webinarCount,
        totalPrograms: classCount + webinarCount,
      },
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "programs" } });
    console.error("Error fetching program stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch program stats" },
      { status: 500 },
    );
  }
}
