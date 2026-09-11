import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { resolveMaterialPlanRef } from "@/lib/plans/material-plan-ref";
import { OrgMaterialsClient } from "./OrgMaterialsClient";

export const metadata = { title: "Materials | Organization Dashboard" };

/**
 * Org catalog materials — read-only metadata inventory (ADR 20). Management
 * happens on the owning consultant's plan editor or via the plan-materials
 * API gated on `catalog.manage`.
 */
export default async function OrgMaterialsPage({
  params,
}: {
  readonly params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "operations.read",
  });
  if (access.error) {
    // Same denial UX as the sibling org pages: bounce to the org home,
    // which renders the member-appropriate view.
    redirect(`/dashboard/organization/${orgId}/home`);
  }

  const [items, total] = await Promise.all([
    prisma.planMaterial.findMany({
      where: { organizationId: orgId },
    select: {
      id: true,
      fileName: true,
      originalName: true,
      fileSize: true,
      mimeType: true,
      description: true,
      uploadedAt: true,
      consultationPlan: { select: { id: true, title: true } },
      subscriptionPlan: { select: { id: true, title: true } },
      webinarPlan: { select: { id: true, title: true } },
      classPlan: { select: { id: true, title: true } },
    },
      orderBy: { uploadedAt: "desc" },
      take: 200,
    }),
    prisma.planMaterial.count({ where: { organizationId: orgId } }),
  ]);

  return (
    <OrgMaterialsClient
      total={total}
      items={items.map((m) => {
        const planRef = resolveMaterialPlanRef(m);
        return {
          ...m,
          planTitle: planRef?.title ?? null,
          planType: planRef?.planType ?? "CLASS",
        };
      })}
    />
  );
}
