import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  uploadPlanMaterial,
  deletePlanMaterial,
  type PlanType,
} from "@/lib/supabase";

// Type definitions
export interface PlanMaterialsConfig {
  planType: PlanType;
  planIdField: string;
  planModel:
    | "consultationPlan"
    | "subscriptionPlan"
    | "webinarPlan"
    | "classPlan";
}

// Development mode check
const isDevelopment = () =>
  process.env.NODE_ENV === "development" &&
  process.env.DEV_BYPASS_AUTH === "true";

/**
 * Verify the user may manage this plan's materials. Two paths:
 *   1. the owning consultant (personal plans), or
 *   2. an org member with `catalog.manage` over the plan's organization —
 *      org-owned plans were previously owner-only, which locked org
 *      operators out of their own catalog (#org-materials alignment).
 *
 * Returns the plan's organizationId so uploads can mirror the denormalized
 * `PlanMaterial.organizationId` tag.
 */
async function verifyMaterialManageAccess(
  userId: string,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<{ allowed: boolean; organizationId: string | null; error?: string }> {
  if (isDevelopment()) {
    return { allowed: true, organizationId: null };
  }

  try {
    const select = {
      consultantProfile: { select: { userId: true } },
      organizationId: true,
    } as const;

    let plan: {
      consultantProfile: { userId: string } | null;
      organizationId: string | null;
    } | null = null;

    switch (config.planModel) {
      case "consultationPlan":
        plan = await prisma.consultationPlan.findFirst({
          where: { id: planId },
          select,
        });
        break;
      case "subscriptionPlan":
        plan = await prisma.subscriptionPlan.findFirst({
          where: { id: planId },
          select,
        });
        break;
      case "webinarPlan":
        plan = await prisma.webinarPlan.findFirst({
          where: { id: planId },
          select,
        });
        break;
      case "classPlan":
        plan = await prisma.classPlan.findFirst({
          where: { id: planId },
          select,
        });
        break;
    }

    if (!plan?.consultantProfile) {
      return {
        allowed: false,
        organizationId: null,
        error: "Plan not found",
      };
    }

    if (plan.consultantProfile?.userId === userId) {
      return { allowed: true, organizationId: plan.organizationId };
    }

    if (plan.organizationId) {
      const access = await requireOrgAccess(plan.organizationId, {
        permission: "catalog.manage",
      });
      if (!access.error) {
        return { allowed: true, organizationId: plan.organizationId };
      }
    }

    return {
      allowed: false,
      organizationId: plan.organizationId,
      error: "You don't have permission to manage this plan's materials",
    };
  } catch (error) {
    console.error("Error verifying material access:", error);
    return { allowed: false, organizationId: null, error: "Failed to verify access" };
  }
}

/** Row-level variant for delete/update: resolves via the material's plan FKs. */
async function resolveMaterialRowAccess(
  userId: string,
  materialId: string,
): Promise<
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "allowed"; storagePath: string; organizationId: string | null }
> {
  const material = await prisma.planMaterial.findUnique({
    where: { id: materialId },
    select: {
      storagePath: true,
      consultationPlan: {
        select: {
          consultantProfile: { select: { userId: true } },
          organizationId: true,
        },
      },
      subscriptionPlan: {
        select: {
          consultantProfile: { select: { userId: true } },
          organizationId: true,
        },
      },
      webinarPlan: {
        select: {
          consultantProfile: { select: { userId: true } },
          organizationId: true,
        },
      },
      classPlan: {
        select: {
          consultantProfile: { select: { userId: true } },
          organizationId: true,
        },
      },
    },
  });
  if (!material) return { status: "not_found" };

  const plan =
    material.consultationPlan ??
    material.subscriptionPlan ??
    material.webinarPlan ??
    material.classPlan;
  if (!plan) return { status: "not_found" };

  if (isDevelopment() || plan.consultantProfile?.userId === userId) {
    return {
      status: "allowed",
      storagePath: material.storagePath,
      organizationId: plan.organizationId,
    };
  }

  if (plan.organizationId) {
    const access = await requireOrgAccess(plan.organizationId, {
      permission: "catalog.manage",
    });
    if (!access.error) {
      return {
        status: "allowed",
        storagePath: material.storagePath,
        organizationId: plan.organizationId,
      };
    }
  }
  return { status: "denied" };
}

/**
 * GET - List materials for a plan
 */
