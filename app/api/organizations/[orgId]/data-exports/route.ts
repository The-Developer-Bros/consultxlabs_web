/**
 * GET  /api/organizations/[orgId]/data-exports — list export jobs (last 30 days).
 * POST /api/organizations/[orgId]/data-exports — request a fresh export bundle.
 *
 * DPDP §11 right-to-access surface. The user can pull a JSON+CSV
 * archive of every entity scoped to their org (members, contracts,
 * programs, invoices, earnings, payouts, audit log). The worker
 * (`scripts/cleanup/process-data-exports.ts`) does the heavy lifting
 * asynchronously; this route just files the request and returns the
 * row so the dashboard can poll for status.
 *
 * Gate: OWNER + BILLING_ADMIN. Export bundles include financial PII,
 * so the same governance floor as billing-account mutations applies.
 *
 * Rate limit: 1 per 24h per org (`orgDataExportLimiter`). Building a
 * full bundle is O(N × entities); we don't want a single org pulling
 * 24 bundles in a day even if their integrators allow it.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { applyRateLimit, orgDataExportLimiter } from "@/lib/rate-limit";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
  if (access.error) return access.error;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const exports = await prisma.orgDataExportJob.findMany({
    where: { organizationId: orgId, createdAt: { gte: thirtyDaysAgo } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      requestedByMembershipId: true,
      fileSizeBytes: true,
      expiresAt: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });
  return NextResponse.json({ data: exports });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId);
  if (access.error) return access.error;

  const rl = await applyRateLimit(orgDataExportLimiter, `org:${orgId}`);
  if (rl) return rl;

  const created = await prisma.$transaction(async (tx) => {
    const job = await tx.orgDataExportJob.create({
      data: {
        organizationId: orgId,
        requestedByMembershipId: access.member.id,
        status: "PENDING",
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_REQUESTED,
        description: `Requested org data export`,
        details: { exportId: job.id },
      },
    });
    return job;
  });

  return NextResponse.json({ export: created }, { status: 202 });
}
