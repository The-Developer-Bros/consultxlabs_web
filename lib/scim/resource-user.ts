/**
 * SCIM 2.0 User resource — local schema ↔ SCIM JSON mappers.
 *
 * Identity mapping
 * ----------------
 * - SCIM `userName` → our `User.email` (canonical identity). Most IdPs
 *   ship `userName` as the email address; some use `sub@idp.com` style.
 *   We keep it lowercased for case-insensitive uniqueness.
 * - SCIM resource `id` → `Membership.externalScimId` per org. NOT
 *   `User.id`, because the same user might be provisioned through
 *   multiple IdPs (parent + child org); each membership has its own
 *   external id space scoped by `(organizationId, externalScimId)`.
 * - SCIM `active=true|false` → `Membership.status = ACTIVE|SUSPENDED`.
 *   DELETE on a SCIM resource flips to SUSPENDED too (never to
 *   REMOVED or ERASED — those are governance-sensitive flows the
 *   org-admin owns).
 *
 * Group → role mapping
 * --------------------
 * Resolved via `ScimGroupMapping` rows. If a SCIM user is in multiple
 * mapped groups, the highest-rank role wins. If they're in zero mapped
 * groups, the membership defaults to `LEARNER` (the same JIT default
 * that domain-based auto-join uses — principle of least privilege).
 */

import type { Membership, MemberRole, User } from "@prisma/client";
import { ORG_ROLE_RANK } from "@/lib/auth/role-ranks";

export interface ScimUserResource {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"];
  id: string;
  userName: string;
  name?: { givenName?: string | null; familyName?: string | null };
  emails?: Array<{ value: string; primary?: boolean }>;
  active: boolean;
  groups?: Array<{ value: string; display?: string }>;
  meta: {
    resourceType: "User";
    created: string;
    lastModified: string;
    location: string;
  };
}

export interface ToScimInput {
  membership: Pick<
    Membership,
    "id" | "externalScimId" | "status" | "createdAt" | "updatedAt"
  >;
  user: Pick<User, "id" | "name" | "email">;
  /// Optional SCIM group names (from `ScimGroupMapping` join) that this
  /// member's role maps to. Emitted as the SCIM `groups[]` array so the
  /// IdP can render reverse-mapping in its admin UI.
  groupNames?: string[];
  /// Base URL to use when constructing the `meta.location` URI. Most
  /// SCIM clients use this for retries against the resource.
  baseUrl: string;
}

export function toScimUser(input: ToScimInput): ScimUserResource {
  const { membership, user, groupNames = [], baseUrl } = input;
  // Why we use `externalScimId ?? membership.id`: the resource id MUST
  // be stable across SCIM calls. For SCIM-created memberships we use
  // the IdP-assigned id; for in-app memberships that the IdP later
  // adopts via PATCH, the membership.id is the natural fallback until
  // the IdP assigns its own external id.
  const id = membership.externalScimId ?? membership.id;
  const name = parseDisplayName(user.name);
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    id,
    userName: user.email,
    name,
    emails: [{ value: user.email, primary: true }],
    active: membership.status === "ACTIVE",
    groups: groupNames.map((g) => ({ value: g, display: g })),
    meta: {
      resourceType: "User",
      created: membership.createdAt.toISOString(),
      lastModified: membership.updatedAt.toISOString(),
      location: `${baseUrl}/scim/v2/Users/${id}`,
    },
  };
}

/**
 * Best-effort full-name split. Most IdPs send `givenName` / `familyName`
 * separately, but the canonical `userName` is just the email and our
 * `User.name` is a single string. When we round-trip, we approximate
 * the split on the last space so "Alice Mary Doe" → { Alice Mary, Doe }.
 */
export function parseDisplayName(name: string): { givenName: string; familyName: string } {
  const trimmed = name.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace < 0) {
    return { givenName: trimmed, familyName: "" };
  }
  return {
    givenName: trimmed.slice(0, lastSpace),
    familyName: trimmed.slice(lastSpace + 1),
  };
}

/**
 * Resolve a list of SCIM group names to the highest-rank
 * `MemberRole` per the org's `ScimGroupMapping` table. Returns
 * `LEARNER` when no groups match — principle of least privilege.
 *
 * Why we read the mapping table outside this helper: the auth path
 * (lib/scim/auth.ts) already has a Prisma client in scope; passing
 * the pre-fetched mappings in keeps the helper pure + testable.
 */
export function resolveRoleFromGroupNames(
  groupNames: string[],
  mappings: Array<{ scimGroupName: string; role: MemberRole }>,
): MemberRole {
  const lookup = new Map(mappings.map((m) => [m.scimGroupName, m.role]));
  let bestRole: MemberRole = "LEARNER";
  let bestRank = ORG_ROLE_RANK.LEARNER;
  for (const name of groupNames) {
    const role = lookup.get(name);
    if (!role) continue;
    const rank = ORG_ROLE_RANK[role];
    if (rank > bestRank) {
      bestRank = rank;
      bestRole = role;
    }
  }
  return bestRole;
}
