/**
 * SCIM 2.0 bearer-token authentication.
 *
 * The IdP authenticates by sending `Authorization: Bearer <raw token>`.
 * We never store the raw token — only its SHA-256 hash on `ScimToken`.
 * Authentication is therefore a hash-and-lookup. The token's
 * organizationId becomes the implicit tenant for every downstream SCIM
 * operation, so no separate `?orgId=` query is needed (or allowed —
 * accepting one would risk an IdP cross-tenant data leak).
 *
 * The function also enforces `scimLimiter` so a runaway IdP can't burn
 * our Postgres connection pool.
 */

import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { applyRateLimit, scimLimiter } from "@/lib/rate-limit";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { scimError } from "./errors";

export interface ScimAuthGrant {
  organizationId: string;
  tokenId: string;
}

/**
 * Returns `{ grant }` on success or `{ response }` on failure where
 * `response` is the SCIM-shaped error to return directly. The caller's
 * route handler should `if (auth.response) return auth.response;`
 * and then use `auth.grant.organizationId` for every subsequent query.
 */
export async function requireScimAuth(
  req: NextRequest,
): Promise<{ grant: ScimAuthGrant; response?: never } | { response: ReturnType<typeof scimError>; grant?: never }> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return { response: scimError(401, "Missing or malformed Authorization header") };
  }
  const rawToken = header.slice(7).trim();
  if (!rawToken) {
    return { response: scimError(401, "Empty bearer token") };
  }
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const token = await prisma.scimToken.findUnique({
    where: { tokenHash },
    select: { id: true, organizationId: true, status: true, expiresAt: true },
  });
  if (!token) {
    return { response: scimError(401, "Unknown bearer token") };
  }
  // #789 — enforce the absolute deadline the schema already records. An ACTIVE
  // token past its expiresAt must stop authenticating; the row stays ACTIVE so
  // the operator can see it lapsed rather than having been revoked.
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    return { response: scimError(401, "Token has expired") };
  }
  if (token.status !== "ACTIVE") {
    // Why we audit the misuse: a REVOKED token still in IdP config is
    // valuable signal — the operator may not realize the rotation
    // never propagated. Logging the attempt makes that visible without
    // forcing them to grep worker logs.
    await prisma.orgAuditLog
      .create({
        data: {
          organizationId: token.organizationId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.SCIM_TOKEN_USED_AFTER_REVOKE,
          description: `Revoked SCIM token ${token.id} attempted to authenticate`,
          details: { tokenId: token.id },
        },
      })
      .catch(() => {
        // Audit failure must not block the 401 response — log + swallow.
      });
    return { response: scimError(401, "Token has been revoked") };
  }

  const rl = await applyRateLimit(scimLimiter, `scim:${tokenHash}`);
  if (rl) {
    return { response: scimError(429, "SCIM rate limit exceeded; retry shortly") };
  }

  // Best-effort lastUsedAt bump. Don't block the request on it — if the
  // update fails (transient DB issue) we'd rather serve the SCIM call
  // and lose the timestamp than 5xx the IdP.
  prisma.scimToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return { grant: { organizationId: token.organizationId, tokenId: token.id } };
}
