import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  CollaboratorNotFoundError,
  CollaboratorTermsLockedError,
  updateCollaborator,
  removeCollaborator,
} from "@/lib/collaborators/service";
import { updateClassCollaboratorSchema } from "@/schemas/collaborators";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string; id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId, id } = await params;

    // Verify the requester is the plan owner
    const plan = await prisma.classPlan.findUnique({
      where: { id: planId },
    });

    const ownerProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (plan?.consultantProfileId !== ownerProfile?.id) {
      return NextResponse.json(
        { error: "Only the plan owner can update collaborators" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const parsed = updateClassCollaboratorSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => e.message).join(", ") },
        { status: 400 },
      );
    }

    const collab = await updateCollaborator("class", id, planId, parsed.data);
    if (!collab) {
      return NextResponse.json(
        { error: "Failed to update collaborator" },
        { status: 400 },
      );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    if (error instanceof CollaboratorTermsLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CollaboratorNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "collaborations" } },
    );
    console.error("Error updating class collaborator:", error);
    return NextResponse.json(
      { error: "Failed to update collaborator" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ planId: string; id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId, id } = await params;

    const plan = await prisma.classPlan.findUnique({
      where: { id: planId },
      select: { consultantProfileId: true },
    });

    const callerProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
      select: { id: true },
    });

    if (!plan || !callerProfile) {
      return NextResponse.json(
        {
          error:
            "Only the plan owner or the collaborator can remove this collaboration",
        },
        { status: 403 },
      );
    }

    // The owner removes any row; a collaborator may withdraw their own
    // PENDING/ACCEPTED row (#1580 C-P1-7), in which case the host is notified.
    const isOwner = plan.consultantProfileId === callerProfile.id;
    const collab = isOwner
      ? await removeCollaborator("class", id, planId)
      : await removeCollaborator("class", id, planId, {
          withdrawnByProfileId: callerProfile.id,
        });
    if (!collab) {
      return isOwner
        ? NextResponse.json(
            { error: "Failed to remove collaborator" },
            { status: 400 },
          )
        : NextResponse.json(
            {
              error:
                "Only the plan owner or the collaborator can remove this collaboration",
            },
            { status: 403 },
          );
    }

    return NextResponse.json({ data: collab });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "collaborations" } },
    );
    console.error("Error removing class collaborator:", error);
    return NextResponse.json(
      { error: "Failed to remove collaborator" },
      { status: 500 },
    );
  }
}
