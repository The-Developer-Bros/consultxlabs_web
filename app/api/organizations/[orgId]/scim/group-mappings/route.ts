/**
 * GET  /api/organizations/[orgId]/scim/group-mappings
 * POST /api/organizations/[orgId]/scim/group-mappings
 *
 * Per-org mapping from IdP group names (e.g. `IT-Admins`,
 * `Engineering-Leads`) to local `MemberRole` values. The SCIM user
 * upsert at `lib/scim/operations.ts` reads from this table to resolve
 * the right role per SCIM-pushed user.
 *
 * OWNER-only — same governance reasoning as token CRUD.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { MemberRoleSchema } from "@/lib/labels/org-labels";

const CreateBodySchema = z.object({
  scimGroupName: z.string().trim().min(1).max(255),
  role: MemberRoleSchema,
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const mappings = await prisma.scimGroupMapping.findMany({
    where: { organizationId: orgId },
    orderBy: { scimGroupName: "asc" },
  });
  return NextResponse.json({ data: mappings });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const mapping = await tx.scimGroupMapping.create({
        data: {
          organizationId: orgId,
          scimGroupName: parsed.data.scimGroupName,
          role: parsed.data.role,
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_GROUP_MAPPED,
          description: `Mapped SCIM group '${parsed.data.scimGroupName}' to ${parsed.data.role}`,
          details: parsed.data,
        },
      });
      return mapping;
    });
    return NextResponse.json({ mapping: created }, { status: 201 });
  } catch (err) {
    // P2002 unique-constraint hit — the org already has this group name
    // mapped. Surface a friendly 409 instead of leaking the Prisma error.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: `Group '${parsed.data.scimGroupName}' is already mapped`, code: "SCIM_GROUP_DUPLICATE" },
        { status: 409 },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    throw err;
  }
}
