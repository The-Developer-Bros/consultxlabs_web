/**
 * SCIM 2.0 `/scim/v2/Users/[id]` — GET, PATCH, DELETE.
 *
 * The `[id]` segment matches the SCIM resource id, which we model as
 * `Membership.externalScimId` (preferred) falling back to
 * `Membership.id`. The OR predicate in the resolver keeps the URL
 * stable across the lifecycle: an IdP that created the resource gets
 * its own externalScimId back; an in-app-created membership keeps the
 * Familiarise Membership.id as its SCIM identity.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireScimAuth } from "@/lib/scim/auth";
import { scimError } from "@/lib/scim/errors";
import { deprovisionScimUser } from "@/lib/scim/operations";
import { toScimUser } from "@/lib/scim/resource-user";

function baseUrlFrom(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

async function loadMembership(orgId: string, resourceId: string) {
  return prisma.membership.findFirst({
    where: {
      organizationId: orgId,
      OR: [{ externalScimId: resourceId }, { id: resourceId }],
    },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireScimAuth(req);
  if (auth.response) return auth.response;
  const { id } = await params;
  const membership = await loadMembership(auth.grant.organizationId, id);
  if (!membership) return scimError(404, "User not found");

  return NextResponse.json(
    toScimUser({
      membership,
      user: membership.user,
      groupNames: [],
      baseUrl: baseUrlFrom(req),
    }),
    { headers: { "Content-Type": "application/scim+json" } },
  );
}

/**
 * SCIM PATCH operations — minimal subset covering the IdP-common case
 * of `replace path=active value=false` (Okta's deactivate-on-soft-delete
 * pattern) plus `replace value={ ... }` whole-object updates (Azure AD's
 * "send everything every poll" style).
 *
 * Full RFC 7644 §3.5.2 PATCH is intentionally NOT implemented — `add` /
 * `remove` on arbitrary paths is rarely used by IdP providers and
 * carries a large attack surface (path injection into Prisma queries).
 * Reject unsupported operations with `400 invalidSyntax` so the IdP
 * surfaces a clear error.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireScimAuth(req);
  if (auth.response) return auth.response;
  const { id } = await params;
  const orgId = auth.grant.organizationId;

  const body = (await req.json().catch(() => null)) as
    | {
        schemas?: string[];
        Operations?: Array<{
          op?: string;
          path?: string;
          value?: unknown;
        }>;
      }
    | null;

  if (!body?.Operations?.length) {
    return scimError(400, "Operations[] is required", "invalidSyntax");
  }

  const membership = await loadMembership(orgId, id);
  if (!membership) return scimError(404, "User not found");

  // Only `active` flips are supported in v1 — see file-top comment.
  let activeOverride: boolean | undefined;
  for (const op of body.Operations) {
    if (op.op?.toLowerCase() !== "replace") {
      return scimError(
        400,
        `Unsupported op '${op.op}'. Only 'replace' is supported in v1.`,
        "invalidSyntax",
      );
    }
    if (op.path === "active") {
      if (typeof op.value !== "boolean") {
        return scimError(400, "replace active requires boolean value", "invalidValue");
      }
      activeOverride = op.value;
    } else if (
      !op.path &&
      typeof op.value === "object" &&
      op.value !== null &&
      "active" in (op.value as Record<string, unknown>)
    ) {
      // Azure-style whole-object replace — extract the active field.
      const v = (op.value as { active?: unknown }).active;
      if (typeof v === "boolean") activeOverride = v;
    }
  }

  if (activeOverride === undefined) {
    // No-op PATCH (the IdP sent operations we don't understand). Don't
    // 500 — return the current resource so the IdP doesn't loop.
    return NextResponse.json(
      toScimUser({
        membership,
        user: membership.user,
        groupNames: [],
        baseUrl: baseUrlFrom(req),
      }),
      { headers: { "Content-Type": "application/scim+json" } },
    );
  }

  const nextStatus = activeOverride ? "ACTIVE" : "SUSPENDED";
  if (membership.status !== nextStatus) {
    await prisma.membership.update({
      where: { id: membership.id },
      data: { status: nextStatus },
    });
  }
  const refreshed = await loadMembership(orgId, id);
  return NextResponse.json(
    toScimUser({
      membership: refreshed!,
      user: refreshed!.user,
      groupNames: [],
      baseUrl: baseUrlFrom(req),
    }),
    { headers: { "Content-Type": "application/scim+json" } },
  );
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireScimAuth(req);
  if (auth.response) return auth.response;
  const { id } = await params;

  const result = await deprovisionScimUser(prisma, {
    organizationId: auth.grant.organizationId,
    resourceId: id,
  });
  if ("kind" in result && result.kind === "NOT_FOUND") {
    return scimError(404, "User not found");
  }
  // RFC 7644 §3.6: a successful DELETE returns 204 No Content.
  return new NextResponse(null, { status: 204 });
}
