import prisma from "@/lib/prisma";

/**
 * Latest audit-log rows for an org's home activity feed.
 *
 * Shape/order mirrors GET /api/organizations/[orgId]/activity (createdAt
 * desc) so the SSR-seeded ["org-activity", orgId] cache hydrates into
 * exactly what the client fetch would have returned — the home tab renders
 * without its previous post-hydration second waterfall. The API route keeps
 * its own richer filter/cursor implementation; only the feed window is
 * shared semantics.
 */
export async function getOrgActivityFeed(orgId: string, limit = 5) {
  return prisma.orgAuditLog.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
