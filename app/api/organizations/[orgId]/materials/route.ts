/**
 * Org-scoped plan materials listing (#org-materials alignment).
 * GET /api/organizations/[orgId]/materials
 *
 * Metadata-only per ADR 20: org operators see what exists and where it sits
 * in the catalog; file bytes stay behind the participant surfaces (plan
 * owners' editor, enrolled buyers' resources page).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { resolveMaterialPlanRef } from "@/lib/plans/material-plan-ref";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) return access.error;

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }
  const { page, perPage } = parsed.data;

  const where = { organizationId: orgId };

  const [total, items] = await prisma.$transaction([
    prisma.planMaterial.count({ where }),
    prisma.planMaterial.findMany({
      where,
      select: {
        id: true,
        fileName: true,
        originalName: true,
        fileSize: true,
        mimeType: true,
        description: true,
        order: true,
        uploadedAt: true,
        // Which catalog entry the material hangs off (exactly one is set).
        consultationPlan: { select: { id: true, title: true } },
        subscriptionPlan: { select: { id: true, title: true } },
        webinarPlan: { select: { id: true, title: true } },
        classPlan: { select: { id: true, title: true } },
      },
      orderBy: { uploadedAt: "desc" },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
  ]);

  const shaped = items.map((m) => ({
    id: m.id,
    fileName: m.fileName,
    originalName: m.originalName,
    fileSize: m.fileSize,
    mimeType: m.mimeType,
    description: m.description,
    order: m.order,
    uploadedAt: m.uploadedAt,
    planRef: resolveMaterialPlanRef(m),
  }));

  return NextResponse.json({ items: shaped, total, page, perPage });
}
