/**
 * POST   /api/organizations/[orgId]/sso/break-glass
 * DELETE /api/organizations/[orgId]/sso/break-glass
 *
 * #779 §E — time-boxed IdP-outage escape hatch. When SSO is enforced and
 * the org's IdP is down, an OWNER opens a window during which password
 * login is permitted again for the claimed domain (the auth layer skips
 * the enforceSSO gate while `breakGlassUntil > now` — see
 * lib/sso/enforce-session.ts). DELETE closes the window early.
 *
 * Who/why is not stored on columns — it lives in the OrgAuditLog row this
 * route emits.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PostBodySchema = z.object({
  hours: z.number().int().min(1).max(72).default(4),
  reason: z.string().min(5),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { hours, reason } = parsed.data;

  const settings = await prisma.organizationSSOSettings.findUnique({
    where: { organizationId: orgId },
    select: { enforceSSO: true },
  });
  // #779 §E — nothing to break if SSO isn't enforced here.
  if (!settings?.enforceSSO) {
    return NextResponse.json(
      { error: "SSO is not enforced for this organization" },
      { status: 404 },
    );
  }

  const until = new Date(Date.now() + hours * 60 * 60 * 1000);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.organizationSSOSettings.update({
      where: { organizationId: orgId },
      data: { breakGlassUntil: until },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
        description: "SSO break-glass opened",
        details: { reason, hours, until: until.toISOString() },
      },
    });
    return next;
  });

  return NextResponse.json({ breakGlassUntil: updated.breakGlassUntil });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const settings = await prisma.organizationSSOSettings.findUnique({
    where: { organizationId: orgId },
    select: { enforceSSO: true },
  });
  // #779 §E — nothing to clear if SSO isn't enforced here.
  if (!settings?.enforceSSO) {
    return NextResponse.json(
      { error: "SSO is not enforced for this organization" },
      { status: 404 },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.organizationSSOSettings.update({
      where: { organizationId: orgId },
      data: { breakGlassUntil: null },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
        description: "SSO break-glass closed",
        details: {},
      },
    });
  });

  return NextResponse.json({ breakGlassUntil: null });
}
