/**
 * GET  /api/organizations/[orgId]/scim/tokens — list ACTIVE/REVOKED tokens.
 * POST /api/organizations/[orgId]/scim/tokens — mint a new bearer token.
 *
 * OWNER-only. SCIM token CRUD is governance-sensitive (a leaked token
 * provisions arbitrary users into the org) so it stays under the
 * highest-trust gate; BILLING_ADMIN does not have access.
 *
 * The raw token is returned ONCE on POST. We persist only its SHA-256
 * hash on `ScimToken.tokenHash` (which carries a unique index), so a
 * lost token requires creating a fresh one — there's no recovery path.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CreateBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  try {
    const tokens = await prisma.scimToken.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        status: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
    });
    return NextResponse.json({ data: tokens });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "enterprise" } });
    return NextResponse.json({ error: "Failed to list SCIM tokens" }, { status: 500 });
  }
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

  // 48 bytes → 64 base64url chars. Wider than HMAC-SHA256 needs but
  // matches Okta + Azure's expected bearer-token length. The receiver
  // (us) hashes immediately; the IdP stores the raw value.
  const rawToken = randomBytes(48).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const token = await tx.scimToken.create({
        data: {
          organizationId: orgId,
          tokenHash,
          label: parsed.data.label,
          status: "ACTIVE",
          createdByMembershipId: access.member.id,
        },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_TOKEN_CREATED,
          description: `Created SCIM token '${parsed.data.label}'`,
          details: { tokenId: token.id, label: parsed.data.label },
        },
      });
      return token;
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "enterprise" } });
    return NextResponse.json({ error: "Failed to create SCIM token" }, { status: 500 });
  }

  return NextResponse.json(
    {
      token: {
        id: created.id,
        label: created.label,
        status: created.status,
        createdAt: created.createdAt,
        // ONE-TIME reveal. The dashboard wraps this in a copy-to-clipboard
        // modal with a "you won't see this again" affordance.
        rawToken,
      },
    },
    { status: 201 },
  );
}