export async function handleGetMaterials(
  request: NextRequest,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Verify manage access (owner consultant or org catalog.manage)
    const { allowed, error } = await verifyMaterialManageAccess(
      session.user.id,
      planId,
      config,
    );
    if (!allowed) {
      return NextResponse.json(
        {
          error: "Access denied",
          message: error || "You don't have permission to view these materials",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Fetch materials
    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };

    const materials = await prisma.planMaterial.findMany({
      where: whereClause,
      orderBy: { order: "asc" },
    });

    return NextResponse.json({ data: materials });
  } catch (error) {
    console.error("Error fetching materials:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to fetch materials",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

/**
 * POST - Upload a new material
 */
export async function handleUploadMaterial(
  request: NextRequest,
  planId: string,
  config: PlanMaterialsConfig,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to upload materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Verify manage access (owner consultant or org catalog.manage)
    const { allowed, organizationId, error } = await verifyMaterialManageAccess(
      session.user.id,
      planId,
      config,
    );
    if (!allowed) {
      return NextResponse.json(
        {
          error: "Access denied",
          message:
            error ||
            "You don't have permission to upload materials to this plan",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const description = formData.get("description") as string | null;

    if (!file) {
      return NextResponse.json(
        {
          error: "No file provided",
          message: "Please select a file to upload",
          code: "INVALID_INPUT",
        },
        { status: 400 },
      );
    }

    // Upload to Supabase
    const uploadResult = await uploadPlanMaterial({
      planType: config.planType,
      planId,
      file,
      description: description || undefined,
    });

    if (!uploadResult.success) {
      return NextResponse.json(
        {
          error: "Upload failed",
          message: uploadResult.error || "Failed to upload file",
          code: "UPLOAD_ERROR",
        },
        { status: 500 },
      );
    }

    // Get the current max order for this plan
    const whereClause: Prisma.PlanMaterialWhereInput = {
      [config.planIdField]: planId,
    };

    const maxOrderResult = await prisma.planMaterial.aggregate({
      where: whereClause,
      _max: { order: true },
    });
    const nextOrder = (maxOrderResult._max.order ?? -1) + 1;

    // Create database record — mirror the plan's org tag so org dashboards
    // can scope materials without polymorphic joins.
    const createData = {
      fileName: uploadResult.fileName!,
      originalName: file.name,
      fileSize: uploadResult.fileSize!,
      mimeType: uploadResult.mimeType!,
      fileUrl: uploadResult.fileUrl!,
      storagePath: uploadResult.storagePath!,
      description: description || null,
      order: nextOrder,
      organizationId,
      [config.planIdField]: planId,
    };

    const material = await prisma.planMaterial.create({
      data: createData as Prisma.PlanMaterialUncheckedCreateInput,
    });

    return NextResponse.json({ data: material }, { status: 201 });
  } catch (error) {
    console.error("Error uploading material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to upload material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE - Delete a material by ID
 */
export async function handleDeleteMaterial(
  request: NextRequest,
  materialId: string,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to delete materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Find the material and verify manage access (owner or org catalog.manage)
    const access = await resolveMaterialRowAccess(session.user.id, materialId);
    if (access.status === "not_found") {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (access.status === "denied") {
      return NextResponse.json(
        {
          error: "Access denied",
          message: "You don't have permission to delete this material",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // Delete from Supabase storage
    await deletePlanMaterial(access.storagePath);

    // Delete from database
    await prisma.planMaterial.delete({
      where: { id: materialId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to delete material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}

/**
 * PATCH - Update material order or description
 */
export async function handleUpdateMaterial(
  request: NextRequest,
  materialId: string,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to update materials",
          code: "UNAUTHORIZED",
        },
        { status: 401 },
      );
    }

    // Find the material and verify manage access (owner or org catalog.manage)
    const access = await resolveMaterialRowAccess(session.user.id, materialId);
    if (access.status === "not_found") {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 },
      );
    }
    if (access.status === "denied") {
      return NextResponse.json(
        {
          error: "Access denied",
          message: "You don't have permission to update this material",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { order, description } = body as {
      order?: number;
      description?: string;
    };

    const updateData: Prisma.PlanMaterialUpdateInput = {};
    if (typeof order === "number") {
      updateData.order = order;
    }
    if (typeof description === "string") {
      updateData.description = description || null;
    }

    const updatedMaterial = await prisma.planMaterial.update({
      where: { id: materialId },
      data: updateData,
    });

    return NextResponse.json({ data: updatedMaterial });
  } catch (error) {
    console.error("Error updating material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to update material",
        code: "SERVER_ERROR",
      },
      { status: 500 },
    );
  }
}
