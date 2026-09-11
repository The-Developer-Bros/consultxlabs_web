import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { respondToInvitation } from "@/lib/collaborators/service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();
    const { response, planType } = body;

    if (!response || !["ACCEPTED", "DECLINED"].includes(response)) {
      return NextResponse.json(
        { error: "Response must be ACCEPTED or DECLINED" },
        { status: 400 },
      );
    }

    if (!planType || !["webinar", "class"].includes(planType)) {
      return NextResponse.json(
        { error: "planType must be webinar or class" },
        { status: 400 },
      );
    }

    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const collab = await respondToInvitation(
      planType,
      id,
      consultantProfile.id,
      response,
    );

    if (!collab) {
      return NextResponse.json(
        { error: "Unable to respond to invitation" },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "collaborations" } });
    console.error("Error responding to collaboration:", error);
    return NextResponse.json(
      { error: "Failed to respond to invitation" },
      { status: 500 },
    );
  }
}
