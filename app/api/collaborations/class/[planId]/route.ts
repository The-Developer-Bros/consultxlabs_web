import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  getCollaboratorsForUser,
  inviteCollaborator,
} from "@/lib/collaborators/service";
import { inviteClassCollaboratorSchema } from "@/schemas/collaborators";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId } = await params;
    const result = await getCollaboratorsForUser(
      "class",
      planId,
      session.user.id,
    );

    if (result.status === "not_found")
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    if (result.status === "forbidden")
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    return NextResponse.json({ data: result.data });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "collaborations" } });
    console.error("Error fetching class collaborators:", error);
    return NextResponse.json(
      { error: "Failed to fetch collaborators" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId } = await params;

    const plan = await prisma.classPlan.findUnique({
      where: { id: planId },
      include: { consultantProfile: true },
    });

    if (!plan?.consultantProfile) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    const ownerProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (plan.consultantProfileId !== ownerProfile?.id) {
      return NextResponse.json(
        { error: "Only the plan owner can invite collaborators" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const parsed = inviteClassCollaboratorSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => e.message).join(", ") },
        { status: 400 },
      );
    }

    const {
      consultantProfileId,
      role,
      revenueSharePercentage,
      canApprovePayment,
      canViewAnalytics,
      canEditEvent,
      canSeeAttendees,
    } = parsed.data;

    if (consultantProfileId === ownerProfile.id) {
      return NextResponse.json(
        { error: "You cannot invite yourself as a collaborator" },
        { status: 400 },
      );
    }

    const existingCollab = await prisma.collaborator.findFirst({
      where: {
        classPlanId: planId,
        consultantProfileId,
        status: { notIn: ["REMOVED", "DECLINED"] },
      },
    });
    if (existingCollab) {
      return NextResponse.json(
        {
          error:
            "This consultant already has an active or pending collaboration on this plan",
        },
        { status: 409 },
      );
    }

    const collab = await inviteCollaborator(
      "class",
      planId,
      consultantProfileId,
      role,
      revenueSharePercentage,
      ownerProfile.id,
      { canApprovePayment, canViewAnalytics, canEditEvent, canSeeAttendees },
    );

    if (!collab) {
      return NextResponse.json(
        {
          error:
            "Failed to invite. Revenue share may exceed limit (max 90% total for collaborators).",
        },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "collaborations" } });
    console.error("Error inviting class collaborator:", error);
    return NextResponse.json(
      { error: "Failed to invite collaborator" },
      { status: 500 },
    );
  }
}
