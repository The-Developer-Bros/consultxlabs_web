import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const resolvedParams = await params;
    const { id } = resolvedParams;

    // Check authorization: privileged users can access any, others only their own
    const canAccess =
      isPrivileged(session.user.role) ||
      checkOwnership(session, id, "consultee");

    if (!canAccess) {
      return forbiddenResponse(
        "You can only access your own consultee profile",
      );
    }

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
      include: {
        user: {
          include: {
            workExperiences: {
              orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
            },
            education: { orderBy: { endYear: "desc" } },
          },
        },
      },
    });

    if (!consultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: consultee }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    if (error instanceof Error) {
      console.error("Error: ", error.stack);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get consultee profile",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const resolvedParams = await params;
    const { id } = resolvedParams;

    // Check authorization: privileged users can create for any user, others only for themselves
    const canCreate = isPrivileged(session.user.role) || session.user.id === id;

    if (!canCreate) {
      return forbiddenResponse(
        "You can only create a consultee profile for yourself",
      );
    }

    const body = await req.json();
    const user = await prisma.user.findUnique({
      where: { id: id },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found. Cannot create consultee profile." },
        { status: 404 },
      );
    }

    const createdConsultee = await prisma.consulteeProfile.create({
      data: {
        aboutMe: body.aboutMe,
        preferredLanguage: body.preferredLanguage,
        goals: body.goals,
        careerStage: body.careerStage,
        skillsToDevelop: body.skillsToDevelop ?? [],
        budgetPreference: body.budgetPreference,
        user: { connect: { id: id } },
      },
      include: {
        consultantReviews: { where: { deletedAt: null } },
        user: true,
      },
    });

    return NextResponse.json(createdConsultee, { status: 201 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    console.error("Error creating consultee:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while creating the consultee profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const resolvedParams = await params;
    const { id } = resolvedParams;

    // Check authorization: privileged users can update any, others only their own
    const canUpdate =
      isPrivileged(session.user.role) ||
      checkOwnership(session, id, "consultee");

    if (!canUpdate) {
      return forbiddenResponse(
        "You can only update your own consultee profile",
      );
    }

    const body = await req.json();

    const existingConsultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
    });

    if (!existingConsultee) {
      return NextResponse.json(
        { error: "Consultee profile not found for updating" },
        { status: 404 },
      );
    }

    const updatedConsultee = await prisma.consulteeProfile.update({
      where: { id: id },
      data: {
        aboutMe: body.aboutMe,
        preferredLanguage: body.preferredLanguage,
        goals: body.goals,
        careerStage: body.careerStage,
        skillsToDevelop: body.skillsToDevelop ?? [],
        budgetPreference: body.budgetPreference,
      },
      include: {
        consultantReviews: { where: { deletedAt: null } },
        user: true,
      },
    });

    return NextResponse.json(updatedConsultee, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    console.error("Error updating consultee:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while updating the consultee profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const resolvedParams = await params;
    const { id } = resolvedParams;

    // Check authorization: privileged users can delete any, others only their own
    const canDelete =
      isPrivileged(session.user.role) ||
      checkOwnership(session, id, "consultee");

    if (!canDelete) {
      return forbiddenResponse(
        "You can only delete your own consultee profile",
      );
    }

    const existingConsultee = await prisma.consulteeProfile.findUnique({
      where: { id: id },
    });

    if (!existingConsultee) {
      return NextResponse.json(
        { error: "Consultee profile not found for deletion" },
        { status: 404 },
      );
    }

    const deletedConsultee = await prisma.consulteeProfile.delete({
      where: { id: id },
      include: {
        consultantReviews: { where: { deletedAt: null } },
        user: true,
      },
    });

    return NextResponse.json(deletedConsultee, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "user" } },
    );
    console.error("Error deleting consultee:", error);
    return NextResponse.json(
      {
        error:
          "An unexpected error occurred while deleting the consultee profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
