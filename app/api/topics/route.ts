import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const withProgramCount = searchParams.get("withProgramCount") === "true";
    const planType = searchParams.get("planType") || "all";

    if (withProgramCount) {
      // All four plan types count as "programs" on a topic. Consultation and
      // subscription plans were silently excluded, so topics only carried by
      // 1:1 offerings reported zero and were filtered out entirely.
      const topics = await prisma.topic.findMany({
        include: {
          _count: {
            select: {
              ...(planType === "all" || planType === "class"
                ? { classPlans: true }
                : {}),
              ...(planType === "all" || planType === "webinar"
                ? { webinarPlans: true }
                : {}),
              ...(planType === "all" || planType === "consultation"
                ? { consultationPlans: true }
                : {}),
              ...(planType === "all" || planType === "subscription"
                ? { subscriptionPlans: true }
                : {}),
            },
          },
        },
        orderBy: { name: "asc" },
      });

      const topicsWithCount = topics
        .map((topic) => {
          const count = topic._count;
          let programCount = 0;
          if (planType === "class") {
            programCount = count.classPlans ?? 0;
          } else if (planType === "webinar") {
            programCount = count.webinarPlans ?? 0;
          } else if (planType === "consultation") {
            programCount = count.consultationPlans ?? 0;
          } else if (planType === "subscription") {
            programCount = count.subscriptionPlans ?? 0;
          } else {
            programCount =
              (count.classPlans ?? 0) +
              (count.webinarPlans ?? 0) +
              (count.consultationPlans ?? 0) +
              (count.subscriptionPlans ?? 0);
          }
          return {
            id: topic.id,
            name: topic.name,
            programCount,
          };
        })
        .filter((t) => t.programCount > 0)
        .sort((a, b) => b.programCount - a.programCount);

      return NextResponse.json({ data: topicsWithCount }, { status: 200 });
    }

    const topics = await prisma.topic.findMany({
      orderBy: { name: "asc" },
    });

    return NextResponse.json({ data: topics }, { status: 200 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "topics" } });
    console.error("Error fetching topics:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching topics" },
      { status: 500 },
    );
  }
}
