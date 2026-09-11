import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  handleDeleteMaterial,
  handleUpdateMaterial,
} from "@/app/api/plans/shared/materials-handler";

// Development mode check
const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

// GET - Get a single material by ID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view material",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    const { materialId } = await params;

    // Fetch material with plan relationships to verify ownership
    const material = await prisma.planMaterial.findUnique({
      where: { id: materialId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        subscriptionPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        webinarPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
        classPlan: {
          include: {
            consultantProfile: {
              select: { userId: true },
            },
          },
        },
      },
    });

    if (!material) {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }

    // Verify ownership - user must own the plan this material belongs to
    const ownerUserId =
      material.consultationPlan?.consultantProfile?.userId ||
      material.subscriptionPlan?.consultantProfile?.userId ||
      material.webinarPlan?.consultantProfile?.userId ||
      material.classPlan?.consultantProfile?.userId;

    if (!isDevelopment() && ownerUserId !== session.user.id) {
      return NextResponse.json(
        {
          error: "Access denied",
          message: "You don't have permission to view this material",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Return material without the nested plan relationships
    const {
      consultationPlan,
      subscriptionPlan,
      webinarPlan,
      classPlan,
      ...materialData
    } = material;
    return NextResponse.json({ data: materialData });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "bookings" } });
    console.error("Error fetching material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to fetch material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

// PATCH - Update material (order, description)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  const { materialId } = await params;
  return handleUpdateMaterial(request, materialId);
}

// DELETE - Delete material
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  const { materialId } = await params;
  return handleDeleteMaterial(request, materialId);
}
